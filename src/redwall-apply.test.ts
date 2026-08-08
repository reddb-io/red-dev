/**
 * The half of Redwall that reaches a screen.
 *
 * `redwall-generate.test.ts` owns the question of whether the image
 * arrives and where; this owns what happens to it afterwards, which is
 * the whole difference between a feature and a directory of 4K PNGs
 * nobody points at.
 *
 * The `show` seam is why any of this is assertable. Its default repaints
 * the desktop of the machine running the test — `gsettings` on a Linux
 * desk, PowerShell across the WSL boundary — so a suite that let it run
 * would either do nothing on CI or change the wallpaper of whoever ran
 * `bun test` at their desk. Replacing it turns "the desktop is now
 * pointed at this file" into a value.
 */

import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { Platform } from "./platform.ts";
import { writePreferences } from "./preferences.ts";
import type { RedwallState } from "./redwall-render.ts";
import { applyRedwall, redwallDir } from "./redwall.ts";

const desktop: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

const server: Platform = { ...desktop, env: "server", caps: { ...desktop.caps, gui: false } };

const running: RedwallState = { workers: 3, address: "192.168.1.42" };

/** A machine with nothing on it, torn down with the process. */
async function onFreshMachine<T>(run: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env["HOME"];
  const home = mkdtempSync(`${tmpdir()}/red-dev-redwall-apply-`);
  process.env["HOME"] = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
  }
}

/**
 * A desktop that remembers what it was last pointed at, which is also
 * the honest answer to the sweep's "what is on screen" question.
 */
function screen() {
  const shown: string[] = [];
  return {
    shown,
    current: () => shown.at(-1) ?? null,
    apply: (p: Platform, slug: string) =>
      applyRedwall(p, slug, {
        state: async () => running,
        inUse: async () => shown.at(-1) ?? null,
        show: async (path: string) => {
          shown.push(path);
          return true;
        },
      }),
  };
}

const listing = async (p: Platform): Promise<string[]> => {
  const dir = await redwallDir(p);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

describe("applying a Redwall", () => {
  test("draws on the theme it was handed, not the one on file", async () => {
    // The reason this argument exists. `red-dev theme` applies the new
    // theme before anything records it, so the preference still names
    // the old one at the moment the surfaces run — a Redwall that read
    // it would compose this machine's state over the art the user just
    // switched away from and then put that on screen.
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });

      const s = screen();
      const outcome = await s.apply(desktop, "marble");

      expect(outcome.shown).toBe(true);
      expect(outcome.path).toMatch(/\/marble-[0-9a-f]{8}\.png$/);
      expect(s.current()).toBe(outcome.path);
    });
  });

  test("switching themes replaces what is on screen, and leaves nothing behind", async () => {
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });

      const s = screen();
      const first = await s.apply(desktop, "obsidian");
      const second = await s.apply(desktop, "flare");

      // The desktop moved. Not merely "a new file exists": the previous
      // theme's art was on screen a moment ago and is not now.
      expect(s.shown).toEqual([first.path!, second.path!]);
      expect(second.path).not.toBe(first.path);

      // And the superseded image is gone rather than accumulating —
      // spared only while it was the one being displayed.
      expect(await listing(desktop)).toEqual([second.path!.split("/").pop()!]);
      expect(existsSync(first.path!)).toBe(false);
    });
  });

  test("switching back and forth does not leave a Redwall per theme", async () => {
    // A user trying the six themes in a row is six 4K PNGs if the sweep
    // only ever spares. The one on screen is the only survivor.
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });

      const s = screen();
      for (const slug of ["dark", "light", "cobalt", "dark"]) {
        await s.apply(desktop, slug);
      }

      expect(await listing(desktop)).toHaveLength(1);
      expect(s.current()).toContain("/dark-");
    });
  });

  test("with the preference off nothing is drawn and nothing is shown", async () => {
    await onFreshMachine(async () => {
      const s = screen();
      const outcome = await s.apply(desktop, "marble");

      expect(outcome.skipped).toBe("off");
      expect(outcome.shown).toBe(false);
      expect(s.shown).toEqual([]);
      // The desktop keeps whatever it had: a surface that was not asked
      // for must not repaint anything, not even back to the plain art.
      expect(existsSync(await redwallDir(desktop))).toBe(false);
    });
  });

  test("a headless machine is never repainted, whatever the preference says", async () => {
    await onFreshMachine(async () => {
      await writePreferences(server, { redwall: true, theme: "dark" });

      const s = screen();
      const outcome = await s.apply(server, "marble");

      expect(outcome.skipped).toBe("headless");
      expect(outcome.shown).toBe(false);
      expect(s.shown).toEqual([]);
    });
  });

  test("an image that could not be shown does not report that it was", async () => {
    // A desktop can refuse — no gsettings, a PowerShell that is not
    // reachable across the boundary. The file is still correct and still
    // on disk; the claim that anybody can see it is what is false, and
    // the surface reports skipped rather than applied on the strength of
    // it.
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });

      const outcome = await applyRedwall(desktop, "dark", {
        state: async () => running,
        inUse: async () => null,
        show: async () => false,
      });

      expect(outcome.written).toBe(true);
      expect(existsSync(outcome.path!)).toBe(true);
      expect(outcome.shown).toBe(false);
    });
  });
});
