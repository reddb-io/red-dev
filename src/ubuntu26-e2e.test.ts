/**
 * The Ubuntu 26 journey, asserted rather than watched.
 *
 * `bun run e2e:offline-ubuntu26` prints these checks for a person; this
 * file fails the build when one of them stops holding. Both call the
 * same function, so there is no second definition of what "the Ubuntu 26
 * offline E2E passes" means — which is the only way the command in the
 * acceptance criteria and the gate the orchestrator runs can be the same
 * claim.
 *
 * The other thing asserted here is the one #213 is really about: that
 * the second Ubuntu costs a row of `WORKSTATION_TARGETS` and a fixture,
 * and not one line of acquisition, import or reconciliation of its own.
 */

import { describe, expect, test } from "bun:test";

import { runOfflineDepotJourney } from "./offline-depot-e2e.ts";
import { runRollbackJourney } from "./rollback-e2e.ts";
import { runUbuntu26Journey, UBUNTU_26_TARGET, ubuntu26JourneyLines } from "./ubuntu26-e2e.ts";

describe("the ubuntu 26.04 offline journey", () => {
  test("every criterion of the journey holds", async () => {
    const result = await runUbuntu26Journey();
    const failed = result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    expect(failed).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.target).toBe(UBUNTU_26_TARGET);
    expect(result.root).toBeNull();

    // Named, so that a journey which quietly stopped making one of these
    // checks fails here rather than passing with fewer of them.
    expect(result.checks.map((c) => c.name)).toEqual([
      "depot:target-fit",
      "depot:export",
      "depot:manifest",
      "depot:lock",
      "depot:checksums",
      "depot:import",
      "depot:offline",
      "depot:machine-owned",
      "depot:coder-clis",
      "depot:companions",
      "depot:activation",
      "depot:package-set",
      "depot:credentials",
      "depot:second-converge",
      "depot:zero-drift",
      "depot:doctor",
      "revision:export",
      "revision:provision",
      "revision:pending-retains",
      "revision:pending-target",
      "revision:retention",
      "revision:rollback",
      "revision:versions",
      "revision:untouched",
      "revision:package-set",
      "revision:offline",
      "revision:uninterrupted",
      "revision:reconciled",
      "revision:lock",
      "revision:idempotent",
      "revision:doctor",
      "revision:uninstall",
      "revision:uninstall-idempotent",
      "parity",
    ]);
  }, 60_000);

  test("it is the same journey the Ubuntu 24 desktop runs, on a different target", async () => {
    const [older, newer] = await Promise.all([
      runOfflineDepotJourney({ target: "ubuntu-24.04-x64" }),
      runOfflineDepotJourney({ target: UBUNTU_26_TARGET }),
    ]);
    expect(newer.checks.map((c) => c.name)).toEqual(older.checks.map((c) => c.name));
    expect(newer.checks.map((c) => c.ok)).toEqual(older.checks.map((c) => c.ok));
    expect(newer.target).toBe(UBUNTU_26_TARGET);
    expect(older.target).toBe("ubuntu-24.04-x64");
  }, 60_000);

  test("the rollback journey runs on Ubuntu 26 too, and ends with nothing installed", async () => {
    const result = await runRollbackJourney({ target: UBUNTU_26_TARGET });
    const failed = result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    expect(failed).toEqual([]);
    expect(result.target).toBe(UBUNTU_26_TARGET);
    expect(result.checks.find((c) => c.name === "uninstall")?.ok).toBe(true);
  }, 60_000);

  test("the lines a person reads name the target and the check that failed", () => {
    const lines = ubuntu26JourneyLines({
      ok: false,
      target: UBUNTU_26_TARGET,
      root: null,
      checks: [
        { name: "depot:import", ok: true, detail: "imported" },
        { name: "parity", ok: false, detail: "the two targets disagree" },
      ],
    });
    expect(lines[0]).toBe("ok   depot:import — imported");
    expect(lines[1]).toBe("FAIL parity — the two targets disagree");
    expect(lines[2]).toContain("ubuntu-26.04-x64 offline journey: 1 of 2 checks failed");
  });
});
