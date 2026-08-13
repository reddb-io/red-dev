/**
 * Redwall is on until someone says otherwise.
 *
 * The default is the whole of this slice's risk. Nothing generates or
 * applies an image yet, so a wrong preference costs nothing today — but
 * the moment something does read it, a default of "on" means red-dev
 * rewrites a desktop nobody offered it. That is the overreach ADR 0003
 * reversed one surface over, and it is far easier to keep than to undo.
 *
 * Absence now means the product default, while the boolean false remains
 * a durable opt-out. Invalid values still fail closed instead of becoming
 * true merely because a non-empty string is truthy.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  readPreferences,
  resolveRedwall,
  resolveRedwallInterface,
  writePreferences,
} from "./preferences.ts";
import { preferencesFromAnswers } from "./firstrun.ts";
import type { SetupAnswers } from "./tui-setup-model.ts";
import type { Platform } from "./platform.ts";

const linux: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: false, systemd: true, winget: false, flatpak: true },
};

/** A machine with nothing on it, torn down with the process. */
async function onFreshMachine<T>(run: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env["HOME"];
  const home = mkdtempSync(`${tmpdir()}/red-dev-redwall-`);
  process.env["HOME"] = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
  }
}

const prefsPath = (home: string): string => `${home}/.config/alacritty/red-dev.json`;

/** The interview answered with everything at its preset. */
function answers(overrides: Partial<SetupAnswers> = {}): SetupAnswers {
  return {
    theme: "dark",
    wallpaper: undefined,
    font: "firacode",
    apps: [],
    runtimes: [],
    agents: [],
    blesh: false,
    redwall: true,
    share: false,
    completed: true,
    ...overrides,
  };
}

describe("redwall, before anyone has been asked", () => {
  test("is on on a machine with no preferences at all", async () => {
    await onFreshMachine(async (home) => {
      expect(await resolveRedwall(linux)).toBe(true);
      // And reading it wrote nothing. A default that has to be
      // materialised to be read is a decision recorded on somebody's
      // behalf.
      expect(existsSync(prefsPath(home))).toBe(false);
    });
  });

  test("is on on a machine set up before the question existed", async () => {
    await onFreshMachine(async (home) => {
      mkdirSync(`${home}/.config/alacritty`, { recursive: true });
      await Bun.write(
        prefsPath(home),
        JSON.stringify({ setupCompleted: true, theme: "cobalt", font: "hack" }) + "\n",
      );
      expect(await resolveRedwall(linux)).toBe(true);
    });
  });

  test("is off for anything recorded that is not the boolean true", async () => {
    // This file is JSON a person can open and edit, and "off" is a
    // string. A truthy read would turn a desktop into a dashboard on the
    // strength of someone writing the word they meant to disable it.
    await onFreshMachine(async (home) => {
      mkdirSync(`${home}/.config/alacritty`, { recursive: true });
      await Bun.write(prefsPath(home), JSON.stringify({ redwall: "off" }) + "\n");
      expect(await resolveRedwall(linux)).toBe(false);
    });
  });
});

describe("the first-run answer", () => {
  test("declining leaves it off", async () => {
    await onFreshMachine(async () => {
      await writePreferences(linux, preferencesFromAnswers(answers({ redwall: false })));
      expect(await resolveRedwall(linux)).toBe(false);
    });
  });

  test("accepting records it", async () => {
    await onFreshMachine(async () => {
      await writePreferences(linux, preferencesFromAnswers(answers({ redwall: true })));
      expect(await resolveRedwall(linux)).toBe(true);
    });
  });

  test("records an independent wallpaper beside Redwall", async () => {
    await onFreshMachine(async () => {
      await writePreferences(
        linux,
        preferencesFromAnswers(answers({ wallpaper: "flare", redwall: true })),
      );
      expect(await readPreferences(linux)).toMatchObject({ wallpaper: "flare", redwall: true });
    });
  });

  test("is asked, and asked with accepting as the answer enter gives", () => {
    // A single-choice step commits whatever the cursor is on and the
    // cursor starts at zero, so the first choice is the real default —
    // `preset` is what the timeline shows, not what enter selects. Both
    // are checked, because agreeing with each other is the only way the
    // interview and its display say the same thing.
    const src = readFileSync("src/tui-setup-model.ts", "utf8");
    const block = src.slice(src.indexOf('id: "redwall"'));
    const step = block.slice(0, block.indexOf("applies:"));
    expect(step).toContain("Redwall");
    expect(step.indexOf('key: "yes"')).toBeGreaterThan(-1);
    expect(step.indexOf('key: "yes"')).toBeLessThan(step.indexOf('key: "no"'));
    expect(step).toContain('preset: ["yes"]');
  });

  test("is carried out of both interviews", () => {
    // The fullscreen menu and the standalone first run map the wizard's
    // answers separately. A question only one of them reads is a
    // question the other silently discards.
    const model = readFileSync("src/tui-setup-model.ts", "utf8");
    const tui = readFileSync("src/tui-setup.ts", "utf8");
    for (const src of [model, tui]) {
      expect(src).toContain('redwall: get("redwall")[0] === "yes"');
      expect(src).toContain('get("wallpaper")[0]');
    }
  });

  test("the linear fallback asks it too", () => {
    // Terminals under 60 columns get the prompt sequence rather than the
    // wizard, and a question that exists on only one of those paths is
    // one somebody never gets asked.
    const src = readFileSync("src/firstrun.ts", "utf8");
    expect(src).toContain('confirm("Enable Redwall?", true)');
    expect(src).toContain("redwall,");
  });
});

describe("the menu", () => {
  test("changes the preference, and the change survives a reload", async () => {
    await onFreshMachine(async () => {
      // What redwallMenu does with the answer, on the same seam it uses.
      await writePreferences(linux, { redwall: true });
      expect(await resolveRedwall(linux)).toBe(true);

      // Reloaded, because the point of a preference is that the next
      // process reads it rather than the current one remembering it.
      expect((await readPreferences(linux)).redwall).toBe(true);

      await writePreferences(linux, { redwall: false });
      expect(await resolveRedwall(linux)).toBe(false);
    });
  });

  test("turning it on does not disturb the answers beside it", async () => {
    await onFreshMachine(async () => {
      await writePreferences(linux, preferencesFromAnswers(answers({ theme: "cobalt" })));
      await writePreferences(linux, { redwall: true });

      const prefs = await readPreferences(linux);
      expect(prefs).toMatchObject({ redwall: true, theme: "cobalt", setupCompleted: true });
    });
  });

  test("offers it as an entry of its own", () => {
    const src = readFileSync("src/menu.ts", "utf8");
    // The verb the menu switches on is the first word of the entry.
    expect(src).toContain('"Redwall — machine state on the wallpaper"');
    expect(src).toContain('case "Redwall":');
  });

  test("offers the interface beside the on/off switch", () => {
    // The pin belongs with the answer it modifies. Somewhere else is a
    // setting nobody looking at Redwall would find.
    const src = readFileSync("src/menu.ts", "utf8");
    const submenu = src.slice(src.indexOf("async function redwallMenu"));
    expect(submenu.slice(0, submenu.indexOf("export "))).toContain("Interface");
  });
});

describe("a theme chosen after setup", () => {
  test("the command records the choice before a scheduled Redwall can repaint", () => {
    // This is deliberately pinned at the command boundary. Applying the
    // surfaces is not enough: `red-dev redwall` is another process and
    // reconstructs its canvas from this preference on every timer tick.
    // Without the write, a visible cobalt switch over a recorded flare
    // lasts only until that next tick.
    const main = readFileSync(`${import.meta.dir}/main.ts`, "utf8");
    const start = main.indexOf("async function cmdTheme");
    const end = main.indexOf("async function cmdWallpaper", start);
    const command = main.slice(start, end);
    const write = command.indexOf("writePreferences(p, { theme: chosen })");
    const apply = command.indexOf("applyThemeEverywhere(chosen, p)");

    expect(write).toBeGreaterThan(-1);
    expect(write).toBeLessThan(apply);
  });

  test("the recorded choice is the canvas a later Redwall tick resolves", async () => {
    await onFreshMachine(async () => {
      await writePreferences(linux, { redwall: true, theme: "flare" });
      await writePreferences(linux, { theme: "cobalt" });

      const { resolveWallpaperSlug } = await import("./preferences.ts");
      expect(await resolveWallpaperSlug(linux)).toBe("cobalt");
    });
  });
});

/**
 * The pin, which is an override and nothing more: absent is the normal
 * state of this setting, and the default route is what absent means.
 */
describe("the pinned interface", () => {
  test("is nothing on a machine nobody has pinned one on", async () => {
    await onFreshMachine(async () => {
      expect(await resolveRedwallInterface(linux)).toBeNull();
      await writePreferences(linux, { redwall: true });
      expect(await resolveRedwallInterface(linux)).toBeNull();
    });
  });

  test("is the recorded name once one is set", async () => {
    await onFreshMachine(async () => {
      await writePreferences(linux, { redwallInterface: "vEthernet (WSL)" });
      expect(await resolveRedwallInterface(linux)).toBe("vEthernet (WSL)");
    });
  });

  test("survives beside the other answers, and they survive it", async () => {
    await onFreshMachine(async () => {
      await writePreferences(linux, preferencesFromAnswers(answers({ redwall: true })));
      await writePreferences(linux, { redwallInterface: "tun0" });

      const prefs = await readPreferences(linux);
      expect(prefs).toMatchObject({ redwall: true, redwallInterface: "tun0", theme: "dark" });
      expect(await resolveRedwall(linux)).toBe(true);
    });
  });

  test("is cleared by writing it away, not left behind as an empty string", async () => {
    // What the menu's "default route" entry does, on the same seam. A
    // pin cleared to "" is still a pin as far as a JSON file is
    // concerned, and this is the read that must not treat it as one.
    await onFreshMachine(async (home) => {
      await writePreferences(linux, { redwallInterface: "tun0" });
      await writePreferences(linux, { redwallInterface: undefined });

      expect(await resolveRedwallInterface(linux)).toBeNull();
      expect(readFileSync(prefsPath(home), "utf8")).not.toContain("redwallInterface");
    });
  });

  test("ignores what a person could type into the file by hand", async () => {
    // Blank is how someone clears a value they can see; a non-string is
    // what an editor leaves behind. Neither is an interface name.
    await onFreshMachine(async () => {
      await writePreferences(linux, { redwallInterface: "   " });
      expect(await resolveRedwallInterface(linux)).toBeNull();
    });
    await onFreshMachine(async (home) => {
      mkdirSync(`${home}/.config/alacritty`, { recursive: true });
      await Bun.write(prefsPath(home), JSON.stringify({ redwallInterface: 3 }) + "\n");
      expect(await resolveRedwallInterface(linux)).toBeNull();
    });
  });

  test("is trimmed, because a name read off a screen carries spaces", async () => {
    await onFreshMachine(async () => {
      await writePreferences(linux, { redwallInterface: "  wlp2s0 " });
      expect(await resolveRedwallInterface(linux)).toBe("wlp2s0");
    });
  });
});
