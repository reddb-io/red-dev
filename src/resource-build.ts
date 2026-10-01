/** Opt-in build coordination, shared by participating projects in one environment. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redDevStateRoot } from "./reclaim.ts";
import { readMachineProfile } from "./machine-profile.ts";
import { readProjectResources, resourceProjectRoot } from "./resource-plan.ts";
import { log } from "./log.ts";
import { acquireUpdateLock } from "./update-coordinator.ts";

interface BuildOwner { pid: number; childPid?: number; token: string; phase: "queued" | "launching" | "running"; }
export interface BuildLease { launching: () => void; running: (pid: number) => void; release: () => void; }
export interface BuildQueueEntry { slot: string; phase: string; runnerPid: number | null; childPid: number | null; runnerAlive: boolean | null; }
function alive(pid: number | undefined): boolean { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; } }
function childAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  return process.platform === "win32" ? alive(pid) : alive(-pid);
}
function owner(path: string): BuildOwner | null {
  try { const value = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
    return Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.token === "string" && ["queued", "launching", "running"].includes(value.phase) && (value.phase !== "running" || Number.isSafeInteger(value.childPid) && value.childPid > 0) ? value : null;
  } catch { return null; }
}
export function inspectBuildQueue(root = join(redDevStateRoot(), "resources/build-slots")): BuildQueueEntry[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(s => /^\d+$/.test(s)).map(slot => {
    const o = owner(join(root, slot));
    return { slot, phase: o?.phase ?? "unknown", runnerPid: o?.pid ?? null, childPid: o?.childPid ?? null, runnerAlive: o ? alive(o.pid) : null };
  });
}
export function takeBuildSlot(slots: number, root = join(redDevStateRoot(), "resources/build-slots")): BuildLease | null {
  mkdirSync(root, { recursive: true });
  const releaseAllocation = acquireUpdateLock(join(root, "allocation"));
  if (!releaseAllocation) return null;
  try {
    // A reduced slot count never bypasses builds still running in older slots.
    let occupied = 0;
    for (let i = 0; i < 64; i++) {
    const path = join(root, String(i)); if (!existsSync(path)) continue;
    const previous = owner(path);
    if (!previous || previous.phase === "launching" && !alive(previous.pid)) throw Error(`build slot ownership unresolved; preserved ${path}. Inspect compiler processes before removing this interrupted slot.`);
      if (!previous || previous.phase === "launching" || alive(previous.pid) || childAlive(previous.childPid)) { occupied++; continue; }
      const retired = `${path}.dead-${crypto.randomUUID()}`; renameSync(path, retired); rmSync(retired, { recursive: true });
    }
    if (occupied >= slots) return null;
    const count = Array.from({ length: 64 }, (_, i) => existsSync(join(root, String(i)))).filter(Boolean).length;
    if (count >= slots) return null;
    for (let i = 0; i < slots; i++) {
      const path = join(root, String(i)); if (existsSync(path)) continue;
      mkdirSync(path); const record: BuildOwner = { pid: process.pid, token: crypto.randomUUID(), phase: "queued" };
      const save = () => {
        const temporary = join(path, `${record.token}.tmp`);
        writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
        renameSync(temporary, join(path, "owner.json"));
      };
      try { save(); } catch (err) { rmSync(path, { recursive: true }); throw err; }
      return { launching: () => { record.phase = "launching"; save(); },
        running: pid => { record.childPid = pid; record.phase = "running"; save(); },
        release: () => { if (owner(path)?.token === record.token) rmSync(path, { recursive: true }); } };
    }
    return null;
  } finally { releaseAllocation(); }
}
export function buildEnvironment(argv: string[], jobs: number | undefined, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const separator = argv.indexOf("--");
  const explicit = (separator < 0 ? argv : argv.slice(0, separator)).some(a => a.startsWith("-j") || a === "--jobs" || a.startsWith("--jobs="));
  return jobs !== undefined && !explicit && env.CARGO_BUILD_JOBS === undefined ? { ...env, CARGO_BUILD_JOBS: String(jobs) } : { ...env };
}
export async function runResourceBuild(argv: string[], project?: string): Promise<number> {
  if (!argv.length || !/^(?:.*[\\/])?cargo(?:\.exe)?$/.test(argv[0]!)) throw Error("resources run requires -- cargo <arguments>");
  const root = resourceProjectRoot(project); const jobs = readProjectResources(root)?.jobs;
  const slots = readMachineProfile()?.resources?.buildSlots;
  let lease: BuildLease | null = null; let cancelled = false; let child: Bun.Subprocess | undefined;
  const cancel = () => { cancelled = true; try { if (child) { if (process.platform === "win32") child.kill("SIGINT"); else process.kill(-child.pid, "SIGINT"); } } catch { /* Child already exited. */ } };
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  try {
    if (slots) {
      log.plain(`Build coordination: up to ${slots} participating build(s); direct Cargo is outside this queue. Ctrl+C cancels waiting.`);
      while (!cancelled && !(lease = takeBuildSlot(slots))) await new Promise(r => setTimeout(r, 250));
    }
    if (cancelled) return 130;
    lease?.launching();
    child = Bun.spawn(argv, { cwd: project ? root : process.cwd(), env: buildEnvironment(argv, jobs), stdin: "inherit", stdout: "inherit", stderr: "inherit", detached: process.platform !== "win32" });
    lease?.running(child.pid);
    return await child.exited;
  } finally {
    process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
    // Never release capacity while an observed child is alive.
    if (!child || !childAlive(child.pid)) lease?.release();
  }
}
