/**
 * Work deferred for lack of rights is its own outcome, not a failure.
 *
 * The summary already told installed, applied, present, skipped and
 * failed apart. A privileged item on an unelevated run is none of those:
 * nothing broke, nothing was misconfigured, and a machine that converged
 * everything it had the rights for is healthy. Calling it a failure
 * makes that machine read as broken — which is exactly how the SSH
 * server item read.
 *
 * Four properties, in the order they would hurt if they drifted:
 *
 *   A refusal is recognised. The gate's wording is written once in
 *   rights.ts, so a message carrying it came from the gate rather than
 *   from a provider that happened to fail.
 *
 *   A genuine failure is still a failure. The half that keeps the
 *   outcome honest: an outcome that swallows real breakage is worse than
 *   the one it replaced.
 *
 *   Every deferred item is named. A count sends the reader back through
 *   a transcript to learn which of thirty-six items it was.
 *
 *   The exit status tells the three apart, so a script wrapping the
 *   converge knows "done" from "done except the privileged part"
 *   without parsing any of the above.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { convergeExit, outcomeForError } from "./converge.ts";
import { summaryLines, type Entry } from "./report.ts";
import { missingRights, refusedRights } from "./rights.ts";

/** Without the colour, which depends on whether a terminal is watching. */
const plain = (lines: string[]): string[] =>
  lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

function entry(name: string, over: Partial<Entry> = {}): Entry {
  return { scope: "core", name, outcome: "installed", ms: 10, ...over };
}

function deferredEntry(name: string, gate: Parameters<typeof missingRights>[0]): Entry {
  const denied = missingRights(gate);
  return entry(name, { outcome: "deferred", detail: denied.cause, remedy: denied.remedy });
}

describe("recognising a refusal", () => {
  test("a message the gate wrote is a deferral, and names its remedy", () => {
    // The inverse of missingRights, and the reason it can be one: every
    // refusal in this program is worded in the one place, so the bytes
    // coming back are bytes it produced.
    for (const gate of ["sudo", "administrator"] as const) {
      const denied = refusedRights(missingRights(gate).message);
      expect(denied?.gate).toBe(gate);
      expect(denied?.remedy).toBe(missingRights(gate).remedy);
    }
  });

  test("anything else is not", () => {
    expect(refusedRights("apt-get install failed (100)")).toBeNull();
    expect(refusedRights("")).toBeNull();
  });
});

describe("the outcome an error earns", () => {
  test("a gate that refused defers the item", () => {
    const result = outcomeForError(missingRights("administrator").message);
    expect(result.outcome).toBe("deferred");
    // The cause on the row and the remedy beside it, kept apart so the
    // summary can print one per item and the other once per gate.
    expect(result.detail).toBe(missingRights("administrator").cause);
    expect(result.remedy).toBe(missingRights("administrator").remedy);
  });

  test("a genuine failure is still a failure, with its own message", () => {
    const result = outcomeForError("apt has nothing newer than 1.2 for eza");
    expect(result.outcome).toBe("failed");
    expect(result.detail).toBe("apt has nothing newer than 1.2 for eza");
    expect(result.remedy).toBeUndefined();
  });
});

describe("the summary", () => {
  const lines = (entries: Entry[]): string[] => plain(summaryLines(entries, 1_000));

  test("counts deferred work apart from failures", () => {
    const out = lines([
      entry("git"),
      deferredEntry("ssh-server", "administrator"),
      entry("docker", { outcome: "failed", detail: "exit 1" }),
    ]);
    expect(out.some((l) => /^\s*deferred\s+1$/.test(l))).toBe(true);
    expect(out.some((l) => /^\s*failed\s+1$/.test(l))).toBe(true);
  });

  test("says nothing about deferral when there was none", () => {
    // A permanent "deferred 0" on every Ubuntu run is noise that trains
    // people to stop reading the block that matters.
    expect(lines([entry("git")]).some((l) => l.includes("deferred"))).toBe(false);
  });

  test("names each deferred item, rather than counting them", () => {
    const out = lines([
      deferredEntry("ssh-server", "administrator"),
      deferredEntry("windows-terminal", "administrator"),
    ]).join("\n");
    expect(out).toContain("ssh-server");
    expect(out).toContain("windows-terminal");
  });

  test("and the remedy once per gate, not once per item", () => {
    // Two items behind the same locked door share one key. Printing it
    // twice reads as two separate problems.
    const out = lines([
      deferredEntry("ssh-server", "administrator"),
      deferredEntry("windows-terminal", "administrator"),
    ]);
    const remedy = missingRights("administrator").remedy;
    expect(out.filter((l) => l.includes(remedy))).toHaveLength(1);
  });

  test("keeps a deferred item out of the failures", () => {
    const out = lines([
      deferredEntry("ssh-server", "administrator"),
      entry("docker", { outcome: "failed", detail: "exit 1" }),
    ]);
    const failedBlock = out.slice(out.findIndex((l) => /^\s*failed$/.test(l)));
    expect(failedBlock.join("\n")).toContain("docker");
    expect(failedBlock.join("\n")).not.toContain("ssh-server");
  });
});

describe("the exit status", () => {
  test("tells a full converge from one with deferred work", () => {
    // The whole point of the third answer: a wrapper script can act on
    // "done except the privileged part" without reading the summary,
    // and without treating a healthy machine as a broken one.
    expect(convergeExit({ failed: 0, deferred: 0 })).toBe(0);
    expect(convergeExit({ failed: 0, deferred: 1 })).toBe(2);
  });

  test("and a failure still outranks both", () => {
    expect(convergeExit({ failed: 1, deferred: 0 })).toBe(1);
    expect(convergeExit({ failed: 1, deferred: 2 })).toBe(1);
  });
});

describe("the item that made this necessary", () => {
  const source = readFileSync("src/ssh-server.ts", "utf8");

  test("the SSH server hands its refusal to the converge", () => {
    // It used to warn and return, which the converge reads as applied:
    // the one item that regularly runs out of rights was reporting
    // success and printing a warning nobody could act on afterwards.
    expect(source).toContain("throw new RedError(denied.message)");
  });

  test("and still fails when apt itself failed", () => {
    // `sudo -n` refusing and apt refusing are different answers. The
    // first has a remedy; treating the second as one sends an operator
    // to elevate a shell that changes nothing.
    expect(source).toContain('classifyRights(install.out, "sudo")');
  });
});
