/**
 * Taking the whole locked workstation back off one machine.
 *
 * src/uninstall.ts already answers "how is one tool removed" by inverting
 * its provider — apt removes what apt installed, a GitHub release is the
 * binary that was placed in /usr/local/bin. This is the other half of the
 * same question for a machine provisioned from a lock: *which* tools, and
 * what else goes with them. The lock is the answer to the first, which is
 * why an uninstall reads it rather than scanning the machine — removing
 * what happens to be there and removing what this project put there are
 * different acts, and only the second is one anybody consented to.
 *
 * The two rules of the single-tool uninstall are the two rules here:
 *
 *  - Nothing runs without the caller naming what will go. `remove` is
 *    injected for the same reason `install` is injected everywhere else
 *    in this area: this module decides *what*, and the caller — a CLI
 *    that has already confirmed, a journey that is rehearsing — decides
 *    how bytes leave the disk.
 *  - Configuration is never removed as a side effect. Everything this
 *    touches is under `~/.red-skills`, and it is enumerated below rather
 *    than swept, so a directory a later ticket puts there for somebody's
 *    choices does not quietly become collateral.
 *
 * ## Why a running Worker holds it
 *
 * ADR 0010's rule for an update that arrives mid-session is to stage and
 * leave the machine on what it is working against. An uninstall has no
 * staged form — there is no "half removed" a Worker could keep running
 * against — so the only version of that rule available here is to refuse
 * and say who is working. Workers are counted through the same call the
 * rollback counts them with, reported, and never signalled.
 *
 * ## Why a failed removal keeps the record
 *
 * The lock and the revision state go last and only when every application
 * the machine had is gone. An uninstall that removed thirteen of fourteen
 * and then deleted the lock would have destroyed the only description of
 * the fourteenth — which is the retry an operator is about to want.
 */

import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  readWorkstationLock,
  workstationLockPath,
  type LockedApp,
  type ObservedTarget,
} from "./workstation-lock.ts";
import { countRunningWorkers } from "./workstation-rollback.ts";

/**
 * Everything under `~/.red-skills` this project owns outright, sorted.
 *
 * One list, because it is the whole of what an uninstall may delete and
 * the whole of what a test can assert went. Entries are named rather
 * than globbed so that adding a file here is a deliberate act with a
 * review attached, which is the only thing standing between this and a
 * recursive delete of somebody's home directory.
 */
export const MACHINE_OWNED_ENTRIES = [
  "cache",
  "current",
  "depots",
  "locks",
  "offline-depot.json",
  "package-set.json",
  "previous",
  "sets",
  "update.json",
  "versions",
  "workstation-lock.json",
  "workstation-revisions.json",
] as const;

/** Removes one locked application from the machine. Whatever the caller uses. */
export type WorkstationRemover = (app: LockedApp) => Promise<{ ok: boolean; detail?: string }>;

export type UninstallOutcome =
  /** Every application the machine had is gone, and so is the state. */
  | "removed"
  /** Some application would not go: the rest did, and the record stayed. */
  | "partial"
  /** There was nothing here: a second uninstall, or a machine never provisioned. */
  | "absent"
  /** Somebody is working. Nothing was removed and nothing was stopped. */
  | "held"
  /** The lock is unreadable, or describes another machine. */
  | "refused";

export interface WorkstationUninstall {
  outcome: UninstallOutcome;
  /** One sentence, always — including on the happy path. */
  reason: string;
  /** `id on surface`, in lock order. */
  removed: string[];
  /** Applications the lock names that this machine did not have. Never a failure. */
  absent: string[];
  failed: { app: string; detail: string }[];
  /** Every machine-owned path removed, in the order it went. Empty when none was. */
  writes: string[];
  /** Workers observed. Counted, reported, and never signalled. */
  workers: number | null;
  /** Zero for `removed` and `absent`; one for the other three. */
  code: number;
}

export interface UninstallOptions {
  home: string;
  /** The machine as it is now, so only what is really there is removed. */
  observed: ObservedTarget;
  remove: WorkstationRemover;
  /** Defaults to asking the daemon over its existing socket. */
  workers?: () => Promise<number | null>;
}

/** Take the locked workstation off this machine. */
export async function uninstallWorkstation(
  opts: UninstallOptions,
): Promise<WorkstationUninstall> {
  const { home } = opts;
  const empty = (
    outcome: UninstallOutcome,
    reason: string,
    workers: number | null = null,
  ): WorkstationUninstall => ({
    outcome,
    reason,
    removed: [],
    absent: [],
    failed: [],
    writes: [],
    workers,
    code: outcome === "removed" || outcome === "absent" ? 0 : 1,
  });

  const held = readWorkstationLock(home);
  if (!held.ok) {
    return held.present
      ? empty("refused", `this machine's workstation lock cannot be read: ${held.reason}`)
      : empty("absent", `${workstationLockPath(home)} is not there: nothing to remove`);
  }
  const { lock } = held;
  if (lock.target.id !== opts.observed.id) {
    return empty(
      "refused",
      `this machine's lock provisions ${lock.target.id}, and it is being uninstalled as ${opts.observed.id}`,
    );
  }

  const workers = await (opts.workers ?? countRunningWorkers)();
  if (workers !== null && workers > 0) {
    return empty(
      "held",
      `${workers} Worker(s) are running: the uninstall is held rather than taking the workstation out from under them`,
      workers,
    );
  }

  const here = new Set(opts.observed.installed.map((app) => `${app.id}:${app.surface}`));
  const removed: string[] = [];
  const absent: string[] = [];
  const failed: { app: string; detail: string }[] = [];
  for (const app of lock.apps) {
    const name = `${app.id} on ${app.surface}`;
    if (!here.has(`${app.id}:${app.surface}`)) {
      absent.push(name);
      continue;
    }
    const outcome = await opts.remove(app);
    if (outcome.ok) removed.push(name);
    else failed.push({ app: name, detail: outcome.detail ?? "removal failed" });
  }

  if (failed.length > 0) {
    return {
      outcome: "partial",
      reason: `${removed.length} application(s) were removed and ${failed.length} would not go; the lock and the revision state stay so the rest can be retried`,
      removed,
      absent,
      failed,
      writes: [],
      workers,
      code: 1,
    };
  }

  const writes = removeMachineOwned(home);
  return {
    outcome: "removed",
    reason: `${removed.length} application(s) and ${writes.length} machine-owned path(s) were removed; nothing outside ${join(home, ".red-skills")} was touched`,
    removed,
    absent,
    failed,
    writes,
    workers,
    code: 0,
  };
}

/**
 * Remove what this project owns under `~/.red-skills`, and nothing else.
 *
 * The lock goes last because it is the description everything above was
 * derived from, and the directory itself goes only when it is empty: a
 * file nobody here put there is a file nobody here may delete.
 */
function removeMachineOwned(home: string): string[] {
  const owned = join(home, ".red-skills");
  const writes: string[] = [];
  const lockFile = "workstation-lock.json";
  const order = [...MACHINE_OWNED_ENTRIES.filter((e) => e !== lockFile), lockFile];
  for (const entry of order) {
    const path = join(owned, entry);
    // `lstat`, not `exists`: `current` and `previous` are symlinks into
    // `sets/`, and one left dangling by an interrupted run is exactly the
    // thing an uninstall is here to clear rather than to walk past.
    if (!present(path)) continue;
    rmSync(path, { recursive: true, force: true });
    writes.push(path);
  }
  if (existsSync(owned) && readdirSync(owned).length === 0) {
    rmSync(owned, { recursive: true, force: true });
    writes.push(owned);
  }
  return writes;
}

/** Whether anything is at this path, including a link to nothing. PURE-ish. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
