import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  collectLinuxHostSnapshot,
  collectLinuxProcesses,
  procVisibilityKnown,
  resolveRedskilledBin,
} from "./linux-host.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function processFixture(root: string, input: {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  startTicks: number;
  comm: string;
  argv: string[];
  cwd: string;
  tty?: number;
  fd?: string;
  uid?: number;
}): void {
  const dir = `${root}/${input.pid}`;
  mkdirSync(`${dir}/task/${input.pid}`, { recursive: true });
  mkdirSync(`${dir}/fd`, { recursive: true });
  const fields = [
    "S",
    String(input.ppid),
    String(input.pgid),
    String(input.sid),
    String(input.tty ?? 0),
    "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "1", "0",
    String(input.startTicks),
  ];
  writeFileSync(`${dir}/stat`, `${input.pid} (${input.comm}) ${fields.join(" ")}\n`);
  const uid = input.uid ?? 1000;
  writeFileSync(`${dir}/status`, `Name:\t${input.comm}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  writeFileSync(`${dir}/cmdline`, `${input.argv.join("\0")}\0`);
  writeFileSync(`${dir}/cgroup`, "0::/user.slice/user-1000.slice/app.slice/statusline.scope\n");
  symlinkSync(input.cwd, `${dir}/cwd`);
  if (input.fd) {
    symlinkSync(input.fd, `${dir}/fd/0`);
    symlinkSync(input.fd, `${dir}/fd/1`);
    symlinkSync(input.fd, `${dir}/fd/2`);
  }
}

describe("Linux process observation", () => {
  test("prefers the newest resident daemon bundle over a stale packaged entrypoint", () => {
    const root = mkdtempSync(`${tmpdir()}/red-dev-redskilled-`);
    roots.push(root);
    mkdirSync(`${root}/.red/redskilled/bundles`, { recursive: true });
    mkdirSync(`${root}/.red-skills/current/packaging/npm/bin`, { recursive: true });
    writeFileSync(`${root}/.red/redskilled/bundles/redskilled-3.9.0.bundle.min.mjs`, "");
    writeFileSync(`${root}/.red/redskilled/bundles/redskilled-3.13.0.bundle.min.mjs`, "");
    writeFileSync(`${root}/.red-skills/current/packaging/npm/bin/red-skills-redskilled.mjs`, "");

    expect(resolveRedskilledBin(root)).toBe(
      `${root}/.red/redskilled/bundles/redskilled-3.13.0.bundle.min.mjs`,
    );
  });

  test("derives lifecycle evidence from proc without shelling out", () => {
    const root = mkdtempSync(`${tmpdir()}/red-dev-proc-`);
    roots.push(root);
    processFixture(root, {
      pid: 553,
      ppid: 1,
      pgid: 553,
      sid: 553,
      startTicks: 1_000,
      comm: "Relay(553)",
      argv: ["/init"],
      cwd: "/",
      uid: 0,
    });
    processFixture(root, {
      pid: 700,
      ppid: 553,
      pgid: 700,
      sid: 700,
      startTicks: 10_000,
      comm: "node",
      argv: ["node", "/home/dev/.cache/red-skills/bundles/dev-3.12.13.bundle.min.mjs", "statusline"],
      cwd: "/workspace/removed (deleted)",
      fd: "socket:[4242]",
    });
    processFixture(root, {
      pid: 702,
      ppid: 1,
      pgid: 702,
      sid: 702,
      startTicks: 20_000,
      comm: "observer",
      argv: ["observer"],
      cwd: "/workspace",
    });
    symlinkSync("socket:[4242]", `${root}/702/fd/9`);
    processFixture(root, {
      pid: 701,
      ppid: 700,
      pgid: 700,
      sid: 700,
      startTicks: 10_100,
      comm: "hidden-helper",
      argv: ["hidden-helper"],
      cwd: "/workspace/removed (deleted)",
    });
    rmSync(`${root}/701/status`);

    const records = collectLinuxProcesses({
      procRoot: root,
      uid: 1000,
      uptimeSeconds: 500,
      clockTicks: 100,
    });

    expect(records.find((record) => record.pid === 700)).toMatchObject({
      ppid: 553,
      pgid: 700,
      sid: 700,
      ageSeconds: 400,
      tasks: 1,
      cwd: "/workspace/removed",
      cwdDeleted: true,
      reparented: true,
      externalStdioPeers: [702],
      stdioPeerLinkKnown: false,
    });
    expect(records.find((record) => record.pid === 701)).toMatchObject({
      pgid: 700,
      uid: null,
    });
  });

  test("fails closed for every non-disabled hidepid spelling", () => {
    const mount = (value: string) =>
      `proc /proc proc rw,nosuid,nodev,noexec,relatime,hidepid=${value} 0 0\n`;
    expect(procVisibilityKnown("/proc", mount("0"))).toBe(true);
    expect(procVisibilityKnown("/proc", mount("off"))).toBe(true);
    for (const value of ["1", "2", "4", "invisible", "noaccess", "ptraceable"]) {
      expect(procVisibilityKnown("/proc", mount(value))).toBe(false);
    }
  });

  test("composes proc, cgroup, systemd, journal and daemon evidence", async () => {
    const root = mkdtempSync(`${tmpdir()}/red-dev-host-`);
    roots.push(root);
    const procRoot = `${root}/proc`;
    const cgroupRoot = `${root}/cgroup`;
    mkdirSync(procRoot, { recursive: true });
    mkdirSync(`${cgroupRoot}/user.slice/user-1000.slice`, { recursive: true });
    writeFileSync(`${procRoot}/uptime`, "500.00 100.00\n");
    writeFileSync(
      `${procRoot}/meminfo`,
      "MemTotal:       33554432 kB\nMemAvailable:   18874368 kB\n",
    );
    writeFileSync(`${cgroupRoot}/user.slice/user-1000.slice/pids.current`, "123\n");
    writeFileSync(`${cgroupRoot}/user.slice/user-1000.slice/pids.max`, "59019\n");
    processFixture(procRoot, {
      pid: 700,
      ppid: 1,
      pgid: 700,
      sid: 700,
      startTicks: 10_000,
      comm: "claude",
      argv: ["claude"],
      cwd: "/workspace/project",
    });

    const result = (stdout: string, exitCode = 0) => ({
      stdout,
      stderr: "",
      exitCode,
      timedOut: false,
      groupGone: true,
    });
    const run = async (argv: string[]) => {
      const line = argv.join(" ");
      if (line.includes("list-units")) {
        return result(
          "red-worker-live.service loaded active running\n" +
            "app-editor.scope loaded deactivating stop-sigterm\n" +
            "old-helper.service loaded inactive dead\n",
        );
      }
      if (line.includes("redskilled.service")) return result("MainPID=999\n");
      if (line.includes("red-worker-live.service")) {
        return result("TasksMax=4096\nMemoryCurrent=536870912\nMemoryMax=2684354560\n");
      }
      if (line.includes("journalctl")) {
        return result(
          "2026-08-11T11:30:00-03:00 host systemd[1]: A process was killed by the OOM killer\n" +
            "2026-08-11T11:31:00-03:00 host systemd[1]: State stop-sigterm timed out. Killing.\n",
        );
      }
      return result("", 1);
    };

    const observed = await collectLinuxHostSnapshot({
      procRoot,
      cgroupRoot,
      uid: 1000,
      currentPid: 800,
      now: new Date("2026-08-11T15:00:00.000Z"),
      clockTicks: 100,
      disk: { freeBytes: 100 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 },
      readInventory: async () => ({
        daemonPid: 888,
        workers: [{ pid: 700, unit: "red-worker-live.service" }],
      }),
      systemd: true,
      run,
    });

    expect(observed).toMatchObject({
      currentUid: 1000,
      redskilledPid: 888,
      workerStateKnown: true,
      workers: [{ pid: 700, unit: "red-worker-live.service" }],
      activeUnits: ["red-worker-live.service", "app-editor.scope"],
      activeUnitsKnown: true,
      stdioUniverseKnown: true,
      processUniverseKnown: true,
      metrics: {
        processCount: 1,
        taskCount: 1,
        pidsCurrent: 123,
        pidsMax: 59_019,
        memoryAvailableBytes: 18 * 1024 ** 3,
        memoryTotalBytes: 32 * 1024 ** 3,
        stopTimeouts: 1,
        workerLimitsKnown: true,
        workerTasksMax: [4_096],
        workerMemoryCurrent: [536_870_912],
        workerMemoryMax: [2_684_354_560],
      },
    });
    expect(observed.metrics.oomEvents).toHaveLength(1);
  });
});
