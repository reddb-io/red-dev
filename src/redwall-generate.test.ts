/**
 * The command that writes the image, checked on a machine that has none.
 *
 * Everything here is about the file system and the two questions asked
 * before anything touches it. What the overlay looks like is
 * `redwall-render.test.ts`'s subject and is deliberately not re-asserted;
 * what is asserted is that the image arrives, that it arrives somewhere
 * that cannot confuse the wallpaper sweep, and that a trigger firing on
 * every state change does not turn an idle machine into a directory full
 * of 4K PNGs.
 *
 * The seams matter as much as the assertions. Both defaults reach for a
 * process — `redskilled` for the Worker count, `ip` or PowerShell for
 * the address, `gsettings` for what is on screen — so a test that let
 * them run would be asserting against the machine running CI. Injecting
 * state is also what makes "the same state twice" and "a different
 * state" expressible at all.
 */

import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { buildCli, parseArgs } from "./cli.ts";
import type { Platform } from "./platform.ts";
import { writePreferences } from "./preferences.ts";
import type { RedwallState } from "./redwall-render.ts";
import { generateRedwall, redwallDir } from "./redwall.ts";
import {
  expectedWallpaperNames,
  materialise,
  sweepRetiredWallpapers,
  wallpaperDir,
} from "./wallpaper.ts";
import { THEMES } from "./themes.ts";

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
  const home = mkdtempSync(`${tmpdir()}/red-dev-redwall-write-`);
  process.env["HOME"] = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
  }
}

/**
 * Generate with the machine's own questions answered for it. `inUse`
 * says nothing is on screen, which is true of a temporary directory and
 * keeps `gsettings` out of the run.
 */
function generate(p: Platform, state: RedwallState = running) {
  return generateRedwall(p, { state: async () => state, inUse: async () => null });
}

const listing = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe("with the preference off", () => {
  test("the command succeeds and writes nothing at all", async () => {
    await onFreshMachine(async (home) => {
      // No preference written: absent is off, and that is the state a
      // machine that has never been asked is in.
      const outcome = await generate(desktop);

      expect(outcome.skipped).toBe("off");
      expect(outcome.path).toBeNull();
      expect(outcome.written).toBe(false);
      // Not merely "no image": the directory itself is never created,
      // so a machine that declined leaves no trace of the feature.
      expect(existsSync(await redwallDir(desktop))).toBe(false);
      expect(existsSync(`${home}/.local/share/red-dev`)).toBe(false);
    });
  });

  test("and the trigger does not have to know that — it is not an error", async () => {
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: false, theme: "dark" });
      expect((await generate(desktop)).skipped).toBe("off");
    });
  });
});

describe("with the preference on", () => {
  test("an image is written, and the command reports where", async () => {
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });
      const outcome = await generate(desktop);

      expect(outcome.skipped).toBeNull();
      expect(outcome.written).toBe(true);
      expect(outcome.path).not.toBeNull();
      expect(existsSync(outcome.path!)).toBe(true);

      // A path is only a report if what is at the end of it is an
      // image. A truncated or mangled write still has a length.
      const bytes = await Bun.file(outcome.path!).bytes();
      expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    });
  });

  test("the image lands outside the wallpapers directory", async () => {
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });
      const outcome = await generate(desktop);

      const wallpapers = await wallpaperDir(desktop);
      expect(outcome.path!.startsWith(`${wallpapers}/`)).toBe(false);
      expect(outcome.path!.startsWith(`${await redwallDir(desktop)}/`)).toBe(true);
      // And the wallpapers directory is not merely free of this image —
      // generating one does not bring it into existence.
      expect(existsSync(wallpapers)).toBe(false);
    });
  });

  test("it follows the theme the machine is actually set to", async () => {
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "flare" });
      const outcome = await generate(desktop);
      expect(outcome.path!.split("/").pop()!.startsWith("flare-")).toBe(true);
    });
  });

  test("a headless machine is skipped, because nothing there will show it", async () => {
    await onFreshMachine(async () => {
      await writePreferences(server, { redwall: true, theme: "dark" });
      const outcome = await generate(server);

      expect(outcome.skipped).toBe("headless");
      expect(existsSync(await redwallDir(server))).toBe(false);
    });
  });
});

describe("the wallpaper sweep", () => {
  test("expects the same six names whether or not a Redwall was generated", async () => {
    // The criterion this file exists for. `expectedWallpaperNames()` is
    // what tells a retired wallpaper from one somebody chose by hand,
    // and it can only do that while it stays finite — a generated image
    // admitted to that set would make it unbounded.
    const before = await expectedWallpaperNames();

    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });
      await generate(desktop);
      await generate(desktop, { workers: 9, address: "10.0.0.7" });
    });

    const after = await expectedWallpaperNames();
    expect([...after].sort()).toEqual([...before].sort());
    expect(after.size).toBe(Object.keys(THEMES).length);
  });

  test("does not reach the generated image, and the image does not confuse it", async () => {
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });
      const wallpaper = await materialise(THEMES.dark, "dark", desktop);
      const outcome = await generate(desktop);

      // A wallpaper red-dev no longer writes, which the sweep should
      // take — the control that proves the sweep ran at all.
      const stale = `${await wallpaperDir(desktop)}/dark-0badcafe.png`;
      writeFileSync(stale, "not really a png");

      const removed = await sweepRetiredWallpapers(desktop);

      expect(removed).toEqual(["dark-0badcafe.png"]);
      expect(existsSync(wallpaper)).toBe(true);
      expect(existsSync(outcome.path!)).toBe(true);
    });
  });
});

describe("running it again", () => {
  test("with unchanged state leaves the directory exactly as it was", async () => {
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });
      const dir = await redwallDir(desktop);

      const first = await generate(desktop);
      const stamp = statSync(first.path!).mtimeMs;
      const before = listing(dir);

      const second = await generate(desktop);

      expect(second.path).toBe(first.path!);
      // Not rewritten, which is the sharper claim: identical bytes
      // written again would move the timestamp on every hook that fires
      // while nothing was happening.
      expect(second.written).toBe(false);
      expect(second.removed).toEqual([]);
      expect(statSync(second.path!).mtimeMs).toBe(stamp);
      expect(listing(dir)).toEqual(before);
      expect(before).toHaveLength(1);
    });
  });

  test("with changed state writes a new image and clears the old one", async () => {
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });
      const dir = await redwallDir(desktop);

      const first = await generate(desktop);
      const second = await generate(desktop, { ...running, workers: 4 });

      expect(second.path).not.toBe(first.path!);
      expect(second.written).toBe(true);
      expect(second.removed).toEqual([first.path!.split("/").pop()!]);
      // A derived image is regenerated for as long as the machine
      // works, so the directory has to be bounded by what is current
      // rather than by how many times the state moved.
      expect(listing(dir)).toEqual([second.path!.split("/").pop()!]);
    });
  });

  test("but never removes the image the desktop is currently showing", async () => {
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });
      const dir = await redwallDir(desktop);

      const first = await generateRedwall(desktop, {
        state: async () => running,
        inUse: async () => null,
      });
      const second = await generateRedwall(desktop, {
        state: async () => ({ ...running, workers: 4 }),
        // The desktop is pointed at the previous Redwall — deleting it
        // is how the background goes black in the gap before something
        // repoints it.
        inUse: async () => first.path,
      });

      expect(second.removed).toEqual([]);
      expect(existsSync(first.path!)).toBe(true);
      expect(listing(dir)).toHaveLength(2);
    });
  });
});

describe("the command line", () => {
  test("accepts `redwall` with no arguments and nothing to configure", () => {
    // The hook invokes this with no knowledge of the machine, so a
    // required argument here would be a trigger that has to be taught
    // something before it can fire.
    const inv = parseArgs(buildCli(), ["redwall"]);
    expect(inv.command).toBe("redwall");
    expect(inv.errors).toEqual([]);
  });
});
