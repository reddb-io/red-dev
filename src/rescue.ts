import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { runBounded } from "./bounded-command.ts";
import { collectLinuxHostSnapshot, procVisibilityKnown } from "./linux-host.ts";
import type { HostSnapshot, ProcessRecord } from "./host-health.ts";
import { assessHost } from "./host-health.ts";

export interface RescueTarget {
  pgid: number;
  uid: number;
  unit: string | null;
  processes: Array<{ pid: number; startTime: string }>;
}

export interface RescuePlan {
  capturedAt: string;
  targets: RescueTarget[];
}

export interface RescueApplyOptions {
  incidentRoot: string;
  refresh: () => Promise<HostSnapshot>;
  signalGroup: (pgid: number, signal: NodeJS.Signals) => void;
  targetAlive?: (target: RescueTarget) => boolean;
  targetSafe?: (target: RescueTarget) => boolean;
  stopUnit?: (unit: string) => Promise<void>;
  wait: (ms: number) => Promise<void>;
}

export interface RescueApplyResult {
  ended: number[];
  skipped: Array<{ pgid: number; reason: string }>;
  failed: Array<{ pgid: number; reason: string }>;
  beforePath: string;
  afterPath: string;
}

export function planRescue(snapshot: HostSnapshot): RescuePlan {
  const byPid = new Map(snapshot.processes.map((process) => [process.pid, process]));
  const targets = assessHost(snapshot).groups
    .filter((group) => group.disposition === "proven-orphan")
    .map((group) => {
      const members = group.pids.flatMap((pid) => {
        const process = byPid.get(pid);
        return process ? [process] : [];
      });
      const workerUnit = members
        .map((process) => process.unit)
        .find((unit) => /^red-worker-.*\.service$/.test(unit ?? ""));
      return {
        pgid: group.pgid,
        uid: snapshot.currentUid,
        unit: workerUnit ?? null,
        processes: members
          .map((process) => ({ pid: process.pid, startTime: process.startTime }))
          .sort((a, b) => a.pid - b.pid),
      };
    });
  return { capturedAt: snapshot.capturedAt, targets };
}

export function writeIncidentSnapshot(
  snapshot: HostSnapshot,
  plan: RescuePlan,
  root: string,
  phase: "before" | "after",
  incidentAt = plan.capturedAt,
): string {
  const stamp = incidentAt.replace(/[:.]/g, "-");
  const dir = `${root.replace(/\/$/, "")}/${stamp}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows has no POSIX mode; the state directory remains user-local.
  }
  const path = `${dir}/${phase}.json`;
  const document = {
    version: 1,
    phase,
    captured_at: snapshot.capturedAt,
    plan,
    metrics: snapshot.metrics,
    workers: snapshot.workers,
    active_units: snapshot.activeUnits,
    redskilled_pid: snapshot.redskilledPid,
    processes: snapshot.processes.map(sanitizedProcess),
  };
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // See directory note above.
  }
  return path;
}

const SAFE_ARGUMENT = /^(?:statusline|host-state|serve|--no-workers|--service|--ping)$/;
const SAFE_TOOL_PATH = /^(?:dev-.*\.bundle\.min\.mjs|go-dispatch-dispatcher\.(?:ts|js)|esbuild)$/i;

function sanitizedArgument(argument: string): string {
  if (SAFE_ARGUMENT.test(argument)) return argument;
  const name = basename(argument);
  return SAFE_TOOL_PATH.test(name) ? `<tool-path>/${name}` : "<redacted>";
}

function sanitizedProcess(process: ProcessRecord): Record<string, unknown> {
  return {
    pid: process.pid,
    ppid: process.ppid,
    pgid: process.pgid,
    sid: process.sid,
    uid: process.uid,
    start_time: process.startTime,
    state: process.state,
    age_seconds: process.ageSeconds,
    tasks: process.tasks,
    executable: process.argv[0] ?? process.comm,
    arguments: process.argv.slice(1).map(sanitizedArgument),
    cwd: process.cwd,
    cwd_deleted: process.cwdDeleted,
    tty: process.tty,
    unit: process.unit,
    cgroup: process.cgroup,
    reparented: process.reparented,
    stdio_observation_known: process.stdioObservationKnown,
    stdio_peer_link_known: process.stdioPeerLinkKnown,
  };
}

function sameIdentity(expected: RescueTarget, fresh: RescueTarget | undefined): boolean {
  if (!fresh || fresh.processes.length !== expected.processes.length) return false;
  return expected.processes.every((process, index) => {
    const actual = fresh.processes[index];
    return actual?.pid === process.pid && actual.startTime === process.startTime;
  });
}

export async function applyRescue(
  snapshot: HostSnapshot,
  plan: RescuePlan,
  options: RescueApplyOptions,
): Promise<RescueApplyResult> {
  const beforePath = writeIncidentSnapshot(snapshot, plan, options.incidentRoot, "before");
  const skipped: RescueApplyResult["skipped"] = [];
  const ended: number[] = [];
  const failed: RescueApplyResult["failed"] = [];
  const alive = options.targetAlive ?? (() => true);

  const revalidationFailure = async (target: RescueTarget): Promise<string | null> => {
    const currentPlan = planRescue(await options.refresh());
    const current = currentPlan.targets.find((candidate) => candidate.pgid === target.pgid);
    if (!sameIdentity(target, current)) return "process identity or protection changed";
    if (options.targetSafe && !options.targetSafe(target)) {
      return "process group changed after revalidation";
    }
    return null;
  };

  const waitForGone = async (target: RescueTarget, timeoutMs: number): Promise<boolean> => {
    if (!alive(target)) return true;
    for (let elapsed = 0; elapsed < timeoutMs; elapsed += 100) {
      await options.wait(100);
      if (!alive(target)) return true;
    }
    return !alive(target);
  };

  for (const target of plan.targets) {
    const beforeStopFailure = await revalidationFailure(target);
    if (beforeStopFailure) {
      skipped.push({ pgid: target.pgid, reason: beforeStopFailure });
      continue;
    }

    if (!alive(target)) {
      ended.push(target.pgid);
      continue;
    }
    try {
      if (target.unit && options.stopUnit) await options.stopUnit(target.unit);
      if (!alive(target)) {
        ended.push(target.pgid);
        continue;
      }
      if (target.unit) {
        const afterStopFailure = await revalidationFailure(target);
        if (afterStopFailure) {
          skipped.push({ pgid: target.pgid, reason: afterStopFailure });
          continue;
        }
      }
      options.signalGroup(target.pgid, "SIGTERM");
      let gone = await waitForGone(target, 5_000);
      if (!gone) {
        options.signalGroup(target.pgid, "SIGKILL");
        gone = await waitForGone(target, 2_000);
      }
      if (gone) ended.push(target.pgid);
      else failed.push({ pgid: target.pgid, reason: "group still populated after SIGKILL" });
    } catch (error) {
      if (!alive(target)) ended.push(target.pgid);
      else {
        failed.push({
          pgid: target.pgid,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const finalSnapshot = await options.refresh();
  const afterPath = writeIncidentSnapshot(
    finalSnapshot,
    planRescue(finalSnapshot),
    options.incidentRoot,
    "after",
    plan.capturedAt,
  );
  return { ended, skipped, failed, beforePath, afterPath };
}

export function incidentRoot(env: Record<string, string | undefined> = process.env): string {
  if (process.platform === "win32") {
    return `${(env["LOCALAPPDATA"] ?? ".").replace(/\\/g, "/")}/red-dev/incidents`;
  }
  const state = env["XDG_STATE_HOME"] ?? `${env["HOME"] ?? homedir()}/.local/state`;
  return `${state.replace(/\\/g, "/")}/red-dev/incidents`;
}

/** True while any process, including a newly-forked descendant, occupies the PGID. */
export function rescueTargetAlive(target: RescueTarget, procRoot = "/proc"): boolean {
  try {
    return readdirSync(procRoot).some((entry) => {
      if (!/^\d+$/.test(entry)) return false;
      return statIdentity(`${procRoot}/${entry}/stat`)?.pgid === target.pgid;
    });
  } catch {
    // Unknown is alive: Rescue may report failure, never a false success.
    return true;
  }
}

function statIdentity(path: string): { pid: number; pgid: number; tty: number; startTime: string } | null {
  try {
    const text = readFileSync(path, "utf8");
    const close = text.lastIndexOf(") ");
    if (close < 0) return null;
    const pid = Number.parseInt(text.slice(0, text.indexOf(" ")), 10);
    const fields = text.slice(close + 2).trim().split(/\s+/);
    const pgid = Number.parseInt(fields[2] ?? "", 10);
    const tty = Number.parseInt(fields[4] ?? "", 10);
    const startTime = fields[19] ?? "";
    return [pid, pgid, tty].every(Number.isFinite) && startTime !== ""
      ? { pid, pgid, tty, startTime }
      : null;
  } catch {
    return null;
  }
}

function uidAt(pid: number, procRoot: string): number | null {
  try {
    const match = /^Uid:\s+(\d+)/m.exec(readFileSync(`${procRoot}/${pid}/status`, "utf8"));
    return match ? Number.parseInt(match[1] ?? "", 10) : null;
  } catch {
    return null;
  }
}

/** Last-moment exact membership/TTY check before a group-wide signal. */
export function rescueTargetStillExact(target: RescueTarget, procRoot = "/proc"): boolean {
  if (!procVisibilityKnown(procRoot)) return false;
  const expected = new Map(target.processes.map((process) => [process.pid, process.startTime]));
  let entries: string[];
  try {
    entries = readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return false;
  }
  const members = entries.flatMap((entry) => {
    const identity = statIdentity(`${procRoot}/${entry}/stat`);
    return identity?.pgid === target.pgid
      ? [{ ...identity, uid: uidAt(identity.pid, procRoot) }]
      : [];
  });
  return (
    members.length === expected.size &&
    members.every(
      (member) =>
        member.tty === 0 &&
        member.uid === target.uid &&
        expected.get(member.pid) === member.startTime,
    )
  );
}

export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new Error(`unsafe process group ${pgid}`);
  process.kill(-pgid, signal);
}

async function stopWorkerUnit(unit: string): Promise<void> {
  if (!/^red-worker-.*\.service$/.test(unit)) throw new Error(`refusing non-Worker unit ${unit}`);
  const result = await runBounded(["systemctl", "--user", "stop", unit], { timeoutMs: 5_000 });
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(`systemctl could not stop ${unit}`);
  }
}

/** Production dependencies for a Linux/WSL Rescue apply. */
export function linuxRescueOptions(
  root = incidentRoot(),
): RescueApplyOptions {
  return {
    incidentRoot: root,
    refresh: collectLinuxHostSnapshot,
    signalGroup: signalProcessGroup,
    targetAlive: rescueTargetAlive,
    targetSafe: rescueTargetStillExact,
    stopUnit: stopWorkerUnit,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
