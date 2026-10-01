/** Reversible, checked file edits. Unknown changes are never overwritten by undo. */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { hostname } from "node:os";
import { redDevStateRoot } from "./reclaim.ts";
import { acquireUpdateLock } from "./update-coordinator.ts";
import { parseDevConfig, renderDevConfig } from "./dev-config.ts";

export interface ResourceEdit { path: string; before: string | null; after: string | null; mode: number; section?: "resources"; }
interface Transaction { id: string; state: "pending" | "applied"; edits: ResourceEdit[]; }
export interface History { schema: 1; transactions: Transaction[]; }
export function encodedFile(path: string): string | null {
  if (!existsSync(path)) { if (safeStat(path)) throw Error(`unsupported resource file: ${path}`); return null; }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`resource edits require a regular file: ${path}`);
  return readFileSync(path).toString("base64");
}
function safeStat(path: string) { try { return lstatSync(path); } catch { return null; } }
export function resourceEdit(path: string, text: string | null): ResourceEdit {
  return { path, before: encodedFile(path), after: text === null ? null : Buffer.from(text).toString("base64"), mode: safeStat(path)?.mode ?? 0o600 };
}
export function resourceHistoryPath(project?: string): string {
  const key = project ? `project-${createHash("sha256").update(project).digest("hex").slice(0, 24)}` : "machine";
  return join(redDevStateRoot(), "resources", `${key}.json`);
}
export function readResourceHistory(path: string): History {
  if (!existsSync(path)) return { schema: 1, transactions: [] };
  const value = JSON.parse(readFileSync(path, "utf8")) as History;
  if (value.schema !== 1 || !Array.isArray(value.transactions) || value.transactions.some(t => !t || !["pending", "applied"].includes(t.state) || !Array.isArray(t.edits) || t.edits.some(e => !e || typeof e.path !== "string" || typeof e.mode !== "number" || (e.section !== undefined && e.section !== "resources") || (e.before !== null && typeof e.before !== "string") || (e.after !== null && typeof e.after !== "string")))) throw Error(`invalid resource history: ${path}`);
  return value;
}
function atomic(path: string, bytes: string | null, mode: number): void {
  if (bytes === null) { rmSync(path, { force: true }); return; }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try { writeFileSync(temporary, Buffer.from(bytes, "base64"), { mode: mode & 0o777 }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}
function saveHistory(path: string, value: History) { atomic(path, Buffer.from(JSON.stringify(value, null, 2) + "\n").toString("base64"), 0o600); }
function lockFiles(edits: ResourceEdit[]): () => void {
  const held: string[] = [];
  const writers: (() => void)[] = [];
  const release = () => { held.reverse().forEach(p => rmSync(p, { force: true })); writers.reverse().forEach(release => release()); };
  try {
    for (const path of [...new Set(edits.map(e => e.path))].sort()) {
      const writer = acquireUpdateLock(`${path}.writer`);
      if (!writer) throw Error(`resource file is being edited; retry later: ${path}`);
      writers.push(writer);
      mkdirSync(dirname(path), { recursive: true });
      const lock = `${path}.red-dev-resources.lock`;
      const identity = { pid: process.pid, host: hostname(), platform: process.platform, distro: process.env.WSL_DISTRO_NAME ?? null };
      let fd: number;
      try { fd = openSync(lock, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const recovery = `${lock}.recover`; const recoveryFd = openSync(recovery, "wx", 0o600);
        try {
          const previous = JSON.parse(readFileSync(lock, "utf8"));
          if (previous.host !== identity.host || previous.platform !== identity.platform || previous.distro !== identity.distro || !Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw Error(`resource edit lock has unknown ownership; preserved: ${lock}`);
          let dead = false;
          try { process.kill(previous.pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === "ESRCH"; }
          if (!dead) throw Error(`resource file is being edited; retry later: ${path}`);
          rmSync(lock); fd = openSync(lock, "wx", 0o600);
        } finally { closeSync(recoveryFd); rmSync(recovery, { force: true }); }
      }
      held.push(lock);
      try { writeFileSync(fd, JSON.stringify(identity)); } finally { closeSync(fd); }
    }
  } catch (err) { release(); throw err; }
  return release;
}
export function applyResourceEdits(edits: ResourceEdit[], historyPath: string): void {
  const changes = edits.filter(e => e.before !== e.after);
  if (!changes.length) return;
  const release = lockFiles(changes);
  try {
    const history = readResourceHistory(historyPath);
    if (history.transactions.some(t => t.state === "pending")) throw Error("an interrupted resource change needs resources undo first");
    for (const e of changes) if (encodedFile(e.path) !== e.before) throw Error(`file changed since preview: ${e.path}`);
    const transaction: Transaction = { id: crypto.randomUUID(), state: "pending", edits: changes };
    history.transactions.push(transaction); saveHistory(historyPath, history);
    for (const e of changes) atomic(e.path, e.after, e.mode);
    transaction.state = "applied"; saveHistory(historyPath, history);
  } finally { release(); }
}
export function undoResourcePlan(historyPath: string): ResourceEdit[] {
  const last = readResourceHistory(historyPath).transactions.at(-1);
  if (!last) return [];
  return last.edits.map(e => {
    const current = encodedFile(e.path);
    if (e.section === "resources" && current !== null && e.after !== null) {
      const live = parseDevConfig(Buffer.from(current, "base64").toString("utf8"));
      const expected = parseDevConfig(Buffer.from(e.after, "base64").toString("utf8"));
      const original = e.before === null ? null : parseDevConfig(Buffer.from(e.before, "base64").toString("utf8"));
      const matches = isDeepStrictEqual(live.profile?.resources, expected.profile?.resources);
      const alreadyRestored = last.state === "pending" && isDeepStrictEqual(live.profile?.resources, original?.profile?.resources);
      if (!matches && !alreadyRestored) throw Error(`undo preserved a file changed by another owner: ${e.path}`);
      const profile = { ...live.profile };
      if (original?.profile?.resources === undefined) delete profile.resources;
      else profile.resources = original.profile.resources;
      const text = renderDevConfig({ ...live, profile }, Buffer.from(current, "base64").toString("utf8"));
      return { ...e, before: current, after: Buffer.from(text).toString("base64") };
    }
    if (current !== e.after && !(last.state === "pending" && current === e.before)) throw Error(`undo preserved a file changed by another owner: ${e.path}`);
    return { ...e, before: current, after: e.before };
  });
}
export function undoResourceEdits(historyPath: string): void {
  const edits = undoResourcePlan(historyPath);
  if (!edits.length) return;
  const release = lockFiles(edits);
  try {
    const history = readResourceHistory(historyPath);
    // Re-check after locking, and retain recovery evidence until every restoration finishes.
    const checked = undoResourcePlan(historyPath);
    history.transactions.at(-1)!.state = "pending"; saveHistory(historyPath, history);
    for (const e of checked) atomic(e.path, e.after, e.mode);
    history.transactions.pop(); saveHistory(historyPath, history);
  } finally { release(); }
}
/** Restore the WSL settings from before explicit choices, preserving later unrelated edits by refusing conflicts. */
export function originalResourceBytes(path: string, historyPath: string): string | null | undefined {
  const transactions = readResourceHistory(historyPath).transactions;
  const edits = transactions.flatMap(t => t.edits.filter(e => e.path === path));
  if (!edits.length) return undefined;
  if (encodedFile(path) !== edits.at(-1)!.after) throw Error(`preserved externally changed WSL configuration: ${path}`);
  return edits[0]!.before;
}
