/**
 * What a rollback has to refuse, and what it must never take away.
 *
 * The journey in src/rollback-e2e.test.ts proves the happy path across
 * three real revisions. This file is the other half: the states where
 * going back is impossible and saying so is the whole job — a lock that
 * was pruned, a package-set tree that is gone, a revision provisioned
 * from a source this machine no longer holds — and the retention rule
 * that the fourth criterion is entirely about, which is a rule about
 * what a *failed* run leaves behind.
 *
 * The refusals are asserted from the side an operator sees, because a
 * refusal that is right and unreadable is a refusal somebody works
 * around: every one of them names the path that is missing.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rehearsalLock } from "./fixtures/offline-depot/rehearsal.ts";
import { depotAppPath, offlineDepotStatePath } from "./offline-depot.ts";
import { encodeWorkstationLock, type WorkstationLock } from "./workstation-lock.ts";
import {
  activateWorkstationRevision,
  applyWorkstationRetention,
  describeWorkstationRevision,
  planWorkstationRetention,
  readWorkstationRevisions,
  retainedLockPath,
  retainedRevisions,
  retainWorkstationLock,
  rollbackTarget,
  rollbackWorkstation,
  workstationRevisionKey,
  workstationRevisionsPath,
  workstationRollbackReport,
  workstationRollbackRows,
  WORKSTATION_REVISION_RETENTION,
  type WorkstationRevision,
} from "./workstation-rollback.ts";

const AT = "2026-08-19T00:00:00Z";

function home(): string {
  return mkdtempSync(join(tmpdir(), "red-rollback-"));
}

/**
 * A machine on one complete revision, with nothing installed.
 *
 * Deliberately not a whole provisioned target: everything below is about
 * a rollback that never gets as far as installing anything, and building
 * fourteen applications to assert that a missing lock is refused would
 * only make the refusal harder to read.
 */
async function oneRevision(
  dir: string,
  generation: number,
  opts: { depot?: string | null; setDir?: boolean } = {},
): Promise<{ lock: WorkstationLock; revision: WorkstationRevision }> {
  const lock = await rehearsalLock(AT, "resolved", generation);
  const packageSet = {
    key: `3.${20 - generation}.0+${"a".repeat(12)}`.replace("aaaaaaaaaaaa", `${generation}`.repeat(12)),
    version: `3.${20 - generation}.0`,
    digest: `${generation}`.repeat(64),
    sourceCommit: "",
  };
  const revision = describeWorkstationRevision({
    home: dir,
    lock,
    packageSet,
    depot: opts.depot === undefined ? join(dir, ".red-skills", "depots", `d${generation}`) : opts.depot,
    activatedAt: AT,
  });
  if (opts.setDir !== false) mkdirSync(join(dir, ".red-skills", "sets", packageSet.key), { recursive: true });
  retainWorkstationLock(dir, lock);
  if (revision.depot !== null) {
    for (const app of lock.apps) {
      const path = join(revision.depot, depotAppPath(app));
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `fixture:${app.id}@${app.version}:${app.artifact.name}`);
    }
  }
  return { lock, revision };
}

/**
 * Build and activate one generation at a time, oldest first.
 *
 * Built one at a time on purpose: an activation prunes what no retained
 * revision names, and a revision materialised before its turn would be
 * pruned by the activation before it — which is the retention working,
 * and a confusing way to set up a test about it.
 */
async function activateInOrder(
  dir: string,
  generations: number[],
): Promise<{ lock: WorkstationLock; revision: WorkstationRevision }[]> {
  const out: { lock: WorkstationLock; revision: WorkstationRevision }[] = [];
  for (const generation of generations) {
    const built = await oneRevision(dir, generation);
    activateWorkstationRevision({
      home: dir,
      lock: built.lock,
      packageSet: built.revision.packageSet,
      depot: built.revision.depot,
      activatedAt: AT,
      verified: true,
    });
    out.push(built);
  }
  return out;
}

/** The state file, written straight rather than through an activation. */
function writeState(dir: string, state: Record<string, unknown>): void {
  const path = workstationRevisionsPath(dir);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ schema: 1, ...state }, null, 2)}\n`);
}

const NEVER_INSTALL = async () => ({ ok: false, detail: "nothing should have been installed" });
const NO_CONVERGE = async () => ({ hosts: [], companions: [] });

describe("the workstation revision record", () => {
  test("one name covers the package set and the lock together", () => {
    expect(workstationRevisionKey("3.20.0+abcdef012345", "f".repeat(64))).toBe(
      "3.20.0+abcdef012345+ffffffffffff",
    );
  });

  test("a machine with no record answers empty rather than throwing", () => {
    const dir = home();
    try {
      expect(readWorkstationRevisions(dir).active).toBeNull();
      expect(workstationRollbackReport(dir).restores).toBeNull();
      expect(workstationRollbackRows(workstationRollbackReport(dir))).toEqual([
        { status: "n/a", detail: "no complete workstation revision has been activated here" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a record this build cannot read is no record, and never an exception", () => {
    const dir = home();
    try {
      const path = workstationRevisionsPath(dir);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "{ not json");
      expect(readWorkstationRevisions(dir).active).toBeNull();
      writeFileSync(path, `${JSON.stringify({ schema: 7, active: {} })}\n`);
      expect(readWorkstationRevisions(dir).active).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an activation retains the lock byte for byte, and a second one writes nothing", async () => {
    const dir = home();
    try {
      const { lock, revision } = await oneRevision(dir, 0);
      const first = activateWorkstationRevision({
        home: dir,
        lock,
        packageSet: revision.packageSet,
        depot: revision.depot,
        activatedAt: AT,
        verified: true,
      });
      expect(first.changed).toBe(true);
      expect(Bun.file(retainedLockPath(dir, lock.lockDigest)).text()).resolves.toBe(
        encodeWorkstationLock(lock),
      );

      const second = activateWorkstationRevision({
        home: dir,
        lock,
        packageSet: revision.packageSet,
        depot: revision.depot,
        activatedAt: AT,
        verified: true,
      });
      expect(second.writes).toEqual([]);
      expect(second.changed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what a rollback restores", () => {
  test("the revision behind the active one, when the last activation verified", () => {
    const a = { key: "a" } as WorkstationRevision;
    const b = { key: "b" } as WorkstationRevision;
    expect(
      rollbackTarget({ schema: 1, active: a, previous: b, rolledBackFrom: null, pending: null }),
    ).toBe(b);
  });

  test("the active one, when an activation is still pending", () => {
    // The machine has already drifted forward into a revision nothing
    // vouched for. The last complete lock that worked is the active
    // record, and walking past it to `previous` would go too far.
    const a = { key: "a" } as WorkstationRevision;
    const b = { key: "b" } as WorkstationRevision;
    const c = { key: "c" } as WorkstationRevision;
    expect(
      rollbackTarget({ schema: 1, active: a, previous: b, rolledBackFrom: null, pending: c }),
    ).toBe(a);
  });

  test("nothing, on a machine holding one revision", async () => {
    const dir = home();
    try {
      const { lock, revision } = await oneRevision(dir, 0);
      activateWorkstationRevision({
        home: dir,
        lock,
        packageSet: revision.packageSet,
        depot: revision.depot,
        activatedAt: AT,
        verified: true,
      });
      const rolled = await rollbackWorkstation({
        home: dir,
        observed: { id: lock.target.id, surfaces: lock.target.surfaces.map((s) => s.id), installed: [], authenticated: [] },
        install: NEVER_INSTALL,
        converge: NO_CONVERGE,
        workers: async () => 0,
        at: AT,
      });
      expect(rolled.outcome).toBe("refused");
      expect(rolled.failure).toBe("empty");
      expect(rolled.code).toBe(1);
      expect(rolled.writes).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what a rollback refuses", () => {
  test("a retained lock that was pruned out from under the record", async () => {
    const dir = home();
    try {
      const older = await oneRevision(dir, 1);
      const newer = await oneRevision(dir, 0);
      writeState(dir, { active: newer.revision, previous: older.revision, rolledBackFrom: null, pending: null });
      // The record still names it; the file is not there.
      rmSync(retainedLockPath(dir, older.lock.lockDigest), { force: true });

      const rolled = await rollbackWorkstation({
        home: dir,
        observed: { id: older.lock.target.id, surfaces: older.lock.target.surfaces.map((s) => s.id), installed: [], authenticated: [] },
        install: NEVER_INSTALL,
        converge: NO_CONVERGE,
        workers: async () => 0,
        at: AT,
      });
      expect(rolled.failure).toBe("lock");
      expect(rolled.reason).toContain(retainedLockPath(dir, older.lock.lockDigest));
      expect(rolled.writes).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a retained lock whose bytes are not the lock it claims to be", async () => {
    const dir = home();
    try {
      const older = await oneRevision(dir, 1);
      const newer = await oneRevision(dir, 0);
      writeState(dir, { active: newer.revision, previous: older.revision, rolledBackFrom: null, pending: null });
      // Somebody else's lock, at the path this revision's digest names.
      writeFileSync(
        retainedLockPath(dir, older.lock.lockDigest),
        encodeWorkstationLock(newer.lock),
      );

      const rolled = await rollbackWorkstation({
        home: dir,
        observed: { id: older.lock.target.id, surfaces: older.lock.target.surfaces.map((s) => s.id), installed: [], authenticated: [] },
        install: NEVER_INSTALL,
        converge: NO_CONVERGE,
        workers: async () => 0,
        at: AT,
      });
      expect(rolled.failure).toBe("lock");
      expect(rolled.reason).toContain("is not the lock");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a package-set tree the record names and nothing holds", async () => {
    const dir = home();
    try {
      const older = await oneRevision(dir, 1, { setDir: false });
      const newer = await oneRevision(dir, 0);
      writeState(dir, { active: newer.revision, previous: older.revision, rolledBackFrom: null, pending: null });

      const rolled = await rollbackWorkstation({
        home: dir,
        observed: { id: older.lock.target.id, surfaces: older.lock.target.surfaces.map((s) => s.id), installed: [], authenticated: [] },
        install: NEVER_INSTALL,
        converge: NO_CONVERGE,
        workers: async () => 0,
        at: AT,
      });
      expect(rolled.failure).toBe("package-set");
      expect(rolled.reason).toContain("no longer there");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a revision with no local artifact store, rather than reaching for one", async () => {
    const dir = home();
    try {
      const older = await oneRevision(dir, 1, { depot: null });
      const newer = await oneRevision(dir, 0);
      writeState(dir, { active: newer.revision, previous: older.revision, rolledBackFrom: null, pending: null });

      const rolled = await rollbackWorkstation({
        home: dir,
        observed: { id: older.lock.target.id, surfaces: older.lock.target.surfaces.map((s) => s.id), installed: [], authenticated: [] },
        install: NEVER_INSTALL,
        converge: NO_CONVERGE,
        workers: async () => 0,
        at: AT,
      });
      // The one refusal that is about this module's own promise: there
      // is no source of bytes here that does not need a network, so
      // there is nothing to do but say so.
      expect(rolled.failure).toBe("artifacts");
      expect(rolled.reason).toContain("reach the network");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("and doctor says the same thing, in the row a person reads", async () => {
    const dir = home();
    try {
      const older = await oneRevision(dir, 1, { setDir: false });
      const newer = await oneRevision(dir, 0);
      writeState(dir, { active: newer.revision, previous: older.revision, rolledBackFrom: null, pending: null });

      const report = workstationRollbackReport(dir);
      expect(report.restorable).toBe(false);
      const rows = workstationRollbackRows(report);
      expect(rows.some((row) => row.status === "err")).toBe(true);
      expect(rows.find((row) => row.status === "err")?.detail).toContain("cannot be performed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the retention", () => {
  test("keeps two complete revisions, and never counts one twice", () => {
    const a = { key: "a" } as WorkstationRevision;
    const b = { key: "b" } as WorkstationRevision;
    expect(
      retainedRevisions({ schema: 1, active: a, previous: b, rolledBackFrom: null, pending: null }),
    ).toHaveLength(WORKSTATION_REVISION_RETENTION);
    // `previous` and `rolledBackFrom` are the same slot from the two
    // directions a machine can have moved, and only one is ever set.
    expect(
      retainedRevisions({ schema: 1, active: a, previous: null, rolledBackFrom: a, pending: null }),
    ).toHaveLength(1);
  });

  test("a failed activation holds the prune and rotates nothing", async () => {
    const dir = home();
    try {
      const [oldest, older] = await activateInOrder(dir, [2, 1]);
      if (oldest === undefined || older === undefined) throw new Error("no");
      const newer = await oneRevision(dir, 0);
      const failed = activateWorkstationRevision({
        home: dir,
        lock: newer.lock,
        packageSet: newer.revision.packageSet,
        depot: newer.revision.depot,
        activatedAt: AT,
        verified: false,
      });

      const state = readWorkstationRevisions(dir);
      expect(state.active?.key).toBe(older.revision.key);
      expect(state.previous?.key).toBe(oldest.revision.key);
      expect(state.pending?.key).toBe(newer.revision.key);
      expect(failed.retention.held).toContain("did not verify");
      // The whole of the fourth criterion: the inputs a rollback needs
      // are still exactly where the last verified run left them.
      expect(existsSync(retainedLockPath(dir, oldest.lock.lockDigest))).toBe(true);
      expect(existsSync(oldest.revision.depot ?? "")).toBe(true);
      expect(applyWorkstationRetention({ home: dir }).removed).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("and the same activation, once it verifies, drops what neither revision needs", async () => {
    const dir = home();
    try {
      const [oldest, older, newer] = await activateInOrder(dir, [2, 1, 0]);
      if (oldest === undefined || older === undefined || newer === undefined) throw new Error("no");
      expect(existsSync(retainedLockPath(dir, oldest.lock.lockDigest))).toBe(false);
      expect(existsSync(oldest.revision.depot ?? "")).toBe(false);
      expect(existsSync(retainedLockPath(dir, older.lock.lockDigest))).toBe(true);
      expect(existsSync(older.revision.depot ?? "")).toBe(true);

      const plan = planWorkstationRetention({ home: dir });
      expect(plan.held).toBeNull();
      expect(plan.prunable).toEqual([]);
      expect(plan.revisions.map((r) => r.key)).toEqual([newer.revision.key, older.revision.key]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("and never the depot copy this machine says it was provisioned from", async () => {
    const dir = home();
    try {
      const [oldest] = await activateInOrder(dir, [2]);
      if (oldest === undefined) throw new Error("no");
      // doctor reports the imported depot by path, so a prune that took
      // it would turn a healthy air-gapped workstation red for having
      // tidied up after itself.
      const statePath = offlineDepotStatePath(dir);
      mkdirSync(join(statePath, ".."), { recursive: true });
      writeFileSync(
        statePath,
        `${JSON.stringify({ schema: 1, imported: { path: oldest.revision.depot } }, null, 2)}\n`,
      );
      await activateInOrder(dir, [1, 0]);

      expect(existsSync(oldest.revision.depot ?? "")).toBe(true);
      const plan = planWorkstationRetention({ home: dir });
      expect(plan.kept.some((entry) => entry.requiredBy.includes("offline depot state"))).toBe(true);
      // Its lock is another matter: no revision needs it, and doctor
      // never reports one by path.
      expect(existsSync(retainedLockPath(dir, oldest.lock.lockDigest))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a machine with no revision at all prunes nothing", () => {
    const dir = home();
    try {
      const plan = planWorkstationRetention({ home: dir });
      expect(plan.held).toContain("no complete revision");
      expect(applyWorkstationRetention({ home: dir }).removed).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("doctor names the lock identity and what retention holds", async () => {
    const dir = home();
    try {
      const [older, newer] = await activateInOrder(dir, [1, 0]);
      if (older === undefined || newer === undefined) throw new Error("no");
      const rows = workstationRollbackRows(workstationRollbackReport(dir));
      expect(rows[0]?.detail).toContain(newer.lock.lockDigest.slice(0, 12));
      expect(rows[0]?.detail).toContain(`${newer.lock.apps.length} exact versions`);
      expect(rows[1]?.detail).toContain(`a rollback restores ${older.revision.key}`);
      expect(rows[2]?.detail).toContain("retention holds 2 complete revision(s)");
      expect(rows.every((row) => row.status !== "err")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
