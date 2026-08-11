import { describe, expect, test } from "bun:test";
import { assessHost, type HostSnapshot, type ProcessRecord } from "./host-health.ts";
import { buildHostReport } from "./host-report.ts";

const processRecord = (overrides: Partial<ProcessRecord>): ProcessRecord => ({
  pid: 100,
  ppid: 1,
  pgid: 100,
  sid: 100,
  uid: 1000,
  startTime: "1000",
  state: "S",
  ageSeconds: 300,
  tasks: 1,
  comm: "node",
  argv: ["node", "/home/dev/.cache/red-skills/bundles/dev-3.12.13.bundle.min.mjs", "statusline"],
  cwd: "/home/dev/workspace/project",
  cwdDeleted: false,
  tty: null,
  unit: null,
  cgroup: "/user.slice/app.slice/app.scope",
  reparented: true,
  externalStdioPeers: [],
  stdioObservationKnown: true,
  stdioPeerLinkKnown: true,
  ...overrides,
});

const snapshot = (processes: ProcessRecord[]): HostSnapshot => ({
  capturedAt: "2026-08-11T12:00:00.000Z",
  currentPid: 900,
  currentUid: 1000,
  processes,
  workers: [],
  workerStateKnown: true,
  activeUnits: [],
  activeUnitsKnown: true,
  stdioUniverseKnown: true,
  processUniverseKnown: true,
  redskilledPid: null,
  metrics: {
    processCount: processes.length,
    taskCount: processes.length,
    pidsCurrent: 100,
    pidsMax: 59_019,
    memoryAvailableBytes: 18 * 1024 ** 3,
    memoryTotalBytes: 32 * 1024 ** 3,
    diskFreeBytes: 100 * 1024 ** 3,
    diskTotalBytes: 500 * 1024 ** 3,
    oomEvents: [],
    stopTimeouts: 0,
    workerLimitsKnown: true,
    workerTasksMax: [],
    workerMemoryCurrent: [],
    workerMemoryMax: [],
  },
});

describe("host rescue classification", () => {
  test("a reparented statusline with no terminal or outside stdio owner is proven orphaned", () => {
    const assessment = assessHost(snapshot([processRecord({})]));

    expect(assessment.groups).toEqual([
      {
        pgid: 100,
        pids: [100],
        disposition: "proven-orphan",
        reasons: ["known statusline", "reparented", "no terminal", "no external stdio owner"],
      },
    ]);
  });

  test("a statusline inside a registered Worker is protected", () => {
    const input = snapshot([processRecord({ pid: 201, pgid: 200, unit: "red-worker-live.service" })]);
    input.workers = [{ pid: 200, unit: "red-worker-live.service" }];
    input.activeUnits = ["red-worker-live.service"];

    expect(assessHost(input).groups[0]).toEqual({
      pgid: 200,
      pids: [201],
      disposition: "protected",
      reasons: ["registered Worker"],
    });
  });

  test("a process name without abandonment evidence is only suspect", () => {
    const active = processRecord({
      pid: 301,
      pgid: 300,
      reparented: false,
      externalStdioPeers: [299],
    });

    expect(assessHost(snapshot([active])).groups[0]?.disposition).toBe("suspect");
  });

  test("unknown stdio ownership is never treated as proof of abandonment", () => {
    const assessment = assessHost(snapshot([
      processRecord({ stdioObservationKnown: false }),
    ]));

    expect(assessment.groups[0]).toMatchObject({ disposition: "suspect" });
    expect(assessment.groups[0]?.reasons).not.toContain("no external stdio owner");

    const socketPair = assessHost(snapshot([
      processRecord({ stdioPeerLinkKnown: false }),
    ]));
    expect(socketPair.groups[0]).toMatchObject({ disposition: "suspect" });
    expect(socketPair.groups[0]?.reasons).not.toContain("no external stdio owner");

    const outsideUnknown = snapshot([processRecord({})]);
    outsideUnknown.stdioUniverseKnown = false;
    expect(assessHost(outsideUnknown).groups[0]).toMatchObject({ disposition: "suspect" });
  });

  test("a group attached to a terminal is protected", () => {
    const active = processRecord({ pid: 351, pgid: 350, tty: "/dev/pts/4" });

    expect(assessHost(snapshot([active])).groups[0]).toEqual({
      pgid: 350,
      pids: [351],
      disposition: "protected",
      reasons: ["active terminal"],
    });
  });

  test("the running red-dev process and its ancestry are protected", () => {
    const shell = processRecord({ pid: 390, ppid: 1, pgid: 390, argv: ["sh"] });
    const current = processRecord({ pid: 391, ppid: 390, pgid: 390 });
    const input = snapshot([shell, current]);
    input.currentPid = 391;

    expect(assessHost(input).groups[0]).toEqual({
      pgid: 390,
      pids: [390, 391],
      disposition: "protected",
      reasons: ["current command ancestry"],
    });
  });

  test("a descendant of redskilled is protected even without a terminal", () => {
    const daemon = processRecord({
      pid: 360,
      ppid: 1,
      pgid: 360,
      comm: "redskilled",
      argv: ["node", "redskilled", "daemon"],
    });
    const child = processRecord({ pid: 361, ppid: 360, pgid: 361, reparented: false });
    const input = snapshot([daemon, child]);
    input.redskilledPid = 360;

    expect(assessHost(input).groups[0]).toEqual({
      pgid: 361,
      pids: [361],
      disposition: "protected",
      reasons: ["redskilled descendant"],
    });
  });

  test("an active systemd unit is protected even when the daemon cannot describe it", () => {
    const process = processRecord({ pid: 371, pgid: 370, unit: "red-worker-live.service" });
    const input = snapshot([process]);
    input.activeUnits = ["red-worker-live.service"];

    expect(assessHost(input).groups[0]?.disposition).toBe("protected");
    expect(assessHost(input).groups[0]?.reasons).toEqual(["active systemd unit"]);
  });

  test("unknown systemd unit state makes every candidate non-actionable", () => {
    const input = snapshot([processRecord({})]);
    input.activeUnitsKnown = false;

    expect(assessHost(input).groups[0]).toMatchObject({
      disposition: "protected",
      reasons: ["systemd unit state unknown"],
    });
  });

  test("a process group containing another or unknown UID is never proven orphaned", () => {
    const input = snapshot([
      processRecord({ pid: 101, pgid: 100 }),
      processRecord({ pid: 102, pgid: 100, uid: 0, argv: ["helper"] }),
    ]);

    expect(assessHost(input).groups[0]).toMatchObject({ disposition: "suspect", pids: [101, 102] });

    input.processes[1]!.uid = null;
    expect(assessHost(input).groups[0]).toMatchObject({ disposition: "suspect", pids: [101, 102] });
  });

  test("an inactive Worker-shaped group is protected when daemon state is unknown", () => {
    const process = processRecord({
      pid: 381,
      pgid: 380,
      argv: ["claude", "--dangerously-skip-permissions"],
      unit: "red-worker-unknown.service",
      cwdDeleted: true,
    });
    const input = snapshot([process]);
    input.workerStateKnown = false;

    expect(assessHost(input).groups[0]).toEqual({
      pgid: 380,
      pids: [381],
      disposition: "protected",
      reasons: ["Worker state unknown"],
    });
  });

  test("a test dispatcher whose worktree and runner disappeared is proven orphaned", () => {
    const dispatcher = processRecord({
      pid: 401,
      pgid: 400,
      comm: "node",
      argv: ["node", "/workspace/red-skills/apps/dev/tests/support/go-dispatch-dispatcher.ts"],
      cwd: "/workspace/red-skills/.red/tmp/worktrees/manual/fix/apps/dev",
      cwdDeleted: true,
    });
    const esbuild = processRecord({
      pid: 402,
      ppid: 401,
      pgid: 400,
      comm: "esbuild",
      argv: ["/workspace/node_modules/@esbuild/linux-x64/bin/esbuild", "--service=0.28.1"],
      cwd: dispatcher.cwd,
      cwdDeleted: true,
      reparented: false,
    });

    expect(assessHost(snapshot([dispatcher, esbuild])).groups[0]).toEqual({
      pgid: 400,
      pids: [401, 402],
      disposition: "proven-orphan",
      reasons: ["known test helper", "deleted cwd", "reparented", "no terminal"],
    });
    expect(assessHost(snapshot([dispatcher, esbuild])).findings).toContainEqual({
      id: "orphan-groups",
      level: "warning",
      detail: "1 proven orphan group(s), 2 process(es)",
    });
  });
});

describe("host pressure", () => {
  test("five thousand user processes is critical", () => {
    const input = snapshot([]);
    input.metrics.processCount = 5_000;

    expect(assessHost(input)).toMatchObject({
      level: "critical",
      findings: [{ id: "process-count", level: "critical", detail: "5,000 processes" }],
    });
  });

  test("tasks, pid capacity, memory, disk, OOM and Worker limits use the P0 thresholds", () => {
    const input = snapshot([]);
    input.metrics.taskCount = 4_000;
    input.metrics.pidsCurrent = 30_000;
    input.metrics.pidsMax = 59_019;
    input.metrics.memoryAvailableBytes = 4 * 1024 ** 3;
    input.metrics.memoryTotalBytes = 32 * 1024 ** 3;
    input.metrics.diskFreeBytes = 19 * 1024 ** 3;
    input.metrics.diskTotalBytes = 100 * 1024 ** 3;
    input.metrics.oomEvents = ["2026-08-11T11:30:00.000Z"];
    input.metrics.stopTimeouts = 1;
    input.metrics.workerTasksMax = [2_049, "infinity"];

    const findings = assessHost(input).findings;
    expect(findings.map(({ id, level }) => [id, level])).toEqual([
      ["task-count", "warning"],
      ["pid-capacity", "warning"],
      ["memory", "warning"],
      ["disk", "warning"],
      ["oom", "critical"],
      ["stop-timeout", "warning"],
      ["worker-tasks-max", "critical"],
    ]);
  });

  test("the doctor report turns host findings and an unbounded statusline into failures", () => {
    const input = snapshot([]);
    input.metrics.processCount = 5_000;

    const report = buildHostReport(input, {
      legacyConfig: true,
      bundle: "/cache/dev.bundle.mjs",
      bounded: false,
      groupGone: true,
    });

    expect(report.problems).toBe(3);
    expect(report.rows.map((row) => row.kind)).toEqual(["error", "error", "error"]);
  });

  test("zombies, deleted working directories and unbounded Worker memory are visible", () => {
    const input = snapshot([
      processRecord({ pid: 701, pgid: 701, state: "Z", argv: ["sleep"] }),
      processRecord({ pid: 702, pgid: 702, cwdDeleted: true, argv: ["python"] }),
    ]);
    input.metrics.workerMemoryMax = ["infinity"];

    expect(assessHost(input).findings.map(({ id, level }) => [id, level])).toEqual([
      ["zombies", "warning"],
      ["deleted-cwd", "warning"],
      ["worker-memory-max", "critical"],
    ]);
  });

  test("unknown Worker isolation is reported rather than treated as healthy", () => {
    const input = snapshot([]);
    input.metrics.workerLimitsKnown = false;

    expect(assessHost(input).findings).toContainEqual({
      id: "worker-limits",
      level: "warning",
      detail: "Worker TasksMax/MemoryCurrent/MemoryMax observation is unknown",
    });
  });
});
