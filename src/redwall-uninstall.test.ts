/**
 * Turning red-dev off takes the Redwalls with it.
 *
 * A content-addressed name is what keeps the directory correct while the
 * feature is on, and it is exactly what would leave it behind once the
 * feature is gone: nothing else on the machine knows those names, so an
 * uninstall that skipped this directory would strand however many 4K PNGs
 * the day happened to produce, under names no human would recognise as
 * red-dev's.
 *
 * The boundary is the subject of half of these tests. Only red-dev's own
 * Redwall directory goes. A wallpaper someone chose by hand is a decision
 * and outlives the tool that was uninstalled around it — the same line
 * `sweepRetiredWallpapers` draws, held here because uninstall is the one
 * command with no undo.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { Platform } from "./platform.ts";
import { redwallDir, removeRedwall } from "./redwall.ts";
import { removeConfiguration } from "./uninstall.ts";
import { wallpaperDir } from "./wallpaper.ts";

const desktop: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

/** A machine with nothing on it, torn down with the process. */
async function onFreshMachine<T>(run: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env["HOME"];
  const home = mkdtempSync(`${tmpdir()}/red-dev-redwall-uninstall-`);
  process.env["HOME"] = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
  }
}

/** A machine that used Redwall for a while: several generations of image. */
async function withRedwalls(p: Platform): Promise<string> {
  const dir = await redwallDir(p);
  mkdirSync(dir, { recursive: true });
  for (const name of ["dark-1a2b3c4d.png", "dark-5e6f7a8b.png", "cobalt-9c0d1e2f.png"]) {
    writeFileSync(`${dir}/${name}`, "not really a png");
  }
  return dir;
}

/** What somebody picked themselves, nowhere near red-dev's directories. */
function withChosenWallpaper(home: string): string {
  mkdirSync(`${home}/Pictures`, { recursive: true });
  const path = `${home}/Pictures/chosen.png`;
  writeFileSync(path, "somebody's own wallpaper");
  return path;
}

describe("removing the generated images", () => {
  test("takes the directory and everything in it", async () => {
    await onFreshMachine(async () => {
      const dir = await withRedwalls(desktop);

      // The directory itself, not just its contents: an empty
      // `redwall/` left under a removed tool's root is still a trace of
      // a feature nobody has any more.
      expect(await removeRedwall(desktop)).toBe(dir);
      expect(existsSync(dir)).toBe(false);
    });
  });

  test("leaves a wallpaper somebody chose exactly where it is", async () => {
    await onFreshMachine(async (home) => {
      await withRedwalls(desktop);
      const chosen = withChosenWallpaper(home);

      // And the sibling directory too. `wallpapers/` is red-dev's, but
      // it is not this function's to empty — one destructive step that
      // reaches past its own directory is the bug this asserts against.
      const wallpapers = await wallpaperDir(desktop);
      mkdirSync(wallpapers, { recursive: true });
      writeFileSync(`${wallpapers}/dark-deadbeef.png`, "the theme's own art");

      await removeRedwall(desktop);

      expect(existsSync(chosen)).toBe(true);
      expect(existsSync(`${wallpapers}/dark-deadbeef.png`)).toBe(true);
    });
  });

  test("succeeds and reports nothing on a machine that never enabled it", async () => {
    await onFreshMachine(async () => {
      // Redwall is off by default, so this is the common machine, not
      // the edge case. Nothing to remove is an ordinary answer.
      expect(await removeRedwall(desktop)).toBeNull();
      expect(existsSync(await redwallDir(desktop))).toBe(false);
    });
  });

  test("does not create the directory in order to find it missing", async () => {
    await onFreshMachine(async (home) => {
      await removeRedwall(desktop);
      expect(existsSync(`${home}/.local/share/red-dev`)).toBe(false);
    });
  });
});

describe("uninstalling red-dev's configuration", () => {
  test("names the Redwall directory among what it removed", async () => {
    await onFreshMachine(async () => {
      const dir = await withRedwalls(desktop);

      const removed = await removeConfiguration(desktop);

      // Named in its own right rather than swallowed by the root above
      // it. On this machine the two happen to nest; on WSL the images
      // live on the Windows disk and nothing else in the list covers
      // them, so the report has to come from the Redwall step itself.
      expect(removed).toContain(dir);
      expect(existsSync(dir)).toBe(false);
    });
  });

  test("leaves a wallpaper somebody chose exactly where it is", async () => {
    await onFreshMachine(async (home) => {
      await withRedwalls(desktop);
      const chosen = withChosenWallpaper(home);

      await removeConfiguration(desktop);

      expect(existsSync(chosen)).toBe(true);
    });
  });

  test("says nothing about Redwall on a machine that never enabled it", async () => {
    await onFreshMachine(async () => {
      mkdirSync(`${await wallpaperDir(desktop)}`, { recursive: true });

      const removed = await removeConfiguration(desktop);

      expect(removed.some((r) => r.endsWith("/redwall"))).toBe(false);
    });
  });
});
