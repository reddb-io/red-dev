import { existsSync, readdirSync, readFileSync, readlinkSync, statfsSync } from "node:fs";
import {
  runBounded,
  type BoundedCommandOptions,
  type BoundedCommandResult,
} from "./bounded-command.ts";
import { readHostInventoryNoStart, type HostInventory } from "./host-state.ts";
import type { HostSnapshot, ProcessRecord } from "./host-health.ts";

export interface LinuxProcessOptions {
  procRoot?: string;
  uid: number;
  uptimeSeconds: number;
  clockTicks?: number;
}

export interface LinuxHostOptions {
  procRoot?: string;
  cgroupRoot?: string;
  uid?: number;
  currentPid?: number;
  now?: Date;
  clockTicks?: number;
  disk?: { freeBytes: number; totalBytes: number };
  readInventory?: () => Promise<HostInventory | null>;
  systemd?: boolean;
  run?: (
    argv: string[],
    options?: BoundedCommandOptions,
  ) => Promise<BoundedCommandResult>;
}

interface ParsedStat {
  comm: string;
  state: string;
  ppid: number;
  pgid: number;
  sid: number;
  tty: number;
  startTime: string;
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function link(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

function parseStat(text: string): ParsedStat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(") ");
  if (open < 0 || close < open) return null;
  const fields = text.slice(close + 2).trim().split(/\s+/);
  if (fields.length < 20) return null;
  const number = (index: number): number => Number.parseInt(fields[index] ?? "", 10);
  const ppid = number(1);
  const pgid = number(2);
  const sid = number(3);
  const tty = number(4);
  if (![ppid, pgid, sid, tty].every(Number.isFinite)) return null;
  return {
    comm: text.slice(open + 1, close),
    state: fields[0] ?? "?",
    ppid,
    pgid,
    sid,
    tty,
    startTime: fields[19] ?? "0",
  };
}

function uidFromStatus(text: string): number | null {
  const match = /^Uid:\s+(\d+)/m.exec(text);
  return match ? Number.parseInt(match[1] ?? "", 10) : null;
}

function unitFromCgroup(cgroup: string | null): string | null {
  if (!cgroup) return null;
  const match = /\/(?:[^/]*\/)*([^/]+\.(?:service|scope))(?:\n|$)/.exec(cgroup);
  return match?.[1] ?? null;
}

function fdTargets(root: string, pid: number): {
  stdio: string[];
  all: string[];
  known: boolean;
  stdioPeerLinkKnown: boolean;
} {
  const stdio = new Set<string>();
  const all = new Set<string>();
  let known = true;
  let stdioPeerLinkKnown = true;
  let fds: string[];
  try {
    fds = readdirSync(`${root}/${pid}/fd`);
  } catch {
    return { stdio: [], all: [], known: false, stdioPeerLinkKnown: false };
  }
  for (const fd of fds) {
    try {
      const target = readlinkSync(`${root}/${pid}/fd/${fd}`);
      if (/^(?:socket|pipe):\[\d+\]$/.test(target)) {
        all.add(target);
        if (fd === "0" || fd === "1" || fd === "2") {
          stdio.add(target);
          if (target.startsWith("socket:")) stdioPeerLinkKnown = false;
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") known = false;
    }
  }
  return { stdio: [...stdio], all: [...all], known, stdioPeerLinkKnown };
}

function taskCount(root: string, pid: number): number {
  try {
    return readdirSync(`${root}/${pid}/task`).filter((entry) => /^\d+$/.test(entry)).length;
  } catch {
    return 1;
  }
}

/** Observe every readable Linux process so process-group safety sees mixed UIDs. */
export function collectLinuxProcesses(options: LinuxProcessOptions): ProcessRecord[] {
  const root = options.procRoot ?? "/proc";
  const clockTicks = options.clockTicks ?? 100;
  const records: ProcessRecord[] = [];
  const targets = new Map<number, ReturnType<typeof fdTargets>>();

  let entries: string[];
  try {
    entries = readdirSync(root).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return [];
  }

  for (const entry of entries) {
    const pid = Number.parseInt(entry, 10);
    const statText = read(`${root}/${entry}/stat`);
    const status = read(`${root}/${entry}/status`);
    const processUid = status ? uidFromStatus(status) : null;
    if (!statText) continue;
    const stat = parseStat(statText);
    if (!stat) continue;

    const cmdline = read(`${root}/${entry}/cmdline`) ?? "";
    const argv = cmdline.split("\0").filter(Boolean);
    const rawCwd = link(`${root}/${entry}/cwd`);
    const cwdDeleted = rawCwd?.endsWith(" (deleted)") ?? false;
    const cwd = rawCwd ? rawCwd.replace(/ \(deleted\)$/, "") : null;
    const cgroup = read(`${root}/${entry}/cgroup`)?.trim() ?? null;
    const startTicks = Number.parseInt(stat.startTime, 10);
    const ageSeconds = Number.isFinite(startTicks)
      ? Math.max(0, Math.floor(options.uptimeSeconds - startTicks / clockTicks))
      : 0;

    records.push({
      pid,
      ppid: stat.ppid,
      pgid: stat.pgid,
      sid: stat.sid,
      uid: processUid,
      startTime: stat.startTime,
      state: stat.state,
      ageSeconds,
      tasks: taskCount(root, pid),
      comm: stat.comm,
      argv,
      cwd,
      cwdDeleted,
      tty: stat.tty === 0 ? null : String(stat.tty),
      unit: unitFromCgroup(cgroup),
      cgroup,
      reparented: false,
      externalStdioPeers: [],
      stdioObservationKnown: true,
      stdioPeerLinkKnown: true,
    });
    targets.set(pid, fdTargets(root, pid));
  }

  const byPid = new Map(records.map((record) => [record.pid, record]));
  const owners = new Map<string, number[]>();
  for (const [pid, observation] of targets) {
    for (const target of observation.all) {
      owners.set(target, [...(owners.get(target) ?? []), pid]);
    }
  }

  for (const record of records) {
    const parent = byPid.get(record.ppid);
    const parentOutsideUser = parent
      ? null
      : parseStat(read(`${root}/${record.ppid}/stat`) ?? "");
    record.reparented =
      record.ppid === 1 ||
      Boolean(parent && /^(?:Relay(?:\(\d+\))?|init)$/i.test(parent.comm)) ||
      Boolean(parentOutsideUser && /^(?:Relay(?:\(\d+\))?|init)$/i.test(parentOutsideUser.comm));
    const peers = new Set<number>();
    const observation = targets.get(record.pid);
    record.stdioObservationKnown = observation?.known ?? false;
    record.stdioPeerLinkKnown = observation?.stdioPeerLinkKnown ?? false;
    for (const target of observation?.stdio ?? []) {
      for (const owner of owners.get(target) ?? []) {
        if (owner !== record.pid && byPid.get(owner)?.pgid !== record.pgid) peers.add(owner);
      }
    }
    record.externalStdioPeers = [...peers].sort((a, b) => a - b);
  }

  return records.sort((a, b) => a.pid - b.pid);
}

function numericFile(path: string): number | null {
  const text = read(path)?.trim();
  if (!text || text === "max") return null;
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) ? value : null;
}

function memoryBytes(meminfo: string | null, field: string): number | null {
  if (!meminfo) return null;
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "m").exec(meminfo);
  return match ? Number.parseInt(match[1] ?? "", 10) * 1024 : null;
}

function parseProperties(text: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) properties[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return properties;
}

function journalEvidence(text: string): { oomEvents: string[]; stopTimeouts: number } {
  const oomEvents = new Set<string>();
  let stopTimeouts = 0;
  for (const line of text.split("\n")) {
    if (/A process .* killed by the OOM killer|Out of memory: Killed process/i.test(line)) {
      const stamp = line.match(/^\S+/)?.[0];
      const parsed = stamp ? Date.parse(stamp) : Number.NaN;
      if (Number.isFinite(parsed)) oomEvents.add(new Date(parsed).toISOString());
    }
    if (/stop-sigterm.*timed out|timed out.*Killing/i.test(line)) stopTimeouts++;
  }
  return { oomEvents: [...oomEvents], stopTimeouts };
}

function defaultDisk(): { freeBytes: number; totalBytes: number } {
  try {
    const stat = statfsSync("/");
    return { freeBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize };
  } catch {
    return { freeBytes: Number.NaN, totalBytes: Number.NaN };
  }
}

export function procVisibilityKnown(
  procRoot = "/proc",
  mountsText?: string | null,
): boolean {
  if (procRoot !== "/proc") return true;
  const mounts = mountsText === undefined ? read(`${procRoot}/mounts`) : mountsText;
  if (!mounts) return false;
  const procMount = mounts.split("\n").find((line) => {
    const fields = line.split(/\s+/);
    return fields[1] === "/proc" && fields[2] === "proc";
  });
  if (!procMount) return false;
  const options = procMount.split(/\s+/)[3]?.split(",") ?? [];
  return !options.some((option) => {
    if (option === "hidepid") return true;
    const match = /^hidepid=(.*)$/.exec(option);
    return match !== null && !/^(?:0|off)$/.test(match[1] ?? "");
  });
}

export { resolveRedskilledBin } from "./host-state.ts";

/** Collect one bounded, read-only Linux/WSL host snapshot. */
export async function collectLinuxHostSnapshot(
  options: LinuxHostOptions = {},
): Promise<HostSnapshot> {
  const procRoot = options.procRoot ?? "/proc";
  const cgroupRoot = options.cgroupRoot ?? "/sys/fs/cgroup";
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const currentPid = options.currentPid ?? process.pid;
  const now = options.now ?? new Date();
  const uptimeSeconds = Number.parseFloat(read(`${procRoot}/uptime`)?.split(/\s+/)[0] ?? "0");
  const processes = collectLinuxProcesses({
    procRoot,
    uid,
    uptimeSeconds: Number.isFinite(uptimeSeconds) ? uptimeSeconds : 0,
    clockTicks: options.clockTicks,
  });
  const run = options.run ?? runBounded;
  const systemd = options.systemd ?? existsSync("/run/systemd/system");
  const inventory = await (options.readInventory ?? readHostInventoryNoStart)();

  let activeUnits: string[] = [];
  let activeUnitsKnown = !systemd;
  let redskilledPid: number | null = null;
  let workerTasksMax: Array<number | "infinity"> = [];
  let workerMemoryCurrent: number[] = [];
  let workerMemoryMax: Array<number | "infinity"> = [];
  let workerLimitsKnown = !systemd;
  let journal = { oomEvents: [] as string[], stopTimeouts: 0 };
  if (systemd) {
    const unitArgs = [
      "list-units", "--type=service", "--type=scope", "--all", "--no-legend", "--no-pager",
    ];
    const unitResults = await Promise.all([
      run(["systemctl", "--user", ...unitArgs], { timeoutMs: 2_000 }),
      run(["systemctl", ...unitArgs], { timeoutMs: 2_000 }),
    ]);
    activeUnitsKnown = unitResults.every((result) => !result.timedOut && result.exitCode === 0);
    if (activeUnitsKnown) {
      activeUnits = [...new Set(unitResults.flatMap((result) =>
        result.stdout
          .split("\n")
          .flatMap((line) => {
            const fields = line.trim().split(/\s+/);
            const unit = fields[0] ?? "";
            const activeState = fields[2] ?? "unknown";
            return /\.(?:service|scope)$/.test(unit) &&
                activeState !== "inactive" && activeState !== "failed"
              ? [unit]
              : [];
          })
      ))];
    }

    const daemon = await run(
      ["systemctl", "--user", "show", "redskilled.service", "-p", "MainPID"],
      { timeoutMs: 2_000 },
    );
    const daemonPid = Number.parseInt(parseProperties(daemon.stdout)["MainPID"] ?? "", 10);
    redskilledPid = Number.isSafeInteger(daemonPid) && daemonPid > 0 ? daemonPid : null;

    const workerUnits = [...new Set([
      ...activeUnits.filter((unit) => /^red-worker-.*\.service$/.test(unit)),
      ...(inventory?.workers.map((worker) => worker.unit).filter(
        (unit): unit is string => /^red-worker-.*\.service$/.test(unit ?? ""),
      ) ?? []),
    ])];
    const limits = await Promise.all(
      workerUnits.map(async (unit) => {
        const shown = await run(
          [
            "systemctl", "--user", "show", unit,
            "-p", "TasksMax", "-p", "MemoryCurrent", "-p", "MemoryMax",
          ],
          { timeoutMs: 2_000 },
        );
        if (shown.timedOut || shown.exitCode !== 0) return null;
        const properties = parseProperties(shown.stdout);
        const limit = (name: string): number | "infinity" | null => {
          const value = properties[name];
          if (value === "infinity") return "infinity";
          const parsed = Number.parseInt(value ?? "", 10);
          return Number.isFinite(parsed) ? parsed : null;
        };
        return {
          tasksMax: limit("TasksMax"),
          memoryCurrent: limit("MemoryCurrent"),
          memoryMax: limit("MemoryMax"),
        };
      }),
    );
    workerTasksMax = limits.flatMap((limit) =>
      limit && limit.tasksMax !== null ? [limit.tasksMax] : []
    );
    workerMemoryCurrent = limits.flatMap((limit) =>
      typeof limit?.memoryCurrent === "number" ? [limit.memoryCurrent] : []
    );
    workerMemoryMax = limits.flatMap((limit) =>
      limit && limit.memoryMax !== null ? [limit.memoryMax] : []
    );
    workerLimitsKnown = activeUnitsKnown && limits.every((limit) =>
      limit !== null &&
      limit.tasksMax !== null &&
      typeof limit.memoryCurrent === "number" &&
      limit.memoryMax !== null
    );

    const events = await run(
      ["journalctl", "--user", "--since", "24 hours ago", "--no-pager", "-o", "short-iso"],
      { timeoutMs: 2_000 },
    );
    if (!events.timedOut && events.exitCode === 0) journal = journalEvidence(events.stdout);
  }

  const meminfo = read(`${procRoot}/meminfo`);
  const disk = options.disk ?? defaultDisk();
  const userSlice = `${cgroupRoot}/user.slice/user-${uid}.slice`;
  return {
    capturedAt: now.toISOString(),
    currentPid,
    currentUid: uid,
    processes,
    workers: inventory?.workers.map((worker) => ({ ...worker })) ?? [],
    workerStateKnown: inventory !== null,
    activeUnits,
    activeUnitsKnown,
    stdioUniverseKnown: processes.every((process) => process.stdioObservationKnown),
    processUniverseKnown: procVisibilityKnown(procRoot),
    redskilledPid: inventory?.daemonPid ?? redskilledPid,
    metrics: {
      processCount: processes.filter((process) => process.uid === uid).length,
      taskCount: processes
        .filter((process) => process.uid === uid)
        .reduce((sum, process) => sum + process.tasks, 0),
      pidsCurrent: numericFile(`${userSlice}/pids.current`),
      pidsMax: numericFile(`${userSlice}/pids.max`),
      memoryAvailableBytes: memoryBytes(meminfo, "MemAvailable"),
      memoryTotalBytes: memoryBytes(meminfo, "MemTotal"),
      diskFreeBytes: Number.isFinite(disk.freeBytes) ? disk.freeBytes : null,
      diskTotalBytes: Number.isFinite(disk.totalBytes) ? disk.totalBytes : null,
      oomEvents: journal.oomEvents,
      stopTimeouts: journal.stopTimeouts,
      workerLimitsKnown,
      workerTasksMax,
      workerMemoryCurrent,
      workerMemoryMax,
    },
  };
}
