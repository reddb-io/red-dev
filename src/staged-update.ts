/**
 * One staged reconciliation across every surface an update advances.
 *
 * `red-dev update` and `mise upgrade red-skills` both mean the same
 * thing: put this workstation on one revision. That revision is not one
 * artifact — it is the package set, the seven coder hosts wired against
 * it, the companions built out of it, and the exact workstation lock
 * every external application is pinned by. Four surfaces, four different
 * mechanisms, no shared transaction between any of them.
 *
 * ## Truthful, not falsely transactional
 *
 * ADR 0010 settles what to do about that. Every chosen surface must
 * converge before the operation succeeds, and **a failed surface does
 * not roll back the ones that already verified**. There is no cross-host
 * transaction to be had — the plugin managers, the marketplaces and the
 * editor CLIs offer none — so pretending otherwise would mean uninstall-
 * ing six good hosts because the seventh refused, at the cost of a
 * machine that ends up worse than it started. Instead the run answers
 * with failure and says exactly which side of the line each surface
 * ended on, so the state is visible and the retry is cheap: everything
 * verified is already converged, and only the failure is re-attempted.
 *
 * ## The Workers rule
 *
 * The one thing an update may never do is move the ground under work
 * that is already running. Two rules follow, and this module is where
 * they meet:
 *
 *   - **Running coder sessions are never terminated.** A host whose CLI
 *     is running is reconciled on disk and reported `restart needed`;
 *     the session keeps the revision it started with until somebody
 *     opens a fresh one. That decision lives in the host and companion
 *     adapters, which observe it; this module carries it up into the
 *     report so a person is told once, at the end, what a restart is
 *     owed.
 *   - **Active Workers hold the activation.** With a Worker running,
 *     acquisition still completes — the revision is fetched, verified
 *     and staged under its immutable name — and nothing else happens at
 *     all. `current`, the daemon, the hosts and the companions stay on
 *     the lock the Worker is working against, the complete new revision
 *     stays staged and pending, and the run reports `staged` rather
 *     than success or failure. The next run that finds no Worker
 *     activates what is already on disk, acquiring nothing.
 *
 * ## Why the walk is data and the surfaces are injected
 *
 * The same reason src/update-order.ts is: the order and the rules are
 * the load-bearing part, and they are worth pinning without a machine
 * that has seven coder CLIs, a daemon and a resolved lock on it. Each
 * surface is a producer returning the vocabulary its own module already
 * speaks, and the translation into one shared verdict is pure.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import type { Acquisition } from "./red-skills-acquire.ts";
import type { CompanionOutcome } from "./red-skills-companions.ts";
import type { HostOutcome } from "./red-skills-hosts.ts";
import { readPackageSetState, type PackageSetIdentity } from "./red-skills-set.ts";
import type { LockInstallReport } from "./workstation-lock.ts";

/** The surfaces one revision has to reach, in the order it reaches them. */
export const UPDATE_SURFACES = ["acquisition", "hosts", "companions", "lock"] as const;

export type UpdateSurface = (typeof UPDATE_SURFACES)[number];

/**
 * Where one surface ended.
 *
 * `verified` covers both "this run converged it" and "it was already
 * converged": the question a surface answers is whether the machine is
 * on the revision, not whether work was done to get it there.
 *
 * `skipped` is the honest word for a surface this machine does not have
 * — no coder CLI installed, no lock resolved — and is deliberately not
 * `verified`: a report that counted an absent surface as converged
 * would claim a guarantee nothing checked.
 */
export type SurfaceState = "verified" | "failed" | "pending" | "skipped";

export interface SurfaceOutcome {
  surface: UpdateSurface;
  state: SurfaceState;
  /** One sentence saying why, always — including on the happy path. */
  reason: string;
  /**
   * What was reconciled on disk and will only be observed by a fresh
   * session. Empty on every surface that has no such notion.
   */
  restartNeeded: string[];
}

/**
 * The verdict of one run.
 *
 * `staged` is not a failure and not a success: the revision is on the
 * machine, verified and complete, and the activation is deliberately
 * owed to a later run. Reporting it as either of the other two would
 * make an operator either chase a problem that does not exist or
 * believe an activation that has not happened.
 */
export const UPDATE_OUTCOMES = ["converged", "partial", "failed", "staged"] as const;

export type UpdateOutcome = (typeof UPDATE_OUTCOMES)[number];

export interface StagedUpdate {
  outcome: UpdateOutcome;
  surfaces: SurfaceOutcome[];
  /** The identity `current` names once this returns, or null. */
  active: PackageSetIdentity | null;
  /** The complete revision staged and pending activation, or null. */
  staged: PackageSetIdentity | null;
  /** Every host and companion owed a restart, across all surfaces. */
  restartNeeded: string[];
  /** Active Workers observed, or null when the daemon could not be asked. */
  workers: number | null;
  /** Zero for `converged` and `staged`; one for everything else. */
  code: number;
}

// ------------------------------------------------------- the translations

/**
 * The acquisition, as one surface. PURE.
 *
 * `unreachable` is not a failure and this is the one place that has to
 * say so out loud: a laptop on a train cannot read the remote, and the
 * update it runs changes nothing while leaving the machine on the set it
 * already resolves. Recording that as a failed surface would make every
 * offline update report a broken workstation.
 */
export function acquisitionSurface(a: Acquisition): SurfaceOutcome {
  const state: SurfaceState =
    a.outcome === "refused" ? "failed" : a.outcome === "unavailable" ? "skipped" : "verified";
  return { surface: "acquisition", state, reason: a.reason, restartNeeded: [] };
}

/**
 * The seven hosts, as one surface. PURE.
 *
 * `blocked` and `failed` are the two ways a host does not converge, and
 * both fail the surface. Everything else is a host that is on the
 * revision — including `absent`, which is a host this machine does not
 * have rather than one it could not wire.
 *
 * The restart list is the whole visible half of "running sessions are
 * never terminated": a host reported here was reconciled on disk with
 * its process left alone, and the only thing standing between it and
 * the new revision is a session nobody has opened yet.
 */
export function hostSurface(outcomes: readonly HostOutcome[]): SurfaceOutcome {
  const stuck = outcomes.filter((o) => o.status === "blocked" || o.status === "failed");
  const restartNeeded = outcomes.filter((o) => o.reload === "restart-needed").map((o) => o.host);
  if (outcomes.length === 0) {
    return {
      surface: "hosts",
      state: "skipped",
      reason: "no coding agent is installed to reconcile",
      restartNeeded,
    };
  }
  if (stuck.length > 0) {
    return {
      surface: "hosts",
      state: "failed",
      reason: `not reconciled into ${stuck.map((o) => `${o.host} (${o.reason ?? "no reason given"})`).join(", ")}`,
      restartNeeded,
    };
  }
  return {
    surface: "hosts",
    state: "verified",
    reason: `${outcomes.filter((o) => o.status !== "absent").length} host(s) on the active revision`,
    restartNeeded,
  };
}

/**
 * The companions, as one surface. PURE.
 *
 * `unavailable` is not a failure, for the reason the companion module
 * gives: a set published before an artifact was part of it is not a
 * broken machine, and the remedy is a newer set rather than a retry.
 */
export function companionSurface(outcomes: readonly CompanionOutcome[]): SurfaceOutcome {
  const stuck = outcomes.filter((o) => o.status === "blocked" || o.status === "failed");
  const restartNeeded = outcomes
    .filter((o) => o.reload === "restart-needed")
    .map((o) => o.companion as string);
  if (outcomes.length === 0) {
    return {
      surface: "companions",
      state: "skipped",
      reason: "no package set to build the companions out of",
      restartNeeded,
    };
  }
  if (stuck.length > 0) {
    return {
      surface: "companions",
      state: "failed",
      reason: `not converged: ${stuck.map((o) => `${o.companion} (${o.reason ?? "no reason given"})`).join(", ")}`,
      restartNeeded,
    };
  }
  return {
    surface: "companions",
    state: "verified",
    reason: `${outcomes.filter((o) => o.status !== "absent").length} companion(s) on the active revision`,
    restartNeeded,
  };
}

/** What the lock surface reports back: a run of it, or why there was none. */
export type LockResult =
  | { ok: true; report: LockInstallReport }
  | { ok: false; present: boolean; reason: string };

/**
 * The exact workstation lock, as one surface. PURE.
 *
 * A machine with no lock resolved yet is `skipped` rather than failed —
 * that is every machine before its first depot import, and an update
 * that reported it as broken would be reporting the ordinary case. A
 * lock that is present and unusable is a failure, because somebody put
 * it there and it does not describe this machine.
 */
export function lockSurface(result: LockResult): SurfaceOutcome {
  if (!result.ok) {
    return {
      surface: "lock",
      state: result.present ? "failed" : "skipped",
      reason: result.reason,
      restartNeeded: [],
    };
  }
  const { report } = result;
  if (report.failed.length > 0) {
    return {
      surface: "lock",
      state: "failed",
      reason: `${report.target}: ${report.failed.map((f) => `${f.app} (${f.detail})`).join(", ")}`,
      restartNeeded: [],
    };
  }
  const total = report.installed.length + report.present.length;
  return {
    surface: "lock",
    state: "verified",
    reason:
      `${report.target}: ${total} application(s) at the locked version` +
      (report.unconfigured.length > 0
        ? `, ${report.unconfigured.length} awaiting a cloud identity`
        : ""),
    restartNeeded: [],
  };
}

/** A surface held back because a Worker is using the active revision. PURE. */
export function pendingSurface(surface: UpdateSurface, workers: number): SurfaceOutcome {
  return {
    surface,
    state: "pending",
    reason: `held on the active lock: ${workers} Worker(s) are running`,
    restartNeeded: [],
  };
}

/**
 * The one verdict the surfaces add up to. PURE.
 *
 * `partial` earns its own word rather than collapsing into `failed`:
 * they are the same exit code and a completely different machine. A
 * partial run left some surfaces on the new revision, and the operator
 * reading it needs to know that retrying will not start from nothing.
 */
export function stagedUpdateOutcome(surfaces: readonly SurfaceOutcome[]): UpdateOutcome {
  const failed = surfaces.some((s) => s.state === "failed");
  const verified = surfaces.some((s) => s.state === "verified");
  if (failed) return verified ? "partial" : "failed";
  if (surfaces.some((s) => s.state === "pending")) return "staged";
  return "converged";
}

// ------------------------------------------------------------- the record

export interface StagedUpdateRecord {
  schema: 1;
  outcome: UpdateOutcome;
  surfaces: SurfaceOutcome[];
  /** Active Workers when the run started, or null when unknown. */
  workers: number | null;
}

/** `~/.red-skills/update.json` — how the last staged reconciliation ended. */
export function stagedUpdatePath(home: string): string {
  return join(home, ".red-skills", "update.json");
}

/**
 * The last run's record, or null.
 *
 * Recorded rather than re-derived because two of the states doctor has
 * to report cannot be observed after the fact. `pending` is a decision
 * this run made about surfaces it deliberately did not touch — nothing
 * on disk distinguishes a companion held back from one that was never
 * asked — and `partial` is a relation between surfaces rather than a
 * property of any one of them. An unreadable record is no record, for
 * the same reason an unreadable package-set state is no state.
 */
export function readStagedUpdate(home: string): StagedUpdateRecord | null {
  const path = stagedUpdatePath(home);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StagedUpdateRecord>;
    if (parsed?.schema !== 1 || !Array.isArray(parsed.surfaces)) return null;
    const outcome = parsed.outcome;
    if (outcome === undefined || !UPDATE_OUTCOMES.includes(outcome)) return null;
    return {
      schema: 1,
      outcome,
      surfaces: parsed.surfaces,
      workers: typeof parsed.workers === "number" ? parsed.workers : null,
    };
  } catch {
    return null;
  }
}

/** Write the record, if it differs. Returns the paths written. */
export function writeStagedUpdate(home: string, record: StagedUpdateRecord): string[] {
  const desired = `${JSON.stringify(record, null, 2)}\n`;
  const path = stagedUpdatePath(home);
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

// --------------------------------------------------------------- the walk

export interface StagedUpdateOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** The red-dev platform the host and companion walks need. */
  manifestPlatform?: Platform;
  /**
   * Active Workers on this machine. Defaults to asking the daemon over
   * its existing socket, and never starting one: an update that births a
   * daemon to ask whether a daemon is busy has changed the answer.
   */
  workers?: () => Promise<number | null>;
  /** The channel, version or commit to acquire. Defaults to the channel env. */
  selector?: string;
  /**
   * Whether this run has an acquisition to perform at all.
   *
   * `installed` is the postinstall's answer: mise has just put the set
   * on the machine through the plugin's own install phase, and asking
   * the remote again would be a second acquisition for one upgrade.
   * The surface is still reported — what it reports is the revision
   * this machine now resolves.
   */
  acquisition?: "acquire" | "installed";
  /**
   * The acquisition, told whether it may activate what it verifies.
   * Defaults to the staged activation, then src/red-skills-acquire.ts.
   */
  acquire?: (stageOnly: boolean) => Promise<Acquisition>;
  /** The hosts and companions. Defaults to red-dev's own converge. */
  converge?: () => Promise<{ hosts: HostOutcome[]; companions: CompanionOutcome[] }>;
  /** The exact workstation lock. Defaults to the one this machine holds. */
  lock?: () => Promise<LockResult>;
}

/**
 * Advance every surface to one revision, or say which one did not.
 *
 * The order is the contract, and it is the order of dependency:
 * acquisition puts the revision on the machine, the hosts and companions
 * are built out of it, and the lock pins everything neither of them
 * publishes. A surface that fails is named and walked past — the ones
 * after it are still worth advancing, and the ones before it keep what
 * they already verified.
 */
export async function runStagedUpdate(opts: StagedUpdateOptions = {}): Promise<StagedUpdate> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homeOf(env);
  const workers = await (opts.workers ?? defaultWorkers)();

  // The one question asked before anything is acquired, because its
  // answer changes what acquisition is allowed to do. Unknown is not
  // "busy": a machine with no daemon has no Workers to protect, and an
  // update that refused to activate anything it could not ask about
  // would never activate on a workstation that runs no daemon at all.
  const held = (workers ?? 0) > 0;

  const surfaces: SurfaceOutcome[] = [];
  const acquired = await (opts.acquire ?? defaultAcquire(opts, home))(held);
  surfaces.push(acquisitionSurface(acquired));

  if (held) {
    // Everything else, deliberately not done. The Worker is running
    // against the active lock, and the complete new revision waits on
    // disk until the run that finds the queue drained.
    for (const surface of UPDATE_SURFACES.filter((s) => s !== "acquisition")) {
      surfaces.push(pendingSurface(surface, workers ?? 0));
    }
  } else {
    const converged = await (opts.converge ?? defaultConverge(opts))();
    surfaces.push(hostSurface(converged.hosts));
    surfaces.push(companionSurface(converged.companions));
    surfaces.push(lockSurface(await (opts.lock ?? defaultLock(home))()));
  }

  const outcome = stagedUpdateOutcome(surfaces);
  const state = readPackageSetState(home);
  const active = state.revisions.find((r) => r.key === state.active) ?? null;
  const restartNeeded = [...new Set(surfaces.flatMap((s) => s.restartNeeded))];

  writeStagedUpdate(home, { schema: 1, outcome, surfaces, workers });
  announceStagedUpdate({ outcome, surfaces, restartNeeded });

  return {
    outcome,
    surfaces,
    active: active
      ? { version: active.version, digest: active.digest, sourceCommit: active.sourceCommit }
      : null,
    staged: state.staged
      ? {
          version: state.staged.version,
          digest: state.staged.digest,
          sourceCommit: state.staged.sourceCommit,
        }
      : null,
    restartNeeded,
    workers,
    code: outcome === "converged" || outcome === "staged" ? 0 : 1,
  };
}

/** One line per surface, in the voice the rest of a converge speaks. */
function announceStagedUpdate(
  run: Pick<StagedUpdate, "outcome" | "surfaces" | "restartNeeded">,
): void {
  for (const surface of run.surfaces) {
    const line = `${surface.surface}: ${surface.reason}`;
    if (surface.state === "failed") log.err(line);
    else if (surface.state === "pending") log.skip(line);
    else if (surface.state === "skipped") log.skip(line);
    else log.ok(line);
  }
  if (run.restartNeeded.length > 0) {
    // Said once, at the end, and never as a failure: the disk is
    // converged and the process was left alone on purpose.
    log.warn(`restart needed to load the revision: ${run.restartNeeded.join(", ")}`);
  }
  if (run.outcome === "partial") {
    log.warn("the update was partial — the surfaces that verified are on the new revision");
  }
}

// ------------------------------------------------------------ the defaults

/**
 * The activation a previous run staged, then the ordinary acquisition.
 *
 * The order is the criterion: a machine whose Worker has finished
 * activates the revision that is already on it, and does not go back to
 * the remote for bytes it verified last week. Only when there is nothing
 * staged does this reach the network at all.
 */
function defaultAcquire(
  opts: StagedUpdateOptions,
  home: string,
): (stageOnly: boolean) => Promise<Acquisition> {
  return async (stageOnly) => {
    const { activateStagedPackageSet } = await import("./red-skills-set.ts");
    if (!stageOnly) {
      const activated = activateStagedPackageSet({
        home,
        ...(opts.env ? { env: opts.env } : {}),
      });
      if (activated !== null) {
        return {
          outcome: activated.refused ? "refused" : "acquired",
          reason: activated.refused
            ? activated.refused.reason
            : "the staged revision was activated — nothing was acquired",
          failure: activated.refused?.failure ?? null,
          selector: null,
          commit: activated.active?.sourceCommit ?? null,
          version: activated.active?.version ?? null,
          mirror: null,
          snapshot: null,
          candidate: null,
          active: activated.active,
          staged: activated.staged,
          writes: activated.writes,
        };
      }
    }

    // mise's postinstall: the set is already on the machine, and the
    // only honest thing to report is which revision that is.
    if (opts.acquisition === "installed") {
      const { readPackageSetState } = await import("./red-skills-set.ts");
      const { formatPackageSetIdentity } = await import("./red-skills-set.ts");
      const state = readPackageSetState(home);
      const active = state.revisions.find((r) => r.key === state.active) ?? null;
      return {
        outcome: active === null ? "unavailable" : "current",
        reason:
          active === null
            ? "no package set is active on this machine"
            : `${formatPackageSetIdentity(active)} was installed by mise`,
        failure: null,
        selector: null,
        commit: active?.sourceCommit ?? null,
        version: active?.version ?? null,
        mirror: null,
        snapshot: null,
        candidate: null,
        active: active
          ? { version: active.version, digest: active.digest, sourceCommit: active.sourceCommit }
          : null,
        staged: null,
        writes: [],
      };
    }

    const { acquireRedSkills, announce } = await import("./red-skills-acquire.ts");
    const acquisition = await acquireRedSkills({
      home,
      stageOnly,
      ...(opts.selector ? { selector: opts.selector } : {}),
      ...(opts.manifestPlatform ? { manifestPlatform: opts.manifestPlatform } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    });
    announce(acquisition);
    return acquisition;
  };
}

function defaultConverge(
  opts: StagedUpdateOptions,
): () => Promise<{ hosts: HostOutcome[]; companions: CompanionOutcome[] }> {
  return async () => {
    const { convergeRedSkills } = await import("./agents.ts");
    const { detect } = await import("./platform.ts");
    return await convergeRedSkills(opts.manifestPlatform ?? detect());
  };
}

/**
 * The lock surface as this machine can honestly answer it today.
 *
 * The lock is read and audited; installing from it is not wired to a
 * live installer yet (src/workstation-lock.ts owns that half, and it
 * needs a resolved lock this machine has no publisher for). So a lock
 * that is present and valid reports the applications it pins as already
 * planned for, and everything else is `skipped` — which is the truthful
 * answer rather than a verified surface nothing verified.
 */
function defaultLock(home: string): () => Promise<LockResult> {
  return async () => {
    const { readWorkstationLock, missingFromLock } = await import("./workstation-lock.ts");
    const read = readWorkstationLock(home);
    if (!read.ok) return read;
    const missing = missingFromLock(read.lock);
    if (missing.length > 0) {
      return {
        ok: false,
        present: true,
        reason: `the workstation lock names no version for ${missing.join(", ")}`,
      };
    }
    return {
      ok: true,
      report: {
        target: read.lock.target.id,
        installed: [],
        present: read.lock.apps.map((app) => `${app.id} on ${app.surface}`),
        failed: [],
        unconfigured: [],
      },
    };
  };
}

/** Active Workers, over the daemon's existing socket and never a new one. */
async function defaultWorkers(): Promise<number | null> {
  const { readHostInventoryNoStart } = await import("./host-state.ts");
  const inventory = await readHostInventoryNoStart();
  return inventory === null ? null : inventory.workers.length;
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return (env["HOME"] ?? env["USERPROFILE"] ?? "").replace(/\\/g, "/");
}

// --------------------------------------------------------------- the report

export interface UpdateDoctorReport {
  /** The verdict of the last run, or null when none has been recorded. */
  outcome: UpdateOutcome | null;
  /** The identity `current` names. */
  active: PackageSetIdentity | null;
  /** The complete revision staged and waiting on a Worker, or null. */
  staged: PackageSetIdentity | null;
  /** Surfaces the last run held back rather than advanced. */
  pending: UpdateSurface[];
  /** Surfaces the last run could not converge. */
  failed: UpdateSurface[];
  /** Hosts and companions reconciled on disk but not yet observed. */
  restartNeeded: string[];
  /** Active Workers when the last run started, or null when unknown. */
  workers: number | null;
}

/**
 * What doctor says about the update, as data.
 *
 * The active and staged revisions come off the package-set state — they
 * are facts about the machine, true whether or not an update has ever
 * run here — and everything else comes off the last run's record,
 * because `pending` and `partial` are decisions rather than observable
 * state. A machine with no record answers `null` and empty lists, which
 * is exactly what a machine that has never updated should say.
 */
export function stagedUpdateReport(home: string): UpdateDoctorReport {
  const state = readPackageSetState(home);
  const active = state.revisions.find((r) => r.key === state.active) ?? null;
  const record = readStagedUpdate(home);
  return {
    outcome: record?.outcome ?? null,
    active: active
      ? { version: active.version, digest: active.digest, sourceCommit: active.sourceCommit }
      : null,
    staged: state.staged
      ? {
          version: state.staged.version,
          digest: state.staged.digest,
          sourceCommit: state.staged.sourceCommit,
        }
      : null,
    pending: (record?.surfaces ?? []).filter((s) => s.state === "pending").map((s) => s.surface),
    failed: (record?.surfaces ?? []).filter((s) => s.state === "failed").map((s) => s.surface),
    restartNeeded: [...new Set((record?.surfaces ?? []).flatMap((s) => s.restartNeeded ?? []))],
    workers: record?.workers ?? null,
  };
}

export interface UpdateDoctorRow {
  status: "ok" | "warn" | "err" | "n/a";
  detail: string;
}

/** The report as the lines `red-dev doctor` prints. PURE. */
export function stagedUpdateRows(report: UpdateDoctorReport): UpdateDoctorRow[] {
  const rows: UpdateDoctorRow[] = [];
  if (report.outcome === null) {
    rows.push({ status: "n/a", detail: "no staged update has run on this machine" });
    return rows;
  }
  const verdict: Record<UpdateOutcome, UpdateDoctorRow["status"]> = {
    converged: "ok",
    staged: "warn",
    partial: "err",
    failed: "err",
  };
  rows.push({
    status: verdict[report.outcome],
    detail: `the last update ${VERDICT_DETAIL[report.outcome]}`,
  });
  if (report.pending.length > 0) {
    rows.push({
      status: "warn",
      detail:
        `pending on ${report.workers ?? 0} active Worker(s): ${report.pending.join(", ")} — ` +
        "activated by the next update that finds the queue drained",
    });
  }
  if (report.failed.length > 0) {
    rows.push({ status: "err", detail: `not converged: ${report.failed.join(", ")}` });
  }
  if (report.restartNeeded.length > 0) {
    rows.push({
      status: "warn",
      detail: `restart needed before the revision is observed: ${report.restartNeeded.join(", ")}`,
    });
  }
  return rows;
}

const VERDICT_DETAIL: Record<UpdateOutcome, string> = {
  converged: "reached every surface of this workstation",
  staged: "staged a complete revision and left the machine on the one its Workers are using",
  partial: "left this workstation between two revisions — the surfaces that verified are on the new one",
  failed: "reached no surface of this workstation",
};
