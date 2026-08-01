/**
 * The ledger, and the one migration that deletes.
 *
 * A converge fixes what is missing. Removing a feature leaves the
 * opposite problem: nothing is missing, and what is there should not be.
 * Global hotkeys were exactly that — a .lnk keeps its hotkey forever, so
 * dropping the code that wrote them would have left Ctrl+Alt+T bound on
 * every machine that had already run it, with the red-dev on that
 * machine no longer having any idea why.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MIGRATIONS } from "./migrations.ts";

describe("the ledger", () => {
  test("ids are unique, because the ledger is keyed on them", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("ids sort in the order they were written", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect([...ids].sort()).toEqual(ids);
  });

  test("every id starts with the date it was written", () => {
    for (const m of MIGRATIONS) {
      expect(m.id).toMatch(/^\d{4}-\d{2}-\d{2}-/);
    }
  });

  test("every migration says what it does in one line", () => {
    for (const m of MIGRATIONS) {
      expect(m.describe.length).toBeGreaterThan(10);
      expect(m.describe).not.toContain("\n");
    }
  });
});

describe("the migration that removed the hotkeys", () => {
  test("is gone, because the hotkeys came back", () => {
    // It deleted the Start Menu folder red-dev writes. With the feature
    // restored, a machine whose ledger had not yet recorded it would
    // have the shortcuts written by the converge and deleted by the
    // repair pass in the same run — the outcome depending on which ran
    // first, which is the worst kind of bug to own.
    expect(MIGRATIONS.map((m) => m.id)).not.toContain("2026-08-01-remove-hotkeys");
  });

  test("and nothing else in the ledger removes anything", () => {
    // The rule at the top of migrations.ts: a migration may repair and
    // must not remove. The hotkey one was the single exception and it
    // no longer exists.
    const src = readFileSync("src/migrations.ts", "utf8");
    expect(src).not.toContain("Remove-Item");
  });
});
