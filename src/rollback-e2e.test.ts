/**
 * The Ubuntu 24 rollback journey, asserted rather than watched.
 *
 * `bun run e2e:rollback-ubuntu24` prints these checks for a person; this
 * file fails the build when one of them stops holding. Both call the same
 * function, so there is no second definition of what "the rollback E2E
 * passes" means — which is the only way the command in the acceptance
 * criteria and the gate the orchestrator runs can be the same claim.
 */

import { describe, expect, test } from "bun:test";

import {
  rollbackJourneyLines,
  ROLLBACK_TARGET,
  runUbuntu24RollbackJourney,
  SET_RELEASES,
} from "./rollback-e2e.ts";
import { FIXTURE_RELEASE_HISTORY, fixtureReleasesAt } from "./fixtures/workstation-lock/releases.ts";
import type { LockSurface } from "./workstation-lock.ts";

describe("the ubuntu 24.04 rollback journey", () => {
  test("every criterion of the journey holds", async () => {
    const result = await runUbuntu24RollbackJourney();
    const failed = result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    expect(failed).toEqual([]);
    expect(result.ok).toBe(true);

    // Named, so that a journey which quietly stopped making one of these
    // checks fails here rather than passing with fewer of them.
    expect(result.checks.map((c) => c.name)).toEqual([
      "export",
      "provision",
      "pending-retains",
      "pending-target",
      "retention",
      "rollback",
      "versions",
      "untouched",
      "package-set",
      "offline",
      "uninterrupted",
      "reconciled",
      "lock",
      "idempotent",
      "doctor",
      "uninstall",
      "uninstall-idempotent",
    ]);
    expect(result.root).toBeNull();
  });

  test("it rolls back the target the spec names, across three distinct revisions", () => {
    expect(ROLLBACK_TARGET).toBe("ubuntu-24.04-x64");
    expect(new Set(SET_RELEASES.map((r) => r.version)).size).toBe(3);
    expect(new Set(SET_RELEASES.map((r) => r.commit)).size).toBe(3);
  });

  test("each generation moves some applications and leaves the rest alone", () => {
    const current = fixtureReleasesAt(0);
    for (const generation of [1, 2]) {
      const older = fixtureReleasesAt(generation);
      const moved = Object.keys(current).filter(
        (id) => current[id]?.version !== older[id]?.version,
      );
      // The overrides are the whole of the difference: an application
      // nobody moved must be identical, or "restored every observed
      // version" would be true of a rollback that reinstalled the lot.
      expect(moved.sort()).toEqual(Object.keys(FIXTURE_RELEASE_HISTORY[generation] ?? {}).sort());
      expect(moved.length).toBeGreaterThan(0);
      expect(moved.length).toBeLessThan(Object.keys(current).length);
    }
  });

  test("an artifact name carries the version it was moved back to", () => {
    const surface: LockSurface = {
      id: "ubuntu",
      os: "linux",
      distro: "ubuntu",
      version: "24.04",
      arch: "x64",
      env: "desktop",
      role: "both",
    };
    expect(fixtureReleasesAt(0)["vscode"]?.artifact(surface)).toBe("code_1.104.2-1_amd64.deb");
    expect(fixtureReleasesAt(1)["vscode"]?.artifact(surface)).toBe("code_1.104.1-1_amd64.deb");
    // And one whose publisher puts no version in the name is unchanged,
    // which is fine: the checksum is taken over the version as well.
    expect(fixtureReleasesAt(1)["zellij"]?.artifact(surface)).toBe(
      fixtureReleasesAt(0)["zellij"]?.artifact(surface),
    );
  });

  test("the lines a person reads say which check failed", () => {
    const lines = rollbackJourneyLines({
      ok: false,
      target: "ubuntu-24.04-x64",
      root: null,
      checks: [
        { name: "retention", ok: true, detail: "two revisions remain" },
        { name: "rollback", ok: false, detail: "the retained lock is gone" },
      ],
    });
    expect(lines[0]).toBe("ok   retention — two revisions remain");
    expect(lines[1]).toBe("FAIL rollback — the retained lock is gone");
    expect(lines[2]).toContain("ubuntu-24.04-x64 rollback journey: 1 of 2 checks failed");
  });
});
