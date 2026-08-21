/**
 * The staged reconciliation, and the two rules that make it one.
 *
 * Every assertion here is one sentence of ADR 0010's convergence
 * paragraph: a failed surface does not roll back the ones that verified,
 * running coder sessions are never terminated, and an active Worker
 * stages the complete revision instead of moving the ground under it.
 *
 * Walked rather than described, because a rule stated in a comment and a
 * rule the walk executes are two different things — and the whole point
 * of this module is that `red-dev update` and `mise upgrade red-skills`
 * cannot execute two.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import type { Acquisition } from "./red-skills-acquire.ts";
import type { CompanionOutcome } from "./red-skills-companions.ts";
import type { HostOutcome } from "./red-skills-hosts.ts";
import {
  packageSetStatePath,
  type PackageSetRevision,
  type PackageSetState,
} from "./red-skills-set.ts";
import {
  acquisitionSurface,
  companionSurface,
  hostSurface,
  lockSurface,
  readStagedUpdate,
  runStagedUpdate,
  stagedUpdateOutcome,
  stagedUpdateReport,
  stagedUpdateRows,
  UPDATE_SURFACES,
  type StagedUpdateOptions,
  type SurfaceOutcome,
  type UpdateSurface,
} from "./staged-update.ts";

const fakeHome = (): string => mkdtempSync(`${tmpdir()}/red-staged-`);

/** One acquisition, in whichever of its five endings a case needs. */
function acquisition(
  outcome: Acquisition["outcome"],
  reason: string = outcome,
  failure: Acquisition["failure"] = outcome === "refused" ? "signature" : null,
): Acquisition {
  return {
    outcome,
    reason,
    failure,
    selector: null,
    commit: null,
    version: null,
    mirror: null,
    snapshot: null,
    candidate: null,
    active: null,
    staged: null,
    writes: [],
  };
}

function host(name: string, over: Partial<HostOutcome> = {}): HostOutcome {
  return { host: name, status: "reconciled", reload: "current", ...over };
}

function companion(name: CompanionOutcome["companion"], over: Partial<CompanionOutcome> = {}): CompanionOutcome {
  return { companion: name, status: "reconciled", reload: "current", ...over };
}

const SEVEN = ["claude-code", "codex", "opencode", "redcode", "gemini", "pi", "hermes"];

/** A machine holding one active revision, and nothing staged. */
function machine(home: string, over: Partial<PackageSetState> = {}): PackageSetState {
  const active: PackageSetRevision = {
    key: "3.19.5+0123456789ab",
    version: "3.19.5",
    digest: "0123456789ab".repeat(5) + "0123",
    sourceCommit: "626a28473edeee992fcf6425dedbca84448343fd",
    kind: "manifest",
    trust: "trusted",
    path: `${home}/.red/skills/sets/3.19.5+0123456789ab`,
  };
  const state: PackageSetState = {
    schema: 1,
    active: active.key,
    revisions: [active],
    refused: null,
    staged: null,
    ...over,
  };
  return state;
}

/** Put a package-set state on disk, creating its directory. */
function record(home: string, state: PackageSetState): void {
  const path = packageSetStatePath(home);
  mkdirSync(`${home}/.red/skills`, { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** A run with every surface injected, so the walk is what is under test. */
function walk(home: string, over: Partial<StagedUpdateOptions> = {}) {
  return runStagedUpdate({
    home,
    env: { HOME: home },
    workers: async () => 0,
    acquire: async () => acquisition("acquired", "3.19.6 acquired"),
    converge: async () => ({
      hosts: SEVEN.map((h) => host(h)),
      companions: [companion("redskilled"), companion("herdr")],
    }),
    lock: async () => ({ ok: false, present: false, reason: "no workstation lock" }),
    ...over,
  });
}

const stateOf = (run: { surfaces: SurfaceOutcome[] }) =>
  Object.fromEntries(run.surfaces.map((s) => [s.surface, s.state])) as Record<UpdateSurface, string>;

// --------------------------------------------------------- the translations

describe("one surface's own vocabulary, in the shared one", () => {
  test("a refused acquisition fails the surface; an unreachable one does not", () => {
    expect(acquisitionSurface(acquisition("refused")).state).toBe("failed");
    // A laptop on a train changed nothing and is not a broken machine.
    expect(acquisitionSurface(acquisition("unreachable")).state).toBe("verified");
    expect(acquisitionSurface(acquisition("current")).state).toBe("verified");
    expect(acquisitionSurface(acquisition("unavailable")).state).toBe("skipped");
  });

  test("declining an unsigned composed set is the guard working, not a failed surface", () => {
    // What every converge produces: mise installs the npm payloads, and
    // red-dev reconciles after each one on a machine that already
    // resolves a verified set. Recording it as failed stamped a healthy
    // workstation's update.json with `outcome: "failed"`.
    const declined = acquisitionSurface(
      acquisition("refused", "an unsigned composed one cannot replace it", "downgrade"),
    );
    expect(declined.state).toBe("skipped");
    // Still said out loud, and still carried in the record: the reason
    // and the outcome are unchanged, only the verdict on the machine is.
    expect(declined.acquisition).toBe("refused");
    expect(declined.reason).toContain("cannot replace it");
    // Every other refusal is still a failure — a bad signature is not a
    // machine declining, it is a machine finding something wrong.
    expect(acquisitionSurface(acquisition("refused", "bad", "signature")).state).toBe("failed");
    expect(acquisitionSurface(acquisition("refused", "bad", "tree")).state).toBe("failed");
  });

  test("a declined downgrade leaves the run converged, not failed", () => {
    // The whole point: the outcome the machine records about itself.
    expect(
      stagedUpdateOutcome([
        acquisitionSurface(acquisition("refused", "composed set declined", "downgrade")),
        hostSurface(SEVEN.map((h) => host(h))),
        companionSurface([companion("redskilled")]),
      ]),
    ).toBe("converged");
  });

  test("a blocked host fails the surface, and an absent one does not", () => {
    expect(hostSurface(SEVEN.map((h) => host(h))).state).toBe("verified");
    expect(hostSurface([host("gemini", { status: "absent" })]).state).toBe("verified");
    const failed = hostSurface([host("pi"), host("hermes", { status: "blocked", reason: "no adapter" })]);
    expect(failed.state).toBe("failed");
    expect(failed.reason).toContain("hermes (no adapter)");
  });

  test("a companion the set does not carry yet is not a failure", () => {
    expect(companionSurface([companion("vscode", { status: "unavailable" })]).state).toBe("verified");
    expect(companionSurface([companion("redskilled", { status: "failed" })]).state).toBe("failed");
  });

  test("a lock nobody resolved is skipped; one that is there and wrong fails", () => {
    expect(lockSurface({ ok: false, present: false, reason: "none" }).state).toBe("skipped");
    expect(lockSurface({ ok: false, present: true, reason: "not canonical" }).state).toBe("failed");
  });
});

// ----------------------------------------------------------- the verdicts

describe("what the surfaces add up to", () => {
  const surface = (surfaceName: UpdateSurface, state: SurfaceOutcome["state"]): SurfaceOutcome => ({
    surface: surfaceName,
    state,
    reason: state,
    restartNeeded: [],
  });

  test("partial and failed are the same exit code and a different machine", () => {
    expect(stagedUpdateOutcome([surface("acquisition", "verified"), surface("hosts", "failed")])).toBe("partial");
    expect(stagedUpdateOutcome([surface("acquisition", "failed"), surface("hosts", "failed")])).toBe("failed");
    expect(stagedUpdateOutcome([surface("acquisition", "verified"), surface("hosts", "skipped")])).toBe("converged");
    expect(stagedUpdateOutcome([surface("acquisition", "verified"), surface("hosts", "pending")])).toBe("staged");
  });

  test("a failure outranks a pending surface", () => {
    // Acquisition refused under a running Worker: nothing was staged, so
    // reporting "staged" would name a revision that is not on the disk.
    expect(stagedUpdateOutcome([surface("acquisition", "failed"), surface("hosts", "pending")])).toBe("failed");
  });
});

// --------------------------------------------------------------- the walk

describe("a forced failure", () => {
  test("returns overall failure and preserves every surface that verified", async () => {
    const home = fakeHome();
    record(home, machine(home));
    const run = await walk(home, {
      converge: async () => ({
        hosts: [...SEVEN.slice(0, 6).map((h) => host(h)), host("hermes", { status: "failed", reason: "generator exited 1" })],
        companions: [companion("redskilled")],
      }),
    });
    expect(run.outcome).toBe("partial");
    expect(run.code).toBe(1);
    // The acquisition is not undone by the host that came after it, and
    // the companions after the failed host still ran.
    expect(stateOf(run)).toEqual({
      acquisition: "verified",
      hosts: "failed",
      companions: "verified",
      lock: "skipped",
    });
  });

  test("a companion failure is the same shape", async () => {
    const home = fakeHome();
    record(home, machine(home));
    const run = await walk(home, {
      converge: async () => ({
        hosts: SEVEN.map((h) => host(h)),
        companions: [companion("redskilled", { status: "blocked", reason: "daemon is held by another owner" })],
      }),
    });
    expect(run.outcome).toBe("partial");
    expect(stateOf(run).hosts).toBe("verified");
    expect(stateOf(run).companions).toBe("failed");
  });

  test("succeeds on retry, with the failure the only thing left to do", async () => {
    const home = fakeHome();
    record(home, machine(home));
    let attempt = 0;
    const converge = async () => {
      attempt += 1;
      return {
        hosts:
          attempt === 1
            ? [...SEVEN.slice(0, 6).map((h) => host(h)), host("hermes", { status: "failed", reason: "generator exited 1" })]
            : SEVEN.map((h) => host(h)),
        companions: [companion("redskilled")],
      };
    };
    expect((await walk(home, { converge })).code).toBe(1);
    const retry = await walk(home, { converge });
    expect(retry.outcome).toBe("converged");
    expect(retry.code).toBe(0);
    // And the record no longer names a failed surface.
    expect(stagedUpdateReport(home).failed).toEqual([]);
  });
});

describe("running coder sessions", () => {
  test("nothing on the update path can signal a process", () => {
    // Structural, not behavioural, because the guarantee is an absence:
    // no test that runs the walk can prove that a path it did not take
    // holds no `kill`. The three modules an update advances surfaces
    // through are read instead, and none of them may carry one.
    for (const file of [
      "./staged-update.ts",
      "./red-skills-hosts.ts",
      "./red-skills-companions.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8")
        .split("\n")
        // Prose is allowed to say "never a kill"; code is not allowed to
        // issue one.
        .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
        .join("\n");
      expect(source).not.toMatch(/\b(?:pkill|taskkill|SIGKILL|SIGTERM)\b/);
      expect(source).not.toMatch(/\.kill\(|process\.kill\b/);
    }
  });


  test("are never terminated: the host is reconciled and owed a restart", async () => {
    const home = fakeHome();
    record(home, machine(home));
    const run = await walk(home, {
      converge: async () => ({
        hosts: [
          host("claude-code", { reload: "restart-needed" }),
          host("codex", { reload: "restart-needed" }),
          ...SEVEN.slice(2).map((h) => host(h)),
        ],
        companions: [companion("herdr", { reload: "restart-needed" })],
      }),
    });
    // Reconciled, not failed: the disk moved and the process was left alone.
    expect(run.outcome).toBe("converged");
    expect(run.code).toBe(0);
    expect(run.restartNeeded).toEqual(["claude-code", "codex", "herdr"]);
    expect(stagedUpdateReport(home).restartNeeded).toEqual(["claude-code", "codex", "herdr"]);
  });

  test("stop being owed a restart once a fresh session has observed the revision", async () => {
    const home = fakeHome();
    record(home, machine(home));
    await walk(home, {
      converge: async () => ({
        hosts: [host("claude-code", { reload: "restart-needed" }), ...SEVEN.slice(1).map((h) => host(h))],
        companions: [],
      }),
    });
    expect(stagedUpdateReport(home).restartNeeded).toEqual(["claude-code"]);
    await walk(home);
    expect(stagedUpdateReport(home).restartNeeded).toEqual([]);
  });
});

describe("an active Worker", () => {
  test("lets acquisition complete and holds every other surface", async () => {
    const home = fakeHome();
    record(home, machine(home));
    const told: boolean[] = [];
    const convergedCalls: string[] = [];
    const run = await walk(home, {
      workers: async () => 2,
      acquire: async (stageOnly) => {
        told.push(stageOnly);
        return acquisition("acquired", "3.19.6 staged");
      },
      converge: async () => {
        convergedCalls.push("converge");
        return { hosts: [], companions: [] };
      },
    });
    // The acquisition ran, and it was told not to activate what it verified.
    expect(told).toEqual([true]);
    expect(run.outcome).toBe("staged");
    expect(run.code).toBe(0);
    // Nothing else was even asked: the hosts, the companions and the
    // daemon stay on the lock the Worker is working against.
    expect(convergedCalls).toEqual([]);
    expect(stateOf(run)).toEqual({
      acquisition: "verified",
      hosts: "pending",
      companions: "pending",
      lock: "pending",
    });
    expect(run.active?.version).toBe("3.19.5");
  });

  test("is reported as pending, by surface, with the Worker count", async () => {
    const home = fakeHome();
    record(home, machine(home));
    await walk(home, { workers: async () => 3, acquire: async () => acquisition("acquired") });
    const report = stagedUpdateReport(home);
    expect(report.outcome).toBe("staged");
    expect(report.pending).toEqual(["hosts", "companions", "lock"]);
    expect(report.workers).toBe(3);
    const row = stagedUpdateRows(report).find((r) => r.detail.includes("pending on 3 active Worker"))!;
    expect(row.status).toBe("warn");
  });

  test("an unknown daemon is not a busy one", async () => {
    // A workstation that runs no daemon has no Workers to protect, and an
    // update that held its activation on an unanswerable question would
    // never activate anything there at all.
    const home = fakeHome();
    record(home, machine(home));
    const told: boolean[] = [];
    const run = await walk(home, {
      workers: async () => null,
      acquire: async (stageOnly) => {
        told.push(stageOnly);
        return acquisition("acquired");
      },
    });
    expect(told).toEqual([false]);
    expect(run.outcome).toBe("converged");
  });

  test("a refused acquisition under a Worker is a failure, not a staging", async () => {
    const home = fakeHome();
    record(home, machine(home));
    const run = await walk(home, {
      workers: async () => 1,
      acquire: async () => acquisition("refused", "manifest signature is invalid"),
    });
    expect(run.outcome).toBe("failed");
    expect(run.code).toBe(1);
  });
});

describe("completing the Worker", () => {
  test("activates the staged revision without acquiring anything", async () => {
    const home = fakeHome();
    const staged: PackageSetRevision = {
      key: "3.19.6+abcdefabcdef",
      version: "3.19.6",
      digest: "abcdefabcdef".repeat(5) + "abcd",
      sourceCommit: "f".repeat(40),
      kind: "manifest",
      trust: "trusted",
      path: `${home}/.red/skills/sets/3.19.6+abcdefabcdef`,
    };
    record(home, machine(home, { staged }));

    // What doctor says while the Worker is still holding it.
    const held = stagedUpdateReport(home);
    expect(held.active?.version).toBe("3.19.5");
    expect(held.staged?.version).toBe("3.19.6");

    // The run that finds the queue drained. The acquisition it is given
    // is the real default's answer for "the staged revision was
    // activated" — no selector, no commit resolved, nothing fetched.
    const run = await walk(home, {
      workers: async () => 0,
      acquire: async () => {
        record(home, machine(home, { active: staged.key, revisions: [staged], staged: null }));
        return acquisition("acquired", "the staged revision was activated — nothing was acquired");
      },
    });
    expect(run.outcome).toBe("converged");
    expect(run.active?.version).toBe("3.19.6");
    expect(run.staged).toBeNull();
    expect(stagedUpdateReport(home).staged).toBeNull();
  });
});

describe("what doctor reads", () => {
  test("a machine that has never updated says so, and claims nothing", () => {
    const home = fakeHome();
    const report = stagedUpdateReport(home);
    expect(report).toEqual({
      outcome: null,
      active: null,
      staged: null,
      pending: [],
      failed: [],
      restartNeeded: [],
      workers: null,
    });
    expect(stagedUpdateRows(report)).toEqual([
      { status: "n/a", detail: "no staged update has run on this machine" },
    ]);
  });

  test("exposes active, staged, pending, failed, partial and restart-needed", async () => {
    const home = fakeHome();
    record(home, machine(home));
    await walk(home, {
      converge: async () => ({
        hosts: [host("claude-code", { reload: "restart-needed" }), host("hermes", { status: "failed", reason: "no adapter" })],
        companions: [companion("redskilled")],
      }),
    });
    const report = stagedUpdateReport(home);
    expect(report.outcome).toBe("partial");
    expect(report.active?.version).toBe("3.19.5");
    expect(report.failed).toEqual(["hosts"]);
    expect(report.restartNeeded).toEqual(["claude-code"]);
    const rows = stagedUpdateRows(report);
    expect(rows[0]!.status).toBe("err");
    expect(rows.some((r) => r.detail === "not converged: hosts")).toBe(true);
    expect(rows.some((r) => r.detail.startsWith("restart needed"))).toBe(true);
  });

  test("the record is one file, rewritten only when the run differs", async () => {
    const home = fakeHome();
    record(home, machine(home));
    await walk(home);
    const first = readFileSync(`${home}/.red/skills/update.json`, "utf8");
    await walk(home);
    expect(readFileSync(`${home}/.red/skills/update.json`, "utf8")).toBe(first);
    expect(readStagedUpdate(home)?.outcome).toBe("converged");
  });

  test("a record this build cannot read is no record rather than an error", () => {
    const home = fakeHome();
    record(home, machine(home));
    mkdirSync(`${home}/.red/skills`, { recursive: true });
    writeFileSync(`${home}/.red/skills/update.json`, "{ not json", "utf8");
    expect(readStagedUpdate(home)).toBeNull();
    expect(stagedUpdateReport(home).outcome).toBeNull();
  });
});

describe("the order", () => {
  test("is acquisition, hosts, companions, lock — and every surface is named once", async () => {
    const home = fakeHome();
    record(home, machine(home));
    const run = await walk(home);
    expect(run.surfaces.map((s) => s.surface)).toEqual([...UPDATE_SURFACES]);
    expect(new Set(UPDATE_SURFACES).size).toBe(UPDATE_SURFACES.length);
  });
});
