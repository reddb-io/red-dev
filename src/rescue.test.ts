import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import type { HostSnapshot, ProcessRecord } from "./host-health.ts";
import {
  applyRescue,
  planRescue,
  rescueTargetAlive,
  rescueTargetStillExact,
  signalProcessGroup,
  writeIncidentSnapshot,
} from "./rescue.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function currentUserBaseline(): { processes: number; tasks: number } {
  let processes = 0;
  let tasks = 0;
  const uid = process.getuid?.();
  for (const entry of readdirSync("/proc").filter((value) => /^\d+$/.test(value))) {
    try {
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      if (Number.parseInt(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? "", 10) !== uid) continue;
      processes++;
      tasks += readdirSync(`/proc/${entry}/task`).filter((value) => /^\d+$/.test(value)).length;
    } catch {
      // A process that exited during the census belongs to neither stable baseline.
    }
  }
  return { processes, tasks };
}

const processRecord = (over: Partial<ProcessRecord>): ProcessRecord => ({
  pid: 100,
  ppid: 1,
  pgid: 100,
  sid: 100,
  uid: 1000,
  startTime: "12345",
  state: "S",
  ageSeconds: 300,
  tasks: 1,
  comm: "node",
  argv: ["node", "/cache/red-skills/bundles/dev-3.12.13.bundle.min.mjs", "statusline", "secret prompt"],
  cwd: "/home/dev/private/project",
  cwdDeleted: false,
  tty: null,
  unit: null,
  cgroup: "/user.slice/app.slice/statusline.scope",
  reparented: true,
  externalStdioPeers: [],
  stdioObservationKnown: true,
  stdioPeerLinkKnown: true,
  ...over,
});

const snapshot = (processes: ProcessRecord[]): HostSnapshot => ({
  capturedAt: "2026-08-11T15:00:00.000Z",
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
    memoryAvailableBytes: null,
    memoryTotalBytes: null,
    diskFreeBytes: null,
    diskTotalBytes: null,
    oomEvents: [],
    stopTimeouts: 0,
    workerLimitsKnown: true,
    workerTasksMax: [],
    workerMemoryCurrent: [],
    workerMemoryMax: [],
  },
});

describe("Host Rescue", () => {
  test("the plan contains only proven orphan groups and their PID fingerprints", () => {
    const orphan = processRecord({ pid: 101, pgid: 100 });
    const suspect = processRecord({
      pid: 201,
      pgid: 200,
      reparented: false,
      externalStdioPeers: [999],
    });

    expect(planRescue(snapshot([orphan, suspect]))).toEqual({
      capturedAt: "2026-08-11T15:00:00.000Z",
      targets: [{ pgid: 100, uid: 1000, unit: null, processes: [{ pid: 101, startTime: "12345" }] }],
    });
  });

  test("the mandatory snapshot is private and redacts arbitrary arguments", () => {
    const root = mkdtempSync(`${tmpdir()}/red-dev-incidents-`);
    roots.push(root);
    const input = snapshot([
      processRecord({
        pid: 101,
        argv: [
          "node",
          "/cache/red-skills/bundles/dev-3.12.13.bundle.min.mjs",
          "statusline",
          "secret prompt",
          "red-skills-token=secret",
        ],
      }),
    ]);
    const path = writeIncidentSnapshot(input, planRescue(input), root, "before");
    const stored = readFileSync(path, "utf8");

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(stored).toContain("statusline");
    expect(stored).not.toContain("secret prompt");
    expect(stored).not.toContain("red-skills-token=secret");
  });

  test("apply revalidates PID start-times before sending any signal", async () => {
    const root = mkdtempSync(`${tmpdir()}/red-dev-incidents-`);
    roots.push(root);
    const before = snapshot([processRecord({ pid: 101 })]);
    const reused = snapshot([processRecord({ pid: 101, startTime: "99999" })]);
    const signals: string[] = [];

    const result = await applyRescue(before, planRescue(before), {
      incidentRoot: root,
      refresh: async () => reused,
      signalGroup: (_pgid, signal) => signals.push(signal),
      wait: async () => undefined,
    });

    expect(signals).toEqual([]);
    expect(result.skipped).toEqual([
      { pgid: 100, reason: "process identity or protection changed" },
    ]);
  });

  test("group verification sees a descendant created after the plan", () => {
    const root = mkdtempSync(`${tmpdir()}/red-dev-proc-`);
    roots.push(root);
    mkdirSync(`${root}/202`, { recursive: true });
    const fields = [
      "S", "1", "100", "100", "0", "0", "0", "0", "0", "0", "0", "0", "0",
      "0", "0", "0", "0", "0", "1", "99999",
    ];
    writeFileSync(`${root}/202/stat`, `202 (late-child) ${fields.join(" ")}\n`);

    expect(rescueTargetAlive({
      pgid: 100,
      uid: 1000,
      unit: null,
      processes: [{ pid: 101, startTime: "12345" }],
    }, root)).toBe(true);
  });

  test("last-moment verification refuses a group member whose UID became unreadable", () => {
    const root = mkdtempSync(`${tmpdir()}/red-dev-proc-uid-`);
    roots.push(root);
    mkdirSync(`${root}/101`, { recursive: true });
    const fields = [
      "S", "1", "100", "100", "0", "0", "0", "0", "0", "0", "0", "0", "0",
      "0", "0", "0", "0", "0", "1", "12345",
    ];
    writeFileSync(`${root}/101/stat`, `101 (member) ${fields.join(" ")}\n`);
    const target = {
      pgid: 100,
      uid: 1000,
      unit: null,
      processes: [{ pid: 101, startTime: "12345" }],
    };

    expect(rescueTargetStillExact(target, root)).toBe(false);
    writeFileSync(`${root}/101/status`, "Name:\tmember\nUid:\t1000\t1000\t1000\t1000\n");
    expect(rescueTargetStillExact(target, root)).toBe(true);
  });

  test("apply terminates a revalidated group and verifies it disappeared", async () => {
    const root = mkdtempSync(`${tmpdir()}/red-dev-incidents-`);
    roots.push(root);
    const before = snapshot([processRecord({ pid: 101 })]);
    const after = snapshot([]);
    after.capturedAt = "2026-08-11T15:01:00.000Z";
    let refreshes = 0;
    let aliveChecks = 0;
    const signals: string[] = [];

    const result = await applyRescue(before, planRescue(before), {
      incidentRoot: root,
      refresh: async () => (refreshes++ === 0 ? before : after),
      signalGroup: (_pgid, signal) => signals.push(signal),
      targetAlive: () => aliveChecks++ < 2,
      wait: async () => undefined,
    });

    expect(signals).toEqual(["SIGTERM"]);
    expect(result.ended).toEqual([100]);
    expect(result.failed).toEqual([]);
    expect(dirname(result.afterPath)).toBe(dirname(result.beforePath));
  });

  test("the production signal path ends a controlled detached process group", async () => {
    const root = mkdtempSync(`${tmpdir()}/red-dev-incidents-`);
    roots.push(root);
    const child = Bun.spawn(
      [process.execPath, "-e", "setInterval(()=>{},1000)"],
      { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
    const startTime = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19]!;
    const before = snapshot([
      processRecord({ pid: child.pid, ppid: 1, pgid: child.pid, sid: child.pid, startTime }),
    ]);
    const target = planRescue(before).targets[0]!;
    expect(rescueTargetStillExact(target)).toBe(true);
    let refreshes = 0;

    const result = await applyRescue(before, planRescue(before), {
      incidentRoot: root,
      refresh: async () => (refreshes++ === 0 || rescueTargetAlive(target) ? before : snapshot([])),
      signalGroup: signalProcessGroup,
      targetAlive: rescueTargetAlive,
      targetSafe: rescueTargetStillExact,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    await child.exited;

    expect(result.ended).toEqual([child.pid]);
    expect(rescueTargetAlive(target)).toBe(false);
  });

  test("thirty sequential interruption cycles restore the process/task baseline", async () => {
    const root = mkdtempSync(`${tmpdir()}/red-dev-incidents-`);
    roots.push(root);
    const baseline = currentUserBaseline();
    for (let cycle = 0; cycle < 30; cycle++) {
      const child = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
        const startTime = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19]!;
        const record = processRecord({
          pid: child.pid,
          ppid: 1,
          pgid: child.pid,
          sid: child.pid,
          startTime,
        });
        const activeSession = processRecord({
          pid: 900_000 + cycle,
          ppid: 2,
          pgid: 900_000 + cycle,
          sid: 900_000 + cycle,
          comm: "alacritty",
          argv: ["alacritty"],
          tty: "34816",
          unit: "app-active.scope",
          reparented: false,
        });
        const before = snapshot([record, activeSession]);
        before.activeUnits = ["app-active.scope"];
        const afterSnapshot = snapshot([activeSession]);
        afterSnapshot.activeUnits = ["app-active.scope"];
        const cyclePlan = planRescue(before);
        expect(cyclePlan.targets.map((item) => item.pgid)).toEqual([child.pid]);
        const target = cyclePlan.targets[0]!;
        let refreshes = 0;
        const result = await applyRescue(before, cyclePlan, {
          incidentRoot: root,
          refresh: async () =>
            refreshes++ === 0 || rescueTargetAlive(target) ? before : afterSnapshot,
          signalGroup: signalProcessGroup,
          targetAlive: rescueTargetAlive,
          targetSafe: rescueTargetStillExact,
          wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        });
        await child.exited;
        expect(result.ended).toEqual([child.pid]);
        expect(result.failed).toEqual([]);
        expect(rescueTargetAlive(target)).toBe(false);
        const recordedAfter = JSON.parse(readFileSync(result.afterPath, "utf8")) as {
          active_units: string[];
          metrics: { oomEvents: string[]; stopTimeouts: number };
          processes: Array<{ pid: number; cwd_deleted: boolean }>;
        };
        expect(recordedAfter.active_units).toEqual(["app-active.scope"]);
        expect(recordedAfter.metrics).toMatchObject({ oomEvents: [], stopTimeouts: 0 });
        expect(recordedAfter.processes).toEqual([
          expect.objectContaining({ pid: activeSession.pid, cwd_deleted: false }),
        ]);
      } finally {
        try {
          signalProcessGroup(child.pid, "SIGKILL");
        } catch {
          // Expected once Rescue has already emptied the group.
        }
      }
    }
    let after = currentUserBaseline();
    for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
      if (
        after.processes <= baseline.processes + 5 &&
        after.tasks <= baseline.tasks + 5
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      after = currentUserBaseline();
    }
    expect(after.processes).toBeLessThanOrEqual(baseline.processes + 5);
    expect(after.tasks).toBeLessThanOrEqual(baseline.tasks + 5);
  }, 15_000);
});
