/**
 * The menu is flat, and it carries Keys and Learn on both surfaces.
 *
 * Two things are pinned here, and the second is the one that rots. The
 * first is the decision itself: the `red-dev` menu grows by flat
 * sections rather than by Omarchy's tree, so Keys and Learn are entries
 * at the top level and not leaves of a "More" branch.
 *
 * The second is that the interface has two menus. The fullscreen one in
 * tui.ts is what almost everybody sees; the line-based one in menu.ts is
 * what a terminal under sixty columns falls back to. They are separate
 * lists, which means an entry added to one and forgotten in the other is
 * invisible until somebody with a narrow window reports it missing.
 *
 * Read as data rather than through a render: this is a claim about what
 * the product offers, and pinning it against a drawn frame would turn a
 * layout change into a failure about sections.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { menuEntries } from "./menu.ts";
import type { Platform } from "./platform.ts";
import { SECTIONS } from "./tui.ts";

function machine(over: Partial<Platform>): Platform {
  return {
    os: "linux",
    distro: "ubuntu",
    version: "24.04",
    codename: "noble",
    env: "desktop",
    arch: "x64",
    caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
    ...over,
  };
}

describe("the fullscreen menu", () => {
  test("carries a Keys section, an Emoji section and a Learn section", () => {
    const keys = SECTIONS.find((s) => s.key === "keys");
    const emoji = SECTIONS.find((s) => s.key === "emoji");
    const learn = SECTIONS.find((s) => s.key === "learn");
    expect(keys?.label).toBe("Keys");
    expect(emoji?.label).toBe("Emoji");
    expect(learn?.label).toBe("Learn");
  });

  test("and each says what it is for while highlighted", () => {
    // The right-hand panel is the only explanation a section gets; one
    // with no notes is a word on a list.
    for (const key of ["keys", "emoji", "learn"]) {
      expect(SECTIONS.find((s) => s.key === key)?.notes.length).toBeGreaterThan(0);
    }
  });

  test("with every section still one move from the top", () => {
    // Flat, not a tree: a section whose label announces a submenu is
    // the first step back toward the shape ADR 0006's neighbours
    // decided against.
    expect(new Set(SECTIONS.map((s) => s.key)).size).toBe(SECTIONS.length);
    for (const section of SECTIONS) {
      expect(section.label).not.toContain("…");
      expect(section.label).not.toContain(">");
    }
  });
});

describe("choosing one opens something", () => {
  // Structural, like tui-single-render.test.ts, and for the same
  // reason: what happens after the interface releases the screen cannot
  // be reached without a keystroke and a real console. A section whose
  // key nothing answers falls through cmdUi's switch to `default`,
  // which returns 0 — the interface closes and the person is back at a
  // shell, having asked for a viewer. That is the failure this catches.
  const cmdUi = (() => {
    const main = readFileSync("src/main.ts", "utf8");
    const from = main.indexOf("async function cmdUi");
    return main.slice(from, main.indexOf("\nasync function", from + 1));
  })();

  for (const key of ["keys", "emoji", "learn"]) {
    test(`the ${key} section is answered after the render exits`, () => {
      expect(cmdUi).toContain(`case "${key}":`);
    });
  }
});

describe("the narrow-terminal menu", () => {
  for (const p of [machine({}), machine({ os: "windows", env: "windows" })]) {
    test(`offers Keys, Emoji and Learn on ${p.env} too`, () => {
      const verbs = menuEntries(p).map((entry) => entry.split(" ")[0]);
      expect(verbs).toContain("Keys");
      expect(verbs).toContain("Emoji");
      expect(verbs).toContain("Learn");
    });
  }

  test("and every entry it offers is one the loop can act on", () => {
    // The loop switches on the first word. An entry whose verb nothing
    // handles falls through to `default`, which quits the menu — a
    // section that closes the program instead of opening.
    const handled = new Set([
      "Install",
      "Theme",
      "Wallpaper",
      "Font",
      "Redwall",
      "Apps",
      "Keys",
      "Emoji",
      "Languages",
      "Shell",
      "Update",
      "Plan",
      "Doctor",
      "Learn",
      "Uninstall",
      "Platform",
      "Quit",
    ]);
    for (const entry of menuEntries(machine({ os: "windows", env: "windows" }))) {
      expect(handled.has(entry.split(" ")[0] ?? "")).toBe(true);
    }
  });
});
