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

describe("removing the hotkeys", () => {
  const m = MIGRATIONS.find((x) => x.id === "2026-08-01-remove-hotkeys");

  test("is registered", () => {
    expect(m).toBeDefined();
  });

  test("does not apply to a machine with no Windows behind it", async () => {
    // A Linux desktop never had a Start Menu to write into, and asking
    // Windows about it there would cost a subprocess to learn nothing.
    const linux = {
      os: "linux",
      env: "desktop",
      distro: "ubuntu",
      version: "24.04",
      codename: "noble",
      arch: "x64",
      caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
    };
    expect(await m!.applies(linux as never)).toBe(false);
  });
});
