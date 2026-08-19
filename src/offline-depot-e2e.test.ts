/**
 * The Ubuntu 24 offline journey, asserted rather than watched.
 *
 * `bun run e2e:offline-ubuntu24` prints these checks for a person; this
 * file fails the build when one of them stops holding. Both call the same
 * function, so there is no second definition of what "the offline E2E
 * passes" means — which is the only way the command in the acceptance
 * criteria and the gate the orchestrator runs can be the same claim.
 */

import { describe, expect, test } from "bun:test";

import {
  CODER_CLIS,
  COMPANIONS,
  journeyLines,
  JOURNEY_TARGET,
  runUbuntu24OfflineJourney,
} from "./offline-depot-e2e.ts";

describe("the ubuntu 24.04 offline depot journey", () => {
  test("every criterion of the journey holds", async () => {
    const result = await runUbuntu24OfflineJourney();
    const failed = result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    expect(failed).toEqual([]);
    expect(result.ok).toBe(true);

    // Named, so that a journey which quietly stopped making one of these
    // checks fails here rather than passing with fewer of them.
    expect(result.checks.map((c) => c.name)).toEqual([
      "export",
      "manifest",
      "lock",
      "checksums",
      "import",
      "offline",
      "machine-owned",
      "coder-clis",
      "companions",
      "activation",
      "package-set",
      "credentials",
      "second-converge",
      "zero-drift",
      "doctor",
    ]);
    expect(result.root).toBeNull();
  });

  test("it provisions the target the spec names, with seven CLIs and seven companions", () => {
    expect(JOURNEY_TARGET).toBe("ubuntu-24.04-x64");
    expect(CODER_CLIS).toHaveLength(7);
    expect(new Set([...CODER_CLIS, ...COMPANIONS]).size).toBe(CODER_CLIS.length + COMPANIONS.length);
  });

  test("the lines a person reads say which check failed", () => {
    const lines = journeyLines({
      ok: false,
      root: null,
      checks: [
        { name: "export", ok: true, detail: "depot exported" },
        { name: "import", ok: false, detail: "entry checksum mismatch" },
      ],
    });
    expect(lines[0]).toBe("ok   export — depot exported");
    expect(lines[1]).toBe("FAIL import — entry checksum mismatch");
    expect(lines[2]).toContain("1 of 2 checks failed");
  });
});
