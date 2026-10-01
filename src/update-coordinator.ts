/** A single local writer and a persistent clock for all update entry points. */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { redDevStateRoot } from "./reclaim.ts";

export interface UpdateJobState {
  attemptedAt: number;
  succeededAt?: number;
  nextAttemptAt: number;
  failures: number;
  outcome: "ok" | "failed";
}
export interface UpdateClock { schema: 1; jobs: Record<string, UpdateJobState>; }
export function updateClockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(redDevStateRoot(env), "update-coordinator.json");
}
export function readUpdateClock(path = updateClockPath()): UpdateClock {
  if (!existsSync(path)) return { schema: 1, jobs: {} };
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.schema !== 1 || !value.jobs || typeof value.jobs !== "object") throw new Error(`invalid update clock: ${path}`);
  return value;
}
function writeClock(path: string, clock: UpdateClock): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(clock, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
export function nextJobState(previous: UpdateJobState | undefined, ok: boolean, now: number, interval: number, random = Math.random()): UpdateJobState {
  const failures = ok ? 0 : (previous?.failures ?? 0) + 1;
  const delay = ok ? interval : Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.min(failures - 1, 9));
  return { attemptedAt: now, succeededAt: ok ? now : previous?.succeededAt,
    nextAttemptAt: now + Math.round(delay * (0.9 + random * 0.2)), failures, outcome: ok ? "ok" : "failed" };
}
export function jobDue(state: UpdateJobState | undefined, now: number): boolean {
  return !state || now < state.attemptedAt || now >= state.nextAttemptAt;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
}
/** Never expire a live writer just because a download is slow. */
export function acquireUpdateLock(path = updateClockPath()): (() => void) | null {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const take = () => {
    try { mkdirSync(lock); } catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST") return null; throw err; }
    const token = crypto.randomUUID();
    try { writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 }); }
    catch (err) { rmSync(lock, { recursive: true }); throw err; }
    return () => {
      try { if (JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token === token) rmSync(lock, { recursive: true }); }
      catch { /* Already released; never remove another owner's lock. */ }
    };
  };
  const first = take();
  if (first) return first;
  // Serialize recovery so two processes cannot reap each other's new lease.
  let fd: number;
  const recovery = `${path}.recover`;
  try { fd = openSync(recovery, "wx", 0o600); } catch { return null; }
  try {
    let owner: { pid?: number };
    try { owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")); } catch { return null; }
    if (!Number.isInteger(owner.pid) || owner.pid! <= 0 || alive(owner.pid!)) return null;
    const retired = `${lock}.dead-${crypto.randomUUID()}`;
    renameSync(lock, retired);
    rmSync(retired, { recursive: true });
    return take();
  } finally { closeSync(fd); rmSync(recovery, { force: true }); }
}

export async function withUpdateLock<T>(run: () => Promise<T>, path = updateClockPath()): Promise<{ busy: true } | { busy: false; value: T }> {
  const release = acquireUpdateLock(path);
  if (!release) return { busy: true };
  try { return { busy: false, value: await run() }; } finally { release(); }
}
/** Call under withUpdateLock. Persist failure before accepting another trigger. */
export async function runUpdateJob(name: string, interval: number, run: () => Promise<boolean>, opts: { path?: string; now?: number; force?: boolean; random?: number } = {}): Promise<"ok" | "failed" | "not-due"> {
  const path = opts.path ?? updateClockPath();
  const now = opts.now ?? Date.now();
  const clock = readUpdateClock(path);
  if (!opts.force && !jobDue(clock.jobs[name], now)) return "not-due";
  let ok = false;
  try { ok = await run(); }
  finally {
    clock.jobs[name] = nextJobState(clock.jobs[name], ok, now, interval, opts.random);
    writeClock(path, clock);
  }
  return ok ? "ok" : "failed";
}
