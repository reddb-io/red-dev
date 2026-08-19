/**
 * The rollback journey for one Ubuntu desktop, end to end, in one function.
 *
 * Spec #201's rollback criteria are five sentences about time rather than
 * about a machine: a workstation that moved N-2 → N-1 → N has to be able
 * to go back to N-1 with every version and every digest it had then, out
 * of what is already on disk, without stopping anything that is running,
 * without keeping a third copy of everything, and without pruning
 * anything while an update is still in doubt. None of that is provable
 * from one activation — the retention only becomes visible on the third,
 * and the fourth criterion only becomes visible when a run fails. So the
 * journey is one function that both `bun test` and
 * `bun run e2e:rollback-ubuntu24` call, and it returns the checks it made
 * rather than printing them, so the two callers cannot disagree about
 * what passed.
 *
 * `target` is a parameter for the reason src/offline-depot-e2e.ts takes
 * one: #213 asks for this whole journey on Ubuntu 26.04, and a second
 * copy of it would be a second opinion about what a rollback means.
 *
 * ## And then it all comes off again
 *
 * The last two checks uninstall the workstation the first thirteen
 * built. That belongs here rather than in a journey of its own because
 * an uninstall is only interesting against a machine with revisions,
 * retained locks and machine-owned depots on it — which is exactly what
 * this journey has by the time the rollback has settled — and because
 * the thing worth proving is as much what survives as what goes.
 *
 * ## The three revisions, and the one that failed
 *
 * Three generations of the fixture release table
 * (`FIXTURE_RELEASE_HISTORY`) give three genuinely different complete
 * workstations: five applications move between each pair and nine stay
 * exactly where they are, which is what makes "restored every observed
 * version" worth asserting — a rollback that reinstalled everything
 * indiscriminately and one that restored the five would both end with the
 * right versions, and only the second leaves the nine untouched.
 *
 * The third activation is deliberately run twice: once unverified, as an
 * update held behind a running Worker or stopped by a failed surface, and
 * once verified. The prune that the verified run performs is asserted
 * *not* to have happened on the unverified one, over the same paths. That
 * is the fourth criterion, and it is the one that cannot be checked by
 * looking at a machine — only by looking at two moments of one.
 *
 * ## What is real here, and what is rehearsed
 *
 * The same split src/offline-depot-e2e.ts draws, for the same reasons:
 * every line of src/workstation-rollback.ts, src/workstation-lock.ts and
 * src/red-skills-set.ts the journey touches is real, and the publisher's
 * bytes, the signature and the installer are the fixture's. What is
 * additionally rehearsed here is the host and companion converge, which
 * is injected so the journey can assert the one thing about it that
 * matters to a rollback: that a host which cannot observe the change
 * without a fresh process is *reported* rather than restarted.
 *
 * ## Egress is denied, and nothing is stopped
 *
 * The rollback half runs with `globalThis.fetch` replaced by a stub that
 * records the attempt and throws, exactly as the depot journey does. If
 * any code under `rollbackWorkstation` reached for the network the
 * journey would fail with the URL it asked for, instead of passing on a
 * laptop that happened to be online.
 *
 * Termination is asserted the only way it can honestly be asserted: the
 * rollback is handed two running Workers and a converge whose hosts all
 * answer `restart-needed`, and what comes back is a report that counts
 * both and stops neither. There is no termination hook to spy on because
 * there is nothing in the module that could call one — so the check is
 * that every host the rollback reconciled is *owed* a restart rather
 * than having been given one, and that the two Workers are still two.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanUbuntu,
  rehearsalArtifact,
  rehearsalFetcher,
  rehearsalLock,
  rehearsalPackageSet,
  rehearsalSigner,
  rehearsalVerifier,
  UBUNTU,
} from "./fixtures/offline-depot/rehearsal.ts";
import { journeyLines, type JourneyCheck, type JourneyResult } from "./offline-depot-e2e.ts";
import {
  DEPOT_SET_DIR,
  exportDepot,
  importDepot,
  type DepotInstaller,
  type DepotRevision,
} from "./offline-depot.ts";
import type { CompanionOutcome } from "./red-skills-companions.ts";
import type { HostOutcome } from "./red-skills-hosts.ts";
import {
  convergeRedSkillsPackageSet,
  readPackageSetState,
  revisionKey,
} from "./red-skills-set.ts";
import {
  activateWorkstationRevision,
  planWorkstationRetention,
  readWorkstationRevisions,
  retainedLockPath,
  rollbackWorkstation,
  workstationRollbackReport,
  workstationRollbackRows,
} from "./workstation-rollback.ts";
import { uninstallWorkstation } from "./workstation-uninstall.ts";
import type { ObservedApp, ObservedTarget, WorkstationLock } from "./workstation-lock.ts";

/** The target the Ubuntu 24 rollback journey rolls back, named once. */
export const ROLLBACK_TARGET = UBUNTU;

/**
 * The three RedSkills releases the three revisions carry.
 *
 * Newest first, so the index is the generation: `SET_RELEASES[1]` is what
 * the machine was on one revision ago, which is the revision the rollback
 * restores.
 */
export const SET_RELEASES = [
  { version: "3.20.0", commit: "626a28473edeee992fcf6425dedbca84448343fd" },
  { version: "3.19.5", commit: "8c3f1d94e21b6a70f5d2c48ab90e7f3612d4a5b8" },
  { version: "3.19.0", commit: "1f7a90c53be48d21ca6b0e7f4d938265ab71c0e9" },
] as const;

export interface RollbackJourneyOptions {
  /** Which workstation is rolled back. Defaults to the Ubuntu 24 desktop. */
  target?: string;
  /** Where the machines are built. Defaults to a temporary directory. */
  root?: string;
  /** The export instant. Fixed by default: a journey never reads a clock. */
  at?: string;
  /** Leave the directories behind for inspection. */
  keep?: boolean;
}

/** A `fetch` that cannot succeed, and remembers being asked. */
function denyEgress(): { attempts: string[]; restore: () => void } {
  const attempts: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    attempts.push(url);
    throw new Error(`network egress is blocked on this target: ${url}`);
  }) as unknown as typeof fetch;
  return { attempts, restore: () => { globalThis.fetch = original; } };
}

/** One provisioned revision, as the journey holds on to it. */
interface Revision {
  generation: number;
  lock: WorkstationLock;
  depot: string;
  packageSet: DepotRevision;
  /** The machine-owned copy the applications were installed from. */
  owned: string;
}

/**
 * Run the whole journey and report what held.
 *
 * Every check is recorded rather than thrown, for the reason the depot
 * journey records rather than throws: an operator reading a red run wants
 * the whole shape of what broke, not the first fact that stopped being
 * true.
 */
export async function runRollbackJourney(
  opts: RollbackJourneyOptions = {},
): Promise<JourneyResult> {
  const target = opts.target ?? UBUNTU;
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "red-rollback-journey-"));
  const at = opts.at ?? "2026-08-19T00:00:00Z";
  const home = join(root, "target", "home");
  // Somebody's own configuration, on the machine before red-dev is and
  // asserted to still be there after red-dev has been taken off again.
  // src/uninstall.ts settles this rule for one tool; the uninstall at
  // the end of this journey is where it has to hold for fourteen.
  const keepsake = join(home, ".claude", "settings.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(keepsake, '{"theme":"red"}\n', "utf8");
  const checks: JourneyCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): boolean => {
    checks.push({ name, ok, detail });
    return ok;
  };
  const finish = (): JourneyResult => {
    if (!opts.keep) rmSync(root, { recursive: true, force: true });
    return { ok: checks.every((c) => c.ok), target, checks, root: opts.keep ? root : null };
  };

  // ---------------------------------------------------- the connected machine
  // Three depots, oldest cut first, each declaring the one before it as
  // the revision an offline rollback restores.
  const depots: { generation: number; lock: WorkstationLock; dir: string; packageSet: DepotRevision }[] = [];
  for (let generation = SET_RELEASES.length - 1; generation >= 0; generation--) {
    const release = SET_RELEASES[generation];
    if (release === undefined) continue;
    const setDir = rehearsalPackageSet(join(root, "connected", `set-${generation}`), release);
    const lock = await rehearsalLock(at, "resolved", generation, target);
    const previous = depots[depots.length - 1]?.packageSet ?? null;
    const exported = await exportDepot({
      lock,
      setDir,
      dest: join(root, "medium", `depot-${generation}`),
      exportedAt: at,
      fetch: rehearsalFetcher,
      verifier: rehearsalVerifier,
      sign: rehearsalSigner,
      previous,
    });
    if (!exported.ok) return finish_(check, finish, "export", exported.reason);
    depots.push({
      generation,
      lock,
      dir: exported.report.dir,
      packageSet: exported.report.depot.packageSet.active,
    });
  }
  const currentDepot = depots[depots.length - 1];
  if (depots.length !== SET_RELEASES.length || currentDepot === undefined) {
    return finish_(check, finish, "export", "the journey did not build three depots");
  }
  check(
    "export",
    new Set(depots.map((d) => d.packageSet.digest)).size === 3 &&
      new Set(depots.map((d) => d.lock.lockDigest)).size === 3,
    `three complete revisions cut for ${target}: ${depots.map((d) => d.packageSet.key).join(" -> ")}`,
  );

  // ------------------------------------------------- the network-denied target
  const observed = cleanUbuntu(target);
  const installed: ObservedApp[] = [];
  const install: DepotInstaller = async (step, artifact) => {
    if (artifact.bytes.toString("utf8") !== rehearsalArtifact(step.app)) {
      return { ok: false, detail: "the artifact is not the one the lock names" };
    }
    const at_ = installed.findIndex((a) => a.id === step.app.id && a.surface === step.app.surface);
    const entry = { id: step.app.id, surface: step.app.surface, version: step.app.version };
    if (at_ === -1) installed.push(entry);
    else installed[at_] = entry;
    return { ok: true };
  };
  const machine = (): ObservedTarget => ({ ...observed, installed: [...installed] });

  const provision = async (depot: (typeof depots)[number]): Promise<Revision | string> => {
    const imported = await importDepot({
      depot: depot.dir,
      home,
      observed: machine(),
      verifier: rehearsalVerifier,
      install,
    });
    if (!imported.ok) return imported.reason;
    const converged = convergeRedSkillsPackageSet({
      home,
      source: join(imported.report.path, DEPOT_SET_DIR),
      verifier: rehearsalVerifier,
    });
    if (converged.refused !== null) return converged.refused.reason;
    return {
      generation: depot.generation,
      lock: depot.lock,
      depot: depot.dir,
      packageSet: depot.packageSet,
      owned: imported.report.path,
    };
  };

  const provisioned: Revision[] = [];
  for (const depot of depots) {
    const revision = await provision(depot);
    if (typeof revision === "string") return finish_(check, finish, "provision", revision);
    provisioned.push(revision);
    // The third revision is recorded twice, and the first of the two is
    // the failed update: see below.
    if (depot === currentDepot) break;
    activateWorkstationRevision({
      home,
      lock: revision.lock,
      packageSet: revision.packageSet,
      depot: revision.owned,
      activatedAt: at,
      verified: true,
    });
  }
  const [oldest, previous, current] = provisioned;
  if (oldest === undefined || previous === undefined || current === undefined) {
    return finish_(check, finish, "provision", "the journey did not provision three revisions");
  }
  check(
    "provision",
    readWorkstationRevisions(home).active?.packageSet.key === previous.packageSet.key,
    `the target was provisioned ${provisioned.map((r) => r.packageSet.version).join(" -> ")} from three depots`,
  );

  // ------------------------------------------------------- the failed update
  // The third revision arrives and does not verify: a surface failed, or
  // a Worker held the activation. Everything the oldest revision needs
  // has to still be here afterwards, because a rollback is the remedy.
  const oldestLock = retainedLockPath(home, oldest.lock.lockDigest);
  activateWorkstationRevision({
    home,
    lock: current.lock,
    packageSet: current.packageSet,
    depot: current.owned,
    activatedAt: at,
    verified: false,
  });
  const held = readWorkstationRevisions(home);
  const heldPlan = planWorkstationRetention({ home });
  check(
    "pending-retains",
    held.active?.packageSet.key === previous.packageSet.key &&
      held.previous?.packageSet.key === oldest.packageSet.key &&
      held.pending?.packageSet.key === current.packageSet.key &&
      heldPlan.held !== null &&
      existsSync(oldestLock) &&
      existsSync(oldest.owned),
    heldPlan.held === null
      ? "an unverified activation did not hold the prune"
      : `the failed update left ${previous.packageSet.key} active and pruned nothing: ${heldPlan.held}`,
  );
  // And what a rollback would restore right now is the last state that
  // verified, not the one behind it: the machine has already drifted
  // forward into a revision nothing vouched for.
  const heldReport = workstationRollbackReport(home);
  check(
    "pending-target",
    heldReport.restores?.packageSet.key === previous.packageSet.key && heldReport.restorable,
    heldReport.restores === null
      ? "a pending activation left nothing to restore"
      : `with an activation pending, a rollback restores the last verified state ${heldReport.restores.packageSet.key}`,
  );

  // ------------------------------------------------------ the verified update
  const activated = activateWorkstationRevision({
    home,
    lock: current.lock,
    packageSet: current.packageSet,
    depot: current.owned,
    activatedAt: at,
    verified: true,
  });
  const after = readWorkstationRevisions(home);
  check(
    "retention",
    after.active?.packageSet.key === current.packageSet.key &&
      after.previous?.packageSet.key === previous.packageSet.key &&
      after.pending === null &&
      !existsSync(oldestLock) &&
      !existsSync(oldest.owned) &&
      existsSync(previous.owned) &&
      existsSync(retainedLockPath(home, previous.lock.lockDigest)),
    `after verification the two newest revisions remain and ${activated.retention.prunable.length} older derived path(s) went`,
  );

  // --------------------------------------------------------------- the rollback
  const before = installed.map((app) => `${app.id}@${app.version}`).sort();
  const reconciled: string[] = [];
  const converge = async (): Promise<{ hosts: HostOutcome[]; companions: CompanionOutcome[] }> => {
    // Every host is reconciled on disk and none is stopped. A host whose
    // CLI is running answers `restart-needed`, which is the whole of the
    // rule: the session keeps the revision it started with.
    const hosts: HostOutcome[] = ["claude-code", "codex", "gemini"].map((host) => {
      reconciled.push(host);
      return { host, status: "reconciled", reload: "restart-needed" };
    });
    const companions: CompanionOutcome[] = [
      { companion: "redskilled", status: "reconciled", reload: "restart-needed" },
      { companion: "zellij", status: "current", reload: "current" },
    ];
    return { hosts, companions };
  };

  const egress = denyEgress();
  let rolled;
  try {
    rolled = await rollbackWorkstation({
      home,
      observed: machine(),
      install,
      converge,
      workers: async () => 2,
      at,
    });
  } finally {
    egress.restore();
  }
  if (!check("rollback", rolled.code === 0, rolled.reason)) return finish();

  const want = new Map(previous.lock.apps.map((app) => [`${app.id}:${app.surface}`, app.version]));
  const wrong = installed.filter((app) => want.get(`${app.id}:${app.surface}`) !== app.version);
  check(
    "versions",
    wrong.length === 0 && installed.length === previous.lock.apps.length,
    wrong.length === 0
      ? `all ${installed.length} applications are back at the versions ${previous.packageSet.version} locked`
      : `${wrong.map((a) => `${a.id}@${a.version}`).join(", ")} did not come back`,
  );
  const moved = installed
    .map((app) => `${app.id}@${app.version}`)
    .sort()
    .filter((line) => !before.includes(line));
  check(
    "untouched",
    moved.length > 0 && moved.length < installed.length,
    `${moved.length} of ${installed.length} applications moved, and the rest were left exactly where they were`,
  );

  const setState = readPackageSetState(home);
  check(
    "package-set",
    setState.active === previous.packageSet.key &&
      revisionKey(previous.packageSet) === previous.packageSet.key,
    `the machine resolves package set ${setState.active} again — the whole-set digest ${previous.packageSet.version} was verified under`,
  );

  check(
    "offline",
    egress.attempts.length === 0,
    egress.attempts.length === 0
      ? "the rollback made no JavaScript network request; every artifact came out of the machine's own depot copy"
      : `the rollback reached for ${egress.attempts.join(", ")}`,
  );
  const owed = new Set(rolled.restartNeeded);
  check(
    "uninterrupted",
    rolled.workers === 2 && reconciled.every((host) => owed.has(host)),
    rolled.workers === 2
      ? `${rolled.workers} Worker(s) were counted and left running, and all ${reconciled.length} reconciled host(s) plus ${owed.size - reconciled.length} companion(s) are owed a restart rather than having been given one`
      : `the rollback reported ${rolled.workers} Worker(s) instead of the 2 that were running`,
  );
  check(
    "reconciled",
    reconciled.length > 0 && rolled.surfaces.every((s) => s.state !== "failed"),
    `${reconciled.length} host(s) and every companion were rebuilt against the restored set`,
  );

  const lockNow = readFileSync(join(home, ".red-skills", "workstation-lock.json"), "utf8");
  check(
    "lock",
    lockNow === readFileSync(retainedLockPath(home, previous.lock.lockDigest), "utf8"),
    `the machine's lock is ${previous.lock.lockDigest.slice(0, 12)} again, byte for byte`,
  );

  // ------------------------------------------------------- the second rollback
  const secondEgress = denyEgress();
  let second;
  try {
    second = await rollbackWorkstation({
      home,
      observed: machine(),
      install: async () => ({ ok: false, detail: "a rolled-back machine must install nothing" }),
      converge,
      workers: async () => 2,
      at,
    });
  } finally {
    secondEgress.restore();
  }
  check(
    "idempotent",
    second.outcome === "converged" && second.writes.length === 0 && second.code === 0,
    second.writes.length === 0
      ? `a second rollback wrote nothing: ${second.reason}`
      : `a second rollback wrote ${second.writes.length} path(s)`,
  );

  const report = workstationRollbackReport(home);
  const rows = workstationRollbackRows(report);
  check(
    "doctor",
    rows.length > 0 &&
      rows.every((row) => row.status !== "err") &&
      report.active?.packageSet.key === previous.packageSet.key &&
      report.restores === null &&
      report.rolledBackFrom?.packageSet.key === current.packageSet.key &&
      rows.some((row) => row.detail.includes("retention holds")) &&
      rows.some((row) => row.detail.includes(previous.lock.lockDigest.slice(0, 12))),
    rows.every((row) => row.status !== "err")
      ? `doctor names the active lock, the revision rolled back from and what retention holds, in ${rows.length} lines`
      : rows.filter((row) => row.status === "err").map((row) => row.detail).join("; "),
  );

  // ------------------------------------------------------------ the uninstall
  // And then all of it comes off: every application the lock names, the
  // revisions, the retained locks and the machine-owned depots the whole
  // journey was served from. With egress still denied, because removing
  // a workstation is not a reason to phone home either.
  const removed: string[] = [];
  const uninstallEgress = denyEgress();
  let gone;
  try {
    gone = await uninstallWorkstation({
      home,
      observed: machine(),
      remove: async (app) => {
        const at_ = installed.findIndex((a) => a.id === app.id && a.surface === app.surface);
        if (at_ === -1) return { ok: false, detail: "this machine does not have it" };
        installed.splice(at_, 1);
        removed.push(`${app.id} on ${app.surface}`);
        return { ok: true };
      },
      workers: async () => 0,
    });
  } finally {
    uninstallEgress.restore();
  }
  const ownedRoot = join(home, ".red-skills");
  check(
    "uninstall",
    gone.code === 0 &&
      gone.outcome === "removed" &&
      removed.length === previous.lock.apps.length &&
      installed.length === 0 &&
      !existsSync(ownedRoot) &&
      existsSync(keepsake) &&
      uninstallEgress.attempts.length === 0,
    gone.outcome === "removed"
      ? `all ${removed.length} applications and ${gone.writes.length} machine-owned path(s) went, and the configuration nobody locked is still there`
      : gone.reason,
  );

  const secondUninstall = await uninstallWorkstation({
    home,
    observed: machine(),
    remove: async () => ({ ok: false, detail: "an uninstalled machine must remove nothing" }),
    workers: async () => 0,
  });
  check(
    "uninstall-idempotent",
    secondUninstall.outcome === "absent" &&
      secondUninstall.writes.length === 0 &&
      secondUninstall.code === 0,
    secondUninstall.writes.length === 0
      ? `a second uninstall removed nothing: ${secondUninstall.reason}`
      : `a second uninstall removed ${secondUninstall.writes.length} path(s)`,
  );

  return finish();
}

/**
 * The Ubuntu 24 rollback journey, under the name its command and its
 * test use. A one-line alias, for the reason the depot journey has one.
 */
export function runUbuntu24RollbackJourney(
  opts: RollbackJourneyOptions = {},
): Promise<JourneyResult> {
  return runRollbackJourney({ ...opts, target: ROLLBACK_TARGET });
}

/** Record one fatal check and stop. */
function finish_(
  check: (name: string, ok: boolean, detail: string) => boolean,
  finish: () => JourneyResult,
  name: string,
  reason: string,
): JourneyResult {
  check(name, false, reason);
  return finish();
}

/** The journey as lines, for the command that runs it. PURE. */
export function rollbackJourneyLines(result: JourneyResult): string[] {
  return journeyLines(result, "rollback journey");
}
