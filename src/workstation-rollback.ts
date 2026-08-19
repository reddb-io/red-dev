/**
 * Rollback: the whole workstation, back to the last revision that worked.
 *
 * An update advances four surfaces at once (src/staged-update.ts) and a
 * depot provisions all of them from one medium (src/offline-depot.ts).
 * Neither of them can be undone one surface at a time. Downgrading the
 * package set without downgrading the lock leaves seven coder CLIs from
 * one revision wired against the tree of another; downgrading the lock
 * without the artifacts it names means fetching them, which is exactly
 * what the machine that most needs a rollback — the air-gapped one — is
 * unable to do. So a rollback is one operation over one recorded thing:
 * a **workstation revision**, which is the package set, the exact lock,
 * every application's version, and the local store the artifacts came
 * from, named together and retained together.
 *
 * ## What is recorded, and when
 *
 * Only a verified activation rotates the record. That is the whole of
 * Spec #201's fourth rollback criterion and it is a rule about failure,
 * not about success: an update that half-applied, or one that staged a
 * revision behind a running Worker, must leave the last verified state
 * exactly where it was — still active, still complete, still the thing
 * a rollback restores. A failed run therefore writes its attempt to
 * `pending` and touches neither `active` nor `previous`, and while
 * anything is pending nothing at all is pruned. A rollback whose inputs
 * were collected by the same run that failed would be a rollback to
 * nowhere.
 *
 * ## What a rollback restores, and why it is not always `previous`
 *
 * On a machine whose last activation verified, the thing to restore is
 * the revision behind the active one: `previous`. On a machine with an
 * activation still `pending` it is the active record itself — because
 * the machine has already drifted forward into a revision that did not
 * verify, and the last complete lock it was known to be correct on is
 * the one the record still calls active. Restoring `previous` there
 * would walk past a perfectly good revision to reach an older one whose
 * inputs the newer activation may already have retired.
 *
 * ## Why a rollback does not swap
 *
 * Once a revision has been restored the record does not simply exchange
 * the two — it names the revision the rollback *left* as
 * `rolledBackFrom` and leaves `previous` empty. A second rollback then
 * finds the machine already on the revision a rollback restores and
 * writes nothing, instead of walking back up to the revision somebody
 * has just rejected. Going forward again is an update: it is a
 * decision, and it should have to be typed.
 *
 * ## Nothing here opens a socket
 *
 * Every input a rollback needs is already on the machine: the retained
 * lock under `locks/`, the package-set tree under `sets/`, and the
 * artifacts inside the machine-owned depot copy under `depots/`. The
 * artifact reader is injected for the same reason src/offline-depot.ts
 * injects its installer — a step that decided to fetch would be a step
 * the caller wrote, in a file this one does not import — and the
 * default reader is a `readFileSync` against the depot copy, re-hashed
 * against the lock on the way through.
 *
 * ## Nothing here stops a session
 *
 * The Workers rule of ADR 0010 is a rule about the ground under running
 * work, and a rollback moves the same ground an update does. It is
 * answered the same way and deliberately not by killing anything: the
 * disk is reconciled, every host and companion that cannot observe the
 * change without a fresh process is named in `restartNeeded`, and the
 * Workers this machine is running are counted into the report and
 * otherwise left completely alone. There is no code path here that
 * signals a process.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { redSkillsRoot } from "./red-skills-root.ts";
import { log } from "./log.ts";
import { depotAppPath, readOfflineDepotState, type DepotRevision } from "./offline-depot.ts";
import type { CompanionOutcome } from "./red-skills-companions.ts";
import type { HostOutcome } from "./red-skills-hosts.ts";
import {
  activateRetainedPackageSet,
  formatPackageSetIdentity,
  readPackageSetState,
  redSkillsSetDir,
} from "./red-skills-set.ts";
import {
  companionSurface,
  hostSurface,
  lockSurface,
  readStagedUpdate,
  type SurfaceOutcome,
} from "./staged-update.ts";
import {
  artifactMatches,
  encodeWorkstationLock,
  installFromLock,
  parseWorkstationLock,
  workstationLockPath,
  type LockedApp,
  type LockInstallReport,
  type LockInstaller,
  type ObservedTarget,
  type WorkstationLock,
} from "./workstation-lock.ts";

/**
 * How many complete revisions this machine keeps.
 *
 * Two, for the reason `REDSKILLS_SET_RETENTION` is two: one to be on,
 * one to go back to. A third would be a second rollback nobody asked
 * for, at the cost of a third copy of every artifact on a machine whose
 * whole depot arrived on a USB stick.
 *
 * Not a cap this module applies — the record has exactly two slots for a
 * settled machine, so two is what it structurally holds. The one moment
 * a third is protected is while an activation is `pending`, and that is
 * the failure rule rather than the retention: nothing is pruned at all
 * until something verifies.
 */
export const WORKSTATION_REVISION_RETENTION = 2;

// ---------------------------------------------------------------- the record

/** One application as a revision pinned it. */
export interface RevisionApp {
  id: string;
  surface: string;
  version: string;
}

/**
 * One complete workstation, named once.
 *
 * The package set and the lock digest are the two identities; `apps` is
 * what the lock resolved to, kept alongside because a rollback has to be
 * able to say what it restored without re-reading a lock that may since
 * have been replaced. `depot` is the local artifact store the versions
 * can be reinstalled from, and its absence is the one thing that makes a
 * revision unrestorable offline.
 */
export interface WorkstationRevision {
  /** `<set key>+<lock digest12>` — one name for the whole combination. */
  key: string;
  /** The target this revision provisions. */
  target: string;
  packageSet: DepotRevision;
  lockDigest: string;
  /** The retained copy of the lock, under `~/.red/skills/locks`. */
  lockPath: string;
  /** Every locked application at its exact version, in lock order. */
  apps: RevisionApp[];
  /** The machine-owned depot copy the artifacts live in, or null. */
  depot: string | null;
  /** ISO 8601, from the caller: this module never reads a clock. */
  activatedAt: string;
}

export interface WorkstationRevisionState {
  schema: 1;
  /** The revision this machine resolves, or null before the first one. */
  active: WorkstationRevision | null;
  /** The revision a rollback restores, or null when there is none. */
  previous: WorkstationRevision | null;
  /**
   * The revision the last rollback left behind.
   *
   * Retained and addressable — an operator who rolls back to diagnose
   * something still needs the bytes of what they rolled back from — and
   * deliberately not `previous`, so a second rollback does not undo the
   * first.
   */
  rolledBackFrom: WorkstationRevision | null;
  /**
   * A revision that was attempted and did not verify.
   *
   * Recorded so doctor can say what was attempted, and load-bearing for
   * exactly one thing: while it is non-null nothing is pruned, because
   * the inputs a rollback would need are the ones the failed run was
   * halfway through replacing.
   */
  pending: WorkstationRevision | null;
}

const EMPTY_REVISIONS: WorkstationRevisionState = {
  schema: 1,
  active: null,
  previous: null,
  rolledBackFrom: null,
  pending: null,
};

/** `~/.red/skills/workstation-revisions.json` — the complete revisions held. */
export function workstationRevisionsPath(home: string): string {
  return join(redSkillsRoot(home), "workstation-revisions.json");
}

/** `~/.red/skills/locks/<digest12>.json` — one retained lock, by its digest. */
export function retainedLockPath(home: string, lockDigest: string): string {
  return join(redSkillsRoot(home), "locks", `${lockDigest.slice(0, 12)}.json`);
}

/** The name one complete revision is addressable by. PURE. */
export function workstationRevisionKey(packageSetKey: string, lockDigest: string): string {
  return `${packageSetKey}+${lockDigest.slice(0, 12)}`;
}

/**
 * The recorded revisions, or an empty record.
 *
 * An unreadable record is no record, for the reason `readPackageSetState`
 * treats one that way: the directories under `sets/`, `locks/` and
 * `depots/` are the truth, and the worst this costs is one activation
 * that rewrites a file it could not read. What it must never do is
 * throw — a machine whose rollback record is corrupt is a machine that
 * most needs the rest of doctor to still run.
 */
export function readWorkstationRevisions(home: string): WorkstationRevisionState {
  const path = workstationRevisionsPath(home);
  if (!existsSync(path)) return EMPTY_REVISIONS;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkstationRevisionState>;
    if (parsed?.schema !== 1) return EMPTY_REVISIONS;
    return {
      schema: 1,
      active: parsed.active ?? null,
      previous: parsed.previous ?? null,
      rolledBackFrom: parsed.rolledBackFrom ?? null,
      pending: parsed.pending ?? null,
    };
  } catch {
    return EMPTY_REVISIONS;
  }
}

/** The one encoding the revision record is written in. PURE. */
export function encodeWorkstationRevisions(state: WorkstationRevisionState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/** Write the record, if it differs. Returns the paths written. */
export function writeWorkstationRevisions(
  home: string,
  state: WorkstationRevisionState,
): string[] {
  const desired = encodeWorkstationRevisions(state);
  const path = workstationRevisionsPath(home);
  try {
    if (readFileSync(path, "utf8") === desired) return [];
  } catch {
    // No record yet, or one this build cannot read. Either way it is
    // about to be replaced by one it wrote itself.
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, desired, "utf8");
  return [path];
}

/**
 * One complete revision, described from the two things that identify it.
 * PURE.
 *
 * The lock is read for the versions rather than asked for them later,
 * because "what was on this machine" has to survive the lock being
 * replaced — which is the first thing an update does.
 */
export function describeWorkstationRevision(opts: {
  home: string;
  lock: WorkstationLock;
  packageSet: DepotRevision;
  depot: string | null;
  activatedAt: string;
}): WorkstationRevision {
  return {
    key: workstationRevisionKey(opts.packageSet.key, opts.lock.lockDigest),
    target: opts.lock.target.id,
    packageSet: opts.packageSet,
    lockDigest: opts.lock.lockDigest,
    lockPath: retainedLockPath(opts.home, opts.lock.lockDigest),
    apps: opts.lock.apps.map((app) => ({
      id: app.id,
      surface: app.surface,
      version: app.version,
    })),
    depot: opts.depot,
    activatedAt: opts.activatedAt,
  };
}

/**
 * Keep one lock's bytes under its own digest, and make it the active one.
 *
 * Two writes, both conditional, and both the canonical encoding: the
 * retained copy is what a rollback reads, and `workstation-lock.json` is
 * what everything else on the machine reads. Writing the same bytes
 * twice is what makes the pair cheap to keep honest — a retained lock
 * that had been reformatted would not parse back to its own digest.
 */
export function retainWorkstationLock(home: string, lock: WorkstationLock): string[] {
  const desired = encodeWorkstationLock(lock);
  const writes: string[] = [];
  for (const path of [retainedLockPath(home, lock.lockDigest), workstationLockPath(home)]) {
    let current: string | null;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = null;
    }
    if (current === desired) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, desired, "utf8");
    writes.push(path);
  }
  return writes;
}

// ------------------------------------------------------------ the activation

export interface ActivateRevisionOptions {
  home: string;
  lock: WorkstationLock;
  packageSet: DepotRevision;
  /** The machine-owned depot copy the artifacts came from, or null. */
  depot: string | null;
  /** ISO 8601, from the caller: this module never reads a clock. */
  activatedAt: string;
  /**
   * Whether every surface of this activation verified.
   *
   * False is not an error and is the reason this argument exists: a
   * partial, failed or staged run records what it attempted and rotates
   * nothing, so the revision a rollback restores is still the last one
   * that actually worked.
   */
  verified: boolean;
}

export interface ActivatedRevision {
  revision: WorkstationRevision;
  state: WorkstationRevisionState;
  writes: string[];
  /** What retention removed, which is empty on anything but a verified run. */
  retention: WorkstationRetention;
  /** False when the machine was already recorded as being on this revision. */
  changed: boolean;
}

/**
 * Record one complete revision as this machine's, and retire what that
 * leaves behind.
 *
 * The forward half of the rollback, and the only thing that ever makes a
 * revision restorable: an update or an import that does not pass through
 * here leaves nothing to go back to. The order is the contract — retain
 * the lock, rotate the record, prune what neither retained revision
 * needs — because a prune that ran before the record was written would
 * be deciding what is needed from a record that does not yet name the
 * thing that needs it.
 */
export function activateWorkstationRevision(opts: ActivateRevisionOptions): ActivatedRevision {
  const { home } = opts;
  const revision = describeWorkstationRevision(opts);
  const state = readWorkstationRevisions(home);
  const writes = retainWorkstationLock(home, opts.lock);

  if (!opts.verified) {
    // Attempted and not verified. Nothing rotates, nothing is pruned,
    // and the last verified state is still exactly what it was.
    const desired: WorkstationRevisionState = { ...state, pending: revision };
    writes.push(...writeWorkstationRevisions(home, desired));
    return {
      revision,
      state: desired,
      writes,
      retention: planWorkstationRetention({ home, verified: false }),
      changed: writes.length > 0,
    };
  }

  const already = state.active?.key === revision.key;
  const desired: WorkstationRevisionState = already
    ? { ...state, active: revision, pending: null }
    : {
        schema: 1,
        active: revision,
        previous: state.active,
        // Cleared on the way forward: the revision a rollback left is
        // only interesting until the machine has moved on from it.
        rolledBackFrom: null,
        pending: null,
      };
  writes.push(...writeWorkstationRevisions(home, desired));

  const retention = applyWorkstationRetention({ home, verified: true });
  writes.push(...retention.removed.map((entry) => entry.path));
  return { revision, state: desired, writes, retention: retention.plan, changed: writes.length > 0 };
}

// ------------------------------------------------------------- the retention

export type RetentionKind = "package-set" | "lock" | "depot";

/** One derived path, and whether anything still needs it. */
export interface RetentionEntry {
  path: string;
  kind: RetentionKind;
  /** The revision keys that require it. Empty exactly when prunable. */
  requiredBy: string[];
}

export interface WorkstationRetention {
  /** The revisions the record names, newest first. */
  revisions: WorkstationRevision[];
  /** Everything a retained revision requires, and therefore stays. */
  kept: RetentionEntry[];
  /** Everything past the retention. Empty while anything holds it. */
  prunable: RetentionEntry[];
  /**
   * Why nothing may be pruned right now, or null.
   *
   * Never a failure: the ordinary machine holding a prune is one whose
   * last update is still waiting on a Worker, and reporting that as a
   * problem would make every held update look like a broken one.
   */
  held: string | null;
}

export interface RetentionOptions {
  home: string;
  /**
   * Whether the state was left by an activation that verified.
   *
   * Defaults to the last staged update's verdict, so an ordinary caller
   * does not have to know the rule and cannot get it wrong: `converged`
   * verified, and `partial`, `failed` and `staged` did not.
   */
  verified?: boolean;
}

/**
 * The revisions retention protects, newest first. PURE.
 *
 * `previous` and `rolledBackFrom` are the same slot seen from the two
 * directions a machine can have moved, and only one of them is ever
 * non-null, so this is two revisions in practice and never three.
 * `pending` is included because an activation that has not verified must
 * not have its own inputs pruned out from under a retry.
 */
export function retainedRevisions(state: WorkstationRevisionState): WorkstationRevision[] {
  const out: WorkstationRevision[] = [];
  for (const revision of [state.active, state.previous, state.rolledBackFrom, state.pending]) {
    if (revision === null) continue;
    if (out.some((kept) => kept.key === revision.key)) continue;
    out.push(revision);
  }
  return out;
}

/**
 * The revision a rollback would restore right now, or null. PURE.
 *
 * Two answers, and the header says why: `previous` on a machine whose
 * last activation verified, and `active` on one still carrying a pending
 * activation, because there the record's active revision *is* the last
 * complete lock that worked.
 */
export function rollbackTarget(state: WorkstationRevisionState): WorkstationRevision | null {
  return state.pending !== null ? state.active : state.previous;
}

/**
 * What this machine may drop, and what it may not.
 *
 * Three families of derived state, and the answer is the same shape for
 * all three: a path is kept when a retained revision names it, and
 * prunable when none does. The package-set trees are also retained by
 * src/red-skills-set.ts under its own policy, and both are consulted —
 * two owners of one directory must agree to remove it, never just one.
 */
export function planWorkstationRetention(opts: RetentionOptions): WorkstationRetention {
  const { home } = opts;
  const state = readWorkstationRevisions(home);
  const revisions = retainedRevisions(state);

  // The set state's own retention, folded in as a protection rather than
  // as a second policy: a tree it still names is one the machine can
  // still resolve through, whatever this record says.
  const setState = readPackageSetState(home);
  const setKeys = new Map<string, string[]>();
  const need = (path: string, key: string): void => {
    const already = setKeys.get(path) ?? [];
    if (!already.includes(key)) already.push(key);
    setKeys.set(path, already);
  };
  for (const revision of setState.revisions) need(revision.path, "package-set state");
  if (setState.staged !== null) need(setState.staged.path, "package-set state");

  const locks = new Map<string, string[]>();
  const depots = new Map<string, string[]>();
  // The depot this machine says it was provisioned from, folded in the
  // same way the set state is: doctor reports it by path, and a prune
  // that removed it would turn a healthy air-gapped workstation red for
  // having tidied up after itself.
  const importedDepot = readOfflineDepotState(home).imported?.path;
  if (importedDepot !== undefined) depots.set(importedDepot, ["offline depot state"]);
  for (const revision of revisions) {
    need(redSkillsSetDir(home, revision.packageSet.key), revision.key);
    const lock = locks.get(revision.lockPath) ?? [];
    if (!lock.includes(revision.key)) lock.push(revision.key);
    locks.set(revision.lockPath, lock);
    if (revision.depot === null) continue;
    const depot = depots.get(revision.depot) ?? [];
    if (!depot.includes(revision.key)) depot.push(revision.key);
    depots.set(revision.depot, depot);
  }

  const kept: RetentionEntry[] = [];
  const prunable: RetentionEntry[] = [];
  const sort = (entries: RetentionEntry[]): RetentionEntry[] =>
    entries.sort((a, b) => a.path.localeCompare(b.path));

  const sweep = (dir: string, kind: RetentionKind, required: Map<string, string[]>): void => {
    for (const name of listing(dir)) {
      const path = join(dir, name);
      const by = required.get(path) ?? [];
      (by.length > 0 ? kept : prunable).push({ path, kind, requiredBy: by });
    }
  };
  sweep(join(redSkillsRoot(home), "sets"), "package-set", setKeys);
  sweep(join(redSkillsRoot(home), "locks"), "lock", locks);
  sweep(join(redSkillsRoot(home), "depots"), "depot", depots);

  return {
    revisions,
    kept: sort(kept),
    prunable: sort(prunable),
    held: retentionHold(home, state, opts.verified),
  };
}

/**
 * Why a prune is being held back, or null.
 *
 * The order is the order of severity, and every one of them means the
 * same thing: something on this machine is between two revisions, and
 * the paths a prune would take are the ones a retry or a rollback would
 * read.
 */
function retentionHold(
  home: string,
  state: WorkstationRevisionState,
  verified: boolean | undefined,
): string | null {
  if (state.active === null) return "no complete revision has been activated on this machine";
  if (state.pending !== null) {
    return `an activation of ${state.pending.key} did not verify and is still pending`;
  }
  const decided = verified ?? lastUpdateVerified(home);
  if (!decided) return "the last update did not verify every surface";
  return null;
}

/** Whether the last staged update reached every surface. */
function lastUpdateVerified(home: string): boolean {
  const record = readStagedUpdate(home);
  // No record at all is not a failed update: it is a machine provisioned
  // from a depot, which has never run one.
  return record === null || record.outcome === "converged";
}

export interface AppliedRetention {
  plan: WorkstationRetention;
  /** What actually went. A path that could not be removed is not in here. */
  removed: RetentionEntry[];
}

/**
 * Remove what the plan says is past the retention, and nothing else.
 *
 * A held plan removes nothing at all, which is the fourth rollback
 * criterion in one line. An entry that will not delete is dropped from
 * the report rather than thrown, for the reason the legacy sweep drops
 * one: this runs unattended at the end of an update, and one locked
 * directory is not a reason to fail an activation that worked.
 */
export function applyWorkstationRetention(opts: RetentionOptions): AppliedRetention {
  const plan = planWorkstationRetention(opts);
  if (plan.held !== null) return { plan, removed: [] };

  const removed: RetentionEntry[] = [];
  for (const entry of plan.prunable) {
    try {
      rmSync(entry.path, { recursive: true, force: true });
    } catch {
      continue;
    }
    if (existsSync(entry.path)) continue;
    removed.push(entry);
  }
  return { plan, removed };
}

// -------------------------------------------------------------- the rollback

export type RollbackFailure =
  /** Nothing behind the active revision. */
  | "empty"
  /** The retained lock is gone, unreadable, or not the lock it claims. */
  | "lock"
  /** The package-set tree the revision names is no longer addressable. */
  | "package-set"
  /** No local artifact store, so restoring would need the network. */
  | "artifacts"
  /** The lock was restorable and one or more applications would not install. */
  | "install";

export type RollbackOutcome =
  /** The machine was moved back onto the previous complete revision. */
  | "restored"
  /** It was already on it: a second rollback, and nothing to do. */
  | "converged"
  /** Restored, with at least one surface left unconverged. */
  | "partial"
  /** Nothing was done, and the reason says why. */
  | "refused";

export interface WorkstationRollback {
  outcome: RollbackOutcome;
  /** One sentence, always — including on the happy path. */
  reason: string;
  failure: RollbackFailure | null;
  /** The revision this machine is on once this returns, or null. */
  restored: WorkstationRevision | null;
  /** The revision it was on before, or null when nothing moved. */
  from: WorkstationRevision | null;
  /** The lock install, in the vocabulary an update speaks. */
  install: LockInstallReport | null;
  /** Hosts, companions and the lock, as a staged update reports them. */
  surfaces: SurfaceOutcome[];
  /** Everything reconciled on disk that a fresh process has to observe. */
  restartNeeded: string[];
  /** Workers observed. Counted, reported, and never signalled. */
  workers: number | null;
  retention: WorkstationRetention;
  /** Every path written or removed. Empty on a second rollback. */
  writes: string[];
  /** Zero for `restored` and `converged`; one for the other two. */
  code: number;
}

/** Reads one locked application's exact bytes from local storage. */
export type ArtifactReader = (app: LockedApp) => Buffer | null;

export interface RollbackOptions {
  home: string;
  /** The machine as it is now, so the plan knows what has to change. */
  observed: ObservedTarget;
  /** Puts one application back, from bytes this machine already holds. */
  install: (
    step: Parameters<LockInstaller>[0],
    artifact: { path: string; bytes: Buffer },
  ) => Promise<{ ok: boolean; detail?: string }>;
  /**
   * The bytes of one locked application. Defaults to the machine-owned
   * depot copy the revision was provisioned from — which is the whole of
   * "no network request": there is no other source to read.
   */
  artifacts?: ArtifactReader;
  /** Reconciles hosts and companions. Defaults to red-dev's own converge. */
  converge?: () => Promise<{ hosts: HostOutcome[]; companions: CompanionOutcome[] }>;
  /**
   * Active Workers on this machine. Defaults to asking the daemon over
   * its existing socket. Never used to refuse and never used to stop
   * anything: it is reported so that a person reading a rollback knows
   * which sessions are still on the revision that was rolled back.
   */
  workers?: () => Promise<number | null>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** ISO 8601, from the caller: this module never reads a clock. */
  at: string;
}

/**
 * Put the whole workstation back on the previous complete revision.
 *
 * The order is the order of dependency and the order of reversibility:
 * everything refusable is refused before a byte moves, then the package
 * set, then the applications the lock names, then the hosts and
 * companions built out of both, then the lock file itself, and only
 * then the record and the prune. A rollback that had already replaced
 * half the applications when it discovered its package-set tree was
 * gone would have left the machine on neither revision.
 */
export async function rollbackWorkstation(
  opts: RollbackOptions,
): Promise<WorkstationRollback> {
  const { home } = opts;
  const state = readWorkstationRevisions(home);
  const workers = await (opts.workers ?? defaultWorkers)();

  const empty = (
    outcome: RollbackOutcome,
    reason: string,
    failure: RollbackFailure | null,
    restored: WorkstationRevision | null = null,
  ): WorkstationRollback => ({
    outcome,
    reason,
    failure,
    restored,
    from: null,
    install: null,
    surfaces: [],
    restartNeeded: [],
    workers,
    retention: planWorkstationRetention({ home }),
    writes: [],
    code: outcome === "restored" || outcome === "converged" ? 0 : 1,
  });

  const target = rollbackTarget(state);
  if (target === null) {
    // Already rolled back is not the same fact as never having had
    // anywhere to go, and the two exits are different because the
    // operator's next move is different.
    if (state.rolledBackFrom !== null && state.active !== null) {
      return empty(
        "converged",
        `this machine is already on ${state.active.key}, rolled back from ${state.rolledBackFrom.key} — going forward again is an update`,
        null,
        state.active,
      );
    }
    return empty(
      "refused",
      "this machine holds no previous complete revision to roll back to",
      "empty",
    );
  }

  const lock = readRetainedLock(target);
  if (!lock.ok) return empty("refused", lock.reason, "lock");

  const setDir = redSkillsSetDir(home, target.packageSet.key);
  if (!existsSync(setDir)) {
    return empty(
      "refused",
      `the package-set tree for ${formatPackageSetIdentity(target.packageSet)} is recorded at ${setDir} and is no longer there`,
      "package-set",
    );
  }

  const read = opts.artifacts ?? depotArtifacts(target);
  if (read === null) {
    return empty(
      "refused",
      `${target.key} names no local artifact store, and restoring its applications would have to reach the network`,
      "artifacts",
    );
  }

  // -------------------------------------------------------------- the moves
  const writes: string[] = [];
  const surfaces: SurfaceOutcome[] = [];

  // The package set first: the hosts and companions below are built out
  // of the tree it points `current` at, and reconciling them against the
  // revision that is on its way out would wire them twice.
  const activated = activateRetainedPackageSet(target.packageSet.key, {
    home,
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  if (activated === null) {
    return empty(
      "refused",
      `this machine does not retain package set ${target.packageSet.key}`,
      "package-set",
    );
  }
  if (activated.refused !== null) {
    return empty("refused", activated.refused.reason, "package-set");
  }
  writes.push(...activated.writes);

  // Every application the lock names, from bytes that are already here
  // and re-hashed against the lock on the way through. An artifact that
  // does not hash is this one application's failure, never the whole
  // rollback's: the machine is already on the restored package set, and
  // thirteen of fourteen applications restored is thirteen applications
  // of good.
  const installer: LockInstaller = async (step) => {
    const bytes = read(step.app);
    if (bytes === null) {
      return { ok: false, detail: `no local copy of ${step.app.artifact.name}` };
    }
    if (!artifactMatches(step.app, bytes)) {
      return { ok: false, detail: `${step.app.artifact.name} does not hash to the locked checksum` };
    }
    return opts.install(step, { path: localArtifactPath(target, step.app), bytes });
  };
  const installed = await installFromLock(lock.lock, opts.observed, installer);
  if (!installed.ok) return empty("refused", installed.reason, "install");
  surfaces.push(lockSurface({ ok: true, report: installed.report }));

  // The hosts and companions, rebuilt against the restored tree. Neither
  // adapter terminates anything; what they cannot change under a running
  // process they report, and it is carried up into `restartNeeded`.
  const converged = await (opts.converge ?? defaultConverge())();
  surfaces.unshift(companionSurface(converged.companions));
  surfaces.unshift(hostSurface(converged.hosts));

  // The lock file last of the moves, because it is the machine's answer
  // to "what am I provisioned against" and it should not say the old
  // revision while the applications are still being put back.
  writes.push(...retainWorkstationLock(home, lock.lock));

  // ------------------------------------------------------------- the record
  const restored: WorkstationRevision = { ...target, activatedAt: opts.at };
  // What this rollback left, which is the pending activation on a
  // machine that had drifted forward and the active record otherwise.
  const left = state.pending ?? state.active;
  const desired: WorkstationRevisionState =
    state.pending === null
      ? {
          schema: 1,
          active: restored,
          // Deliberately empty: see the header. The revision this
          // rollback left is retained and named, and it is not a
          // rollback target.
          previous: null,
          rolledBackFrom: left,
          pending: null,
        }
      : {
          // A repair rather than a step back: the record already called
          // this revision active and the machine has been put back onto
          // it, so nothing rotates. What is dropped is the activation
          // that did not verify, which is now a thing that happened
          // rather than a thing that is owed.
          schema: 1,
          active: restored,
          previous: state.previous,
          rolledBackFrom: left,
          pending: null,
        };
  writes.push(...writeWorkstationRevisions(home, desired));

  const failedSurfaces = surfaces.filter((s) => s.state === "failed");
  const verified = failedSurfaces.length === 0 && installed.report.failed.length === 0;
  const retention = applyWorkstationRetention({ home, verified });
  writes.push(...retention.removed.map((entry) => entry.path));

  const restartNeeded = [...new Set(surfaces.flatMap((s) => s.restartNeeded))];
  const outcome: RollbackOutcome = !verified
    ? "partial"
    : writes.length === 0 && installed.report.installed.length === 0
      ? "converged"
      : "restored";
  const reason = verified
    ? outcome === "converged"
      ? `this machine was already on ${restored.key}`
      : `restored ${restored.key} from ${left?.key ?? "an unrecorded revision"} — ${installed.report.installed.length} application(s) put back, no network request`
    : `restored ${restored.key} with ${installed.report.failed.length} application(s) and ${failedSurfaces.length} surface(s) unconverged`;

  announce({ outcome, reason, surfaces, restartNeeded, workers });

  return {
    outcome,
    reason,
    failure: verified ? null : "install",
    restored,
    from: left,
    install: installed.report,
    surfaces,
    restartNeeded,
    workers,
    retention: retention.plan,
    writes,
    code: verified ? 0 : 1,
  };
}

/** One line per surface, in the voice the rest of a converge speaks. */
function announce(
  run: Pick<WorkstationRollback, "outcome" | "reason" | "surfaces" | "restartNeeded" | "workers">,
): void {
  for (const surface of run.surfaces) {
    const line = `${surface.surface}: ${surface.reason}`;
    if (surface.state === "failed") log.err(line);
    else if (surface.state === "verified") log.ok(line);
    else log.skip(line);
  }
  if (run.outcome === "partial") log.err(run.reason);
  else log.ok(run.reason);
  if (run.restartNeeded.length > 0) {
    // Said once, at the end, and never as a failure: the disk is on the
    // restored revision and every running process was left alone.
    log.warn(`restart needed to load the restored revision: ${run.restartNeeded.join(", ")}`);
  }
  if ((run.workers ?? 0) > 0) {
    log.warn(
      `${run.workers} Worker(s) are running and were not interrupted — they keep the revision they started with`,
    );
  }
}

/**
 * The retained lock a revision names, or why it cannot be used.
 *
 * Re-parsed and re-checked against the digest the record claims, rather
 * than trusted because the record named it. The retained copy is the one
 * input a rollback cannot verify against anything else, so the digest is
 * the whole of its integrity.
 */
function readRetainedLock(
  revision: WorkstationRevision,
): { ok: true; lock: WorkstationLock } | { ok: false; reason: string } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(revision.lockPath);
  } catch {
    return {
      ok: false,
      reason: `the lock ${revision.lockDigest.slice(0, 12)} for ${revision.key} is not retained at ${revision.lockPath}`,
    };
  }
  const parsed = parseWorkstationLock(bytes);
  if (!parsed.ok) return { ok: false, reason: `the retained lock for ${revision.key}: ${parsed.reason}` };
  if (parsed.lock.lockDigest !== revision.lockDigest) {
    return { ok: false, reason: `the retained lock at ${revision.lockPath} is not the lock ${revision.key} names` };
  }
  return { ok: true, lock: parsed.lock };
}

/** Where one application's bytes sit inside a revision's depot copy. */
function localArtifactPath(revision: WorkstationRevision, app: LockedApp): string {
  return join(revision.depot ?? "", depotAppPath(app));
}

/**
 * The default artifact reader: the revision's own depot copy, and
 * nothing else.
 *
 * `null` when the revision was not provisioned from a depot, which the
 * caller turns into a refusal rather than a fetch. A machine that was
 * provisioned over the network can still be rolled back — by handing in
 * a reader — and this module will not invent one that opens a socket.
 */
function depotArtifacts(revision: WorkstationRevision): ArtifactReader | null {
  if (revision.depot === null || !existsSync(revision.depot)) return null;
  return (app) => {
    try {
      return readFileSync(localArtifactPath(revision, app));
    } catch {
      return null;
    }
  };
}

function defaultConverge(): () => Promise<{
  hosts: HostOutcome[];
  companions: CompanionOutcome[];
}> {
  return async () => {
    const { convergeRedSkills } = await import("./agents.ts");
    const { detect } = await import("./platform.ts");
    return await convergeRedSkills(detect());
  };
}

/** Active Workers, over the daemon's existing socket and never a new one. */
async function defaultWorkers(): Promise<number | null> {
  const { readHostInventoryNoStart } = await import("./host-state.ts");
  const inventory = await readHostInventoryNoStart();
  return inventory === null ? null : inventory.workers.length;
}

function listing(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

// --------------------------------------------------------------- the report

export interface RollbackDoctorReport {
  /** The revision this machine is on, or null. */
  active: WorkstationRevision | null;
  /** The revision behind the active one, or null. */
  previous: WorkstationRevision | null;
  /** The revision a rollback would restore right now, or null. */
  restores: WorkstationRevision | null;
  /** The revision the last rollback left behind, or null. */
  rolledBackFrom: WorkstationRevision | null;
  /** An activation that did not verify, or null. */
  pending: WorkstationRevision | null;
  retention: WorkstationRetention;
  /** False when a retained revision's tree, lock or depot is gone. */
  restorable: boolean;
  /** What is missing behind an unrestorable rollback, in the order found. */
  missing: string[];
}

/**
 * What doctor says about rollback and retention, as data.
 *
 * The two facts the criteria ask for are here in one shape, because they
 * are one fact: the lock identity says what this machine is provisioned
 * against, and the retention says whether the thing it could go back to
 * is still on disk. Reporting either without the other is how a machine
 * ends up confidently naming a rollback target whose bytes were pruned.
 */
export function workstationRollbackReport(home: string): RollbackDoctorReport {
  const state = readWorkstationRevisions(home);
  const retention = planWorkstationRetention({ home });
  const missing: string[] = [];
  const target = rollbackTarget(state);
  if (target !== null) {
    if (!existsSync(target.lockPath)) missing.push(`the retained lock at ${target.lockPath}`);
    const setDir = redSkillsSetDir(home, target.packageSet.key);
    if (!existsSync(setDir)) missing.push(`the package-set tree at ${setDir}`);
    if (target.depot === null) missing.push("a local artifact store for its applications");
    else if (!existsSync(target.depot)) missing.push(`the depot copy at ${target.depot}`);
  }
  return {
    active: state.active,
    previous: state.previous,
    restores: target,
    rolledBackFrom: state.rolledBackFrom,
    pending: state.pending,
    retention,
    restorable: target !== null && missing.length === 0,
    missing,
  };
}

export interface RollbackDoctorRow {
  status: "ok" | "warn" | "err" | "n/a";
  detail: string;
}

/** The report as the lines `red-dev doctor` prints. PURE. */
export function workstationRollbackRows(report: RollbackDoctorReport): RollbackDoctorRow[] {
  const rows: RollbackDoctorRow[] = [];
  if (report.active === null) {
    return [{ status: "n/a", detail: "no complete workstation revision has been activated here" }];
  }

  const active = report.active;
  rows.push({
    status: "ok",
    detail:
      `workstation revision ${active.key} for ${active.target} — package set ${active.packageSet.key}, ` +
      `lock ${active.lockDigest.slice(0, 12)} over ${active.apps.length} exact versions, activated ${active.activatedAt}`,
  });

  if (report.restores !== null) {
    rows.push(
      report.restorable
        ? {
            status: "ok",
            detail: `a rollback restores ${report.restores.key} — package set ${report.restores.packageSet.key} and lock ${report.restores.lockDigest.slice(0, 12)}, all of it on disk`,
          }
        : {
            status: "err",
            detail: `a rollback to ${report.restores.key} cannot be performed: ${report.missing.join(", ")} is gone`,
          },
    );
  } else if (report.rolledBackFrom !== null) {
    rows.push({
      status: "warn",
      detail: `this machine was rolled back from ${report.rolledBackFrom.key}, which is retained — going forward again is an update`,
    });
  } else {
    rows.push({
      status: "n/a",
      detail: "this machine holds one complete revision, so there is nothing to roll back to",
    });
  }

  if (report.pending !== null) {
    rows.push({
      status: "warn",
      detail: `an activation of ${report.pending.key} did not verify — the last verified revision is still active and nothing has been pruned`,
    });
  }

  const counted = (kind: RetentionKind): number =>
    report.retention.kept.filter((entry) => entry.kind === kind).length;
  rows.push({
    status: "ok",
    detail:
      `retention holds ${report.retention.revisions.length} complete revision(s): ` +
      `${counted("package-set")} package-set snapshot(s), ${counted("lock")} lock(s), ${counted("depot")} depot cop(y|ies)`,
  });
  if (report.retention.prunable.length > 0) {
    rows.push({
      status: report.retention.held === null ? "warn" : "n/a",
      detail:
        report.retention.held === null
          ? `${report.retention.prunable.length} derived path(s) are past the retention and will go on the next activation`
          : `${report.retention.prunable.length} derived path(s) are held: ${report.retention.held}`,
    });
  }
  return rows;
}
