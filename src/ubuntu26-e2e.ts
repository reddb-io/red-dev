/**
 * The Ubuntu 26 offline journey, end to end, in one function.
 *
 * #213 asks for one thing that no single existing journey answers: that
 * a release this project has never shipped on can be provisioned, moved
 * forward, held, rolled back and removed entirely from a medium, with no
 * network — and that doing so cost no second implementation of any of
 * it. The first half of that claim is two journeys that already exist,
 * run against a different target. The second half is not provable by
 * running anything on Ubuntu 26 at all: it is only visible by running
 * both targets and finding the same checks with the same verdicts.
 *
 * So this is composition and nothing else. There is deliberately no
 * export, import, install, retention or reconciliation code here — if a
 * line of it appeared, the criterion it exists to prove would be false.
 *
 * ## What the three parts are
 *
 *   - `depot:*` — src/offline-depot-e2e.ts on `ubuntu-26.04-x64`: the
 *     target refuses another machine's builds, a connected machine cuts
 *     a depot, a clean network-denied one installs the complete
 *     workstation from it, and a second converge writes nothing.
 *   - `revision:*` — src/rollback-e2e.ts on the same target: three
 *     revisions, an update held while it was still in doubt, a full-lock
 *     rollback with nothing terminated, and the uninstall.
 *   - `parity` — the same depot journey on `ubuntu-24.04-x64`, compared
 *     check by check. Names and verdicts, not details: the details name
 *     digests and versions that are *supposed* to differ, and comparing
 *     them would be asserting that the two machines are the same machine
 *     rather than that they are held to the same contract.
 *
 * Both halves build their own machines under one root, so `--keep`
 * leaves an operator with the depot run and the revision run side by
 * side rather than with one of them.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UBUNTU, UBUNTU_26 } from "./fixtures/offline-depot/rehearsal.ts";
import {
  journeyLines,
  runOfflineDepotJourney,
  type JourneyCheck,
  type JourneyOptions,
  type JourneyResult,
} from "./offline-depot-e2e.ts";
import { runRollbackJourney } from "./rollback-e2e.ts";

/** The target this journey provisions, named once. */
export const UBUNTU_26_TARGET = UBUNTU_26;

/** The target it is held to the same contract as. */
export const PARITY_TARGET = UBUNTU;

/** One journey's checks, under a prefix that says which half made them. PURE. */
function under(prefix: string, checks: readonly JourneyCheck[]): JourneyCheck[] {
  return checks.map((check) => ({ ...check, name: `${prefix}:${check.name}` }));
}

/**
 * Run the whole Ubuntu 26 journey and report what held.
 *
 * Every check is recorded rather than thrown, for the reason both halves
 * record rather than throw: an operator reading a red run wants the
 * whole shape of what broke, not the first fact that stopped being true.
 */
export async function runUbuntu26Journey(opts: JourneyOptions = {}): Promise<JourneyResult> {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "red-ubuntu26-journey-"));
  const at = opts.at ?? "2026-08-19T00:00:00Z";
  const target = opts.target ?? UBUNTU_26_TARGET;
  const half = { at, keep: opts.keep };

  const depot = await runOfflineDepotJourney({ ...half, target, root: join(root, "depot") });
  const revisions = await runRollbackJourney({ ...half, target, root: join(root, "revisions") });
  const parity = await runOfflineDepotJourney({
    ...half,
    target: PARITY_TARGET,
    root: join(root, "parity"),
  });

  const names = depot.checks.map((c) => c.name).join(",");
  const verdicts = depot.checks.map((c) => c.ok).join(",");
  const same =
    names === parity.checks.map((c) => c.name).join(",") &&
    verdicts === parity.checks.map((c) => c.ok).join(",");

  const checks: JourneyCheck[] = [
    ...under("depot", depot.checks),
    ...under("revision", revisions.checks),
    {
      name: "parity",
      ok: same,
      detail: same
        ? `${target} and ${PARITY_TARGET} answer the same ${depot.checks.length} checks the same way, from one implementation`
        : `${target} and ${PARITY_TARGET} do not answer the same checks: ${disagreement(depot, parity)}`,
    },
  ];

  if (!opts.keep) rmSync(root, { recursive: true, force: true });
  return {
    ok: checks.every((c) => c.ok),
    target,
    checks,
    root: opts.keep ? root : null,
  };
}

/** Which checks the two targets disagree about, as a sentence. PURE. */
function disagreement(a: JourneyResult, b: JourneyResult): string {
  const other = new Map(b.checks.map((c) => [c.name, c.ok]));
  const differing = a.checks
    .filter((c) => other.get(c.name) !== c.ok)
    .map((c) => `${c.name} (${a.target} ${c.ok ? "ok" : "failed"})`);
  const absent = a.checks.filter((c) => !other.has(c.name)).map((c) => `${c.name} (only here)`);
  const extra = b.checks
    .filter((c) => !a.checks.some((x) => x.name === c.name))
    .map((c) => `${c.name} (only on ${b.target})`);
  return [...differing, ...absent, ...extra].join("; ") || "the checks came back in a different order";
}

/** The journey as lines, for the command that runs it. PURE. */
export function ubuntu26JourneyLines(result: JourneyResult): string[] {
  return journeyLines(result, "offline journey");
}
