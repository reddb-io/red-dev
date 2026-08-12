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
import {
  applyRedwall,
  redwallDir,
  redwallRecord,
  removeRedwall,
  showRedwall,
} from "./redwall.ts";
import { setLockScreenBackground } from "./wallpaper.ts";

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

const wsl: Platform = { ...desktop, env: "wsl" };

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

/**
 * Both surfaces a Redwall reaches, watched one at a time.
 *
 * `screen()` above replaces the whole of `show`, which is right for
 * questions about the file and wrong for this one: the lock screen only
 * becomes assertable when the two writers underneath `show` are separate
 * values. `showRedwall` is the real default, so what these tests exercise
 * is the composition the machine runs and not a rehearsal of it.
 *
 * `lockTakes` is how a target that has no such key answers — `gsettings`
 * exits non-zero for a schema it does not know, and the whole question is
 * what red-dev does next.
 */
function screens(lockTakes = true) {
  const wall: string[] = [];
  const lock: string[] = [];
  return {
    wall,
    lock,
    apply: (p: Platform, slug: string) =>
      applyRedwall(p, slug, {
        state: async () => running,
        inUse: async () => wall.at(-1) ?? null,
        show: showRedwall(p, {
          desktop: async (path: string) => {
            wall.push(path);
            return true;
          },
          lock: async (path: string) => {
            lock.push(path);
            return lockTakes;
          },
        }),
      }),
  };
}

/**
 * The images in the directory, and not the record beside them.
 *
 * `shown` lives there too — deliberately, so that removing the Redwalls
 * removes the note about them — and every claim here is about how many
 * 4K PNGs a machine accumulates.
 */
const listing = async (p: Platform): Promise<string[]> => {
  const dir = await redwallDir(p);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".png")).sort();
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

/**
 * The tick that happens over and over.
 *
 * A two-minute timer means roughly seven hundred runs a day, and on all
 * but a handful of them the state has not moved and the bytes are the
 * ones already on disk. What that run costs is the subject here, and the
 * unit of cost is a process: on WSL every question put to the desktop is
 * a PowerShell started through interop from a systemd unit with no
 * console of its own, and Windows allocates a console window for each
 * one. The user watching their screen sees the cost, which is why "asks
 * nothing" is a behaviour with tests rather than an optimisation.
 */
describe("an unchanged tick", () => {
  /** A machine that counts what it was asked, and answers honestly. */
  function watched() {
    const shown: string[] = [];
    const asked: string[] = [];
    return {
      shown,
      asked,
      apply: (p: Platform, slug: string) =>
        applyRedwall(p, slug, {
          state: async () => running,
          inUse: async () => {
            asked.push("inUse");
            return shown.at(-1) ?? null;
          },
          show: async (path: string) => {
            shown.push(path);
            return true;
          },
        }),
    };
  }

  test("repaints nothing and asks the desktop nothing", async () => {
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });

      const s = watched();
      const first = await s.apply(desktop, "dark");
      const second = await s.apply(desktop, "dark");

      expect(second.written).toBe(false);
      expect(second.path).toBe(first.path);
      // Still true. The desktop is showing the image — it was put there
      // a moment ago — and reporting `shown: false` because this run did
      // not do it would have the caller warn about a working machine.
      expect(second.shown).toBe(true);
      // Nothing was repainted and nothing was asked. Both are the point:
      // one is a PowerShell to set a wallpaper that is already set, the
      // other a PowerShell to read a registry value nothing would act on.
      expect(s.shown).toEqual([first.path!]);
      expect(s.asked).toEqual([]);
    });
  });

  test("a repaint that failed is retried on the next tick", async () => {
    // The record is written after the repaint, so a desktop that refused
    // leaves nothing behind to short-circuit against. Otherwise one
    // refusal would freeze the wallpaper until the bytes next changed.
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });

      const refused = await applyRedwall(desktop, "dark", {
        state: async () => running,
        inUse: async () => null,
        show: async () => false,
      });
      expect(refused.shown).toBe(false);

      const s = watched();
      const retried = await s.apply(desktop, "dark");

      expect(retried.written).toBe(false);
      expect(retried.shown).toBe(true);
      expect(s.shown).toEqual([refused.path!]);
    });
  });

  test("a record naming another image repaints rather than trusting it", async () => {
    // What a theme switch leaves behind, and what a hand-edited record
    // is: the note says one thing and the generated image is another, so
    // the image wins.
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });

      const s = watched();
      const first = await s.apply(desktop, "dark");
      await Bun.write(
        `${await redwallDir(desktop)}/shown`,
        redwallRecord(`${await redwallDir(desktop)}/cobalt-deadbeef.png`),
      );
      const second = await s.apply(desktop, "dark");

      expect(second.written).toBe(false);
      expect(s.shown).toEqual([first.path!, first.path!]);
    });
  });

  test("the record names the image, under a header that says who wrote it", async () => {
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });

      const s = watched();
      const outcome = await s.apply(desktop, "marble");

      const body = await Bun.file(`${await redwallDir(desktop)}/shown`).text();
      expect(body).toContain("Managed by red-dev");
      // Round-tripped rather than compared to a literal: the bytes are
      // the contract between one tick and the next, and nothing else
      // reads them.
      expect(body).toBe(redwallRecord(outcome.path!));
    });
  });

  test("the record goes with the images and never survives them", async () => {
    // A note about a Redwall that no longer exists is worse than no
    // note: it would short-circuit the tick that was meant to replace it.
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });

      const s = watched();
      await s.apply(desktop, "dark");
      expect(existsSync(`${await redwallDir(desktop)}/shown`)).toBe(true);

      await removeRedwall(desktop);
      expect(existsSync(`${await redwallDir(desktop)}/shown`)).toBe(false);
    });
  });
});

/**
 * The surface that motivated the feature.
 *
 * A Redwall on the desktop is readable by whoever is already sitting at
 * an unlocked machine, which is the person who least needs it. The lock
 * screen is where a Worker count and an address are worth having, and it
 * is the reason the image says anything at all rather than being art.
 */
describe("the lock screen", () => {
  test("is pointed at the same image the desktop is", async () => {
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });

      const s = screens();
      const outcome = await s.apply(desktop, "marble");

      expect(outcome.shown).toBe(true);
      // The same path, not merely a path: two surfaces showing different
      // generations of the same image is the bug that would otherwise
      // read as working.
      expect(s.wall).toEqual([outcome.path!]);
      expect(s.lock).toEqual([outcome.path!]);
    });
  });

  test("follows a theme switch rather than keeping the old art", async () => {
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });

      const s = screens();
      const first = await s.apply(desktop, "obsidian");
      const second = await s.apply(desktop, "flare");

      expect(s.lock).toEqual([first.path!, second.path!]);
      // And never at a file the sweep has since removed: the lock screen
      // is pointed at the survivor, so a machine locked an hour later
      // still has an image to draw.
      expect(existsSync(s.lock.at(-1)!)).toBe(true);
      expect(existsSync(first.path!)).toBe(false);
    });
  });

  test("is left alone when the preference is off", async () => {
    // Not "set back to the plain art", which would be a second decision
    // red-dev never made: a machine that did not ask for a Redwall has a
    // lock screen belonging to whoever configured it.
    await onFreshMachine(async () => {
      const s = screens();
      const outcome = await s.apply(desktop, "marble");

      expect(outcome.skipped).toBe("off");
      expect(s.lock).toEqual([]);
      expect(s.wall).toEqual([]);
    });
  });

  test("a target without the key still shows the desktop, and does not fail", async () => {
    // GNOME's screensaver schema is not everywhere, and `gsettings set`
    // exits non-zero for a schema it does not know. That is a surface
    // this machine does not have, not a failed apply — the desktop is
    // the claim `shown` makes, and it is still true.
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });

      const s = screens(false);
      const outcome = await s.apply(desktop, "cobalt");

      expect(outcome.shown).toBe(true);
      expect(s.wall).toEqual([outcome.path!]);
    });
  });

  test("is written once, whatever the shell does with it", async () => {
    // GNOME Shell has ignored this key since 3.36 and blurs the desktop
    // wallpaper instead — which is a Redwall either way, and is why the
    // project accepts the outcome rather than shipping an extension to
    // override it. What must not happen is red-dev noticing and trying
    // again: there is no reading back, and no second write.
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwall: true, theme: "dark" });

      const s = screens(false);
      await s.apply(desktop, "dark");

      expect(s.lock).toHaveLength(1);
    });
  });

  test("is a GNOME surface, and is not reached for anywhere else", async () => {
    // Windows is the case that matters: the lock screen there is not
    // reachable on Home editions, so the desktop is the whole of it and
    // this must answer without spawning anything.
    expect(await setLockScreenBackground("/tmp/red-dev-nowhere.png", wsl)).toBe(false);
    expect(await setLockScreenBackground("/tmp/red-dev-nowhere.png", server)).toBe(false);
  });
});
