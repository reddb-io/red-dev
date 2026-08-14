import { describe, expect, test } from "bun:test";
import type { Platform } from "./platform.ts";
import {
  applyThemeEverywhere,
  themeSurfaceNames,
  THEME_SURFACES,
  type ThemeSurfaceContext,
  type ThemeSurfaceSpec,
} from "./theme-apply.ts";
import { DEFAULT_THEME, THEMES } from "./themes.ts";

/**
 * The two answers the preference can give, named rather than written
 * inline. Passed explicitly everywhere below: read from disk instead,
 * these assertions would say something different on a machine that had
 * turned Redwall on than they do in CI.
 */
const redwallOff: ThemeSurfaceContext = { redwall: false, wallpaper: null };
const redwallOn: ThemeSurfaceContext = { redwall: true, wallpaper: null };
const wallpaperPinned: ThemeSurfaceContext = { redwall: true, wallpaper: "flare" };

const basePlatform = {
  distro: null,
  version: null,
  codename: null,
  arch: "x64",
  caps: {
    apt: false,
    gui: true,
    systemd: false,
    winget: true,
    flatpak: false,
  },
} satisfies Omit<Platform, "os" | "env">;

const wsl = {
  ...basePlatform,
  os: "linux",
  env: "wsl",
} satisfies Platform;

const windows = {
  ...basePlatform,
  os: "windows",
  env: "windows",
} satisfies Platform;

/** No desktop, so nothing here is a surface that can be seen. */
const server = {
  ...basePlatform,
  os: "linux",
  env: "server",
  caps: { ...basePlatform.caps, gui: false },
} satisfies Platform;

describe("theme surfaces", () => {
  test("a theme reaches the desktop and nothing inside the terminal", () => {
    // Nine of the eleven surfaces this used to name were terminal
    // programs. They take the fixed palette now — see
    // src/terminal-surfaces.ts and .red/adr/0003 — so a name reappearing
    // in this list is a theme leaking back into a pane.
    expect(themeSurfaceNames(windows, redwallOff)).toEqual(["vscode", "wallpaper", "windows"]);
  });

  test("no terminal program is a theme surface any more", () => {
    const inTheTerminal = ["zellij", "btop", "neovim", "bat", "delta", "lazygit", "redcode", "herdr"];
    for (const p of [windows, wsl]) {
      for (const name of inTheTerminal) {
        expect(themeSurfaceNames(p, redwallOn)).not.toContain(name);
      }
    }
  });

  test("native Windows stays in parity with WSL, apart from GNOME", () => {
    const portable = (name: string) => name !== "gnome";

    expect(themeSurfaceNames(windows, redwallOn).filter(portable)).toEqual(
      themeSurfaceNames(wsl, redwallOn).filter(portable),
    );
  });

  test("every name the registry offers resolves to a spec", () => {
    // The old shape kept names and functions in two structures and did
    // `surfaceFns[name]!`. A name in one and not the other threw inside
    // the try/catch and was reported as a benign "skipped" — invisible.
    // One array cannot disagree with itself, and this says so.
    for (const p of [windows, wsl]) {
      for (const name of themeSurfaceNames(p, redwallOn)) {
        expect(THEME_SURFACES.some((s) => s.name === name)).toBe(true);
      }
    }
  });

  test("Redwall is a surface only where somebody asked for it", () => {
    // Every other surface is present or absent by what the machine is.
    // This one is present or absent by what its owner decided, which is
    // the whole of .red/adr/0003's reasoning applied one surface over:
    // a desktop is not red-dev's to write over because a converge ran.
    expect(themeSurfaceNames(windows, redwallOn)).toContain("redwall");
    expect(themeSurfaceNames(windows, redwallOff)).not.toContain("redwall");
  });

  test("Redwall draws over the art last, after the surface that installs it", () => {
    // Not a cosmetic ordering. Redwall composes over the theme's art and
    // then repoints the desktop at the composite; run before the
    // wallpaper surface, its work would be immediately overwritten by
    // the plain art and the overlay would never be seen.
    const names = themeSurfaceNames(wsl, redwallOn);
    expect(names.indexOf("redwall")).toBeGreaterThan(names.indexOf("wallpaper"));
    expect(names.at(-1)).toBe("redwall");
  });

  test("a headless machine has no Redwall, whatever the preference says", () => {
    // Two independent gates, and the preference is the weaker one: a
    // server generating 4K PNGs nothing can display is work done for
    // nobody, so "yes" from a user who later moved the disk into a rack
    // does not override the absence of a screen.
    expect(themeSurfaceNames(server, redwallOn)).not.toContain("redwall");
    expect(themeSurfaceNames(server, redwallOff)).not.toContain("redwall");
  });
});

/**
 * The bug this signature exists to make unrepresentable.
 *
 * applyThemeEverywhere took a Theme with the slug as an optional third
 * argument, and derived it from the display name when omitted. The
 * converge path omitted it, so "Catppuccin Macchiato" became
 * `catppuccin-macchiato` — a key in none of the six slug-indexed maps.
 * No VS Code theme, no GNOME accent, a fallback bat theme, a blue
 * Windows accent, and a wallpaper written under a name nothing else
 * used. `red-dev theme catppuccin` was right the whole time, which is
 * why nobody caught it.
 *
 * None of this was testable before: with two inputs that could disagree
 * there was no way to observe which one a surface received.
 */
describe("the slug reaches every surface intact", () => {
  function spy(): { seen: { name: string; slug: string; theme: string }[]; surfaces: ThemeSurfaceSpec[] } {
    const seen: { name: string; slug: string; theme: string }[] = [];
    const surfaces = THEME_SURFACES.map((s) => ({
      ...s,
      apply: async (theme: { name: string }, slug: string) => {
        seen.push({ name: s.name, slug, theme: theme.name });
        return true;
      },
    })) as ThemeSurfaceSpec[];
    return { seen, surfaces };
  }

  test("the caller's slug is what arrives, never one derived from a name", async () => {
    // A theme whose display name does not slugify back to its key is the
    // exact shape that broke: "Catppuccin Macchiato" -> catppuccin.
    const slug = Object.keys(THEMES).find(
      (k) => THEMES[k as keyof typeof THEMES].name.toLowerCase().replace(/\s+/g, "-") !== k,
    );
    if (!slug) throw new Error("no theme whose name and slug differ — the test needs one");

    const { seen, surfaces } = spy();
    await applyThemeEverywhere(slug, wsl, surfaces, redwallOn);

    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) expect(call.slug).toBe(slug);
  });

  test("the theme handed to a surface is the one the slug names", async () => {
    const { seen, surfaces } = spy();
    await applyThemeEverywhere(DEFAULT_THEME, wsl, surfaces, redwallOn);
    for (const call of seen) expect(call.theme).toBe(THEMES[DEFAULT_THEME].name);
  });

  test("a pinned wallpaper changes only wallpaper and Redwall", async () => {
    const { seen, surfaces } = spy();
    await applyThemeEverywhere("cobalt", wsl, surfaces, wallpaperPinned);

    for (const call of seen) {
      if (call.name === "wallpaper" || call.name === "redwall") {
        expect(call).toMatchObject({ slug: "flare", theme: THEMES.flare.name });
      } else {
        expect(call).toMatchObject({ slug: "cobalt", theme: THEMES.cobalt.name });
      }
    }
  });

  test("an unknown slug throws rather than resolving to something", async () => {
    // It used to be impossible to pass an unknown slug — the Theme came
    // in already resolved — so a typo silently themed whatever was
    // handed over. Now the slug is the input and has to be real.
    await expect(applyThemeEverywhere("no-such-theme", wsl)).rejects.toThrow(
      "unknown theme 'no-such-theme'",
    );
  });

  test("a surface that throws is skipped, not fatal to the rest", async () => {
    const surfaces: ThemeSurfaceSpec[] = [
      { name: "boom", applies: () => true, apply: async () => { throw new Error("nope"); } },
      { name: "fine", applies: () => true, apply: async () => true },
    ];
    const { applied, skipped } = await applyThemeEverywhere(DEFAULT_THEME, wsl, surfaces, redwallOff);
    expect(applied).toEqual(["fine"]);
    expect(skipped).toEqual(["boom"]);
  });

  /**
   * Redwall's gate, watched through the same seam as everything else.
   *
   * There is no new test double here on purpose. Whether a surface runs
   * is `applies`, and the spy above already records every surface that
   * did — so "invoked with the new theme" and "not invoked at all" are
   * two readings of one list rather than two mechanisms.
   */
  describe("and Redwall is in that list only when it should be", () => {
    const invoked = (seen: { name: string }[]) => seen.map((call) => call.name);

    test("with the preference on, a theme switch reaches it with the new theme", async () => {
      const { seen, surfaces } = spy();
      await applyThemeEverywhere("marble", wsl, surfaces, redwallOn);

      const redwall = seen.filter((call) => call.name === "redwall");
      expect(redwall).toEqual([
        { name: "redwall", slug: "marble", theme: THEMES.marble.name },
      ]);
    });

    test("with the preference off, it is never reached", async () => {
      const { seen, surfaces } = spy();
      const { applied, skipped } = await applyThemeEverywhere("marble", wsl, surfaces, redwallOff);

      expect(invoked(seen)).not.toContain("redwall");
      // Absent, not failed: a surface nobody asked for must not show up
      // as a thing that did not work.
      expect(applied).not.toContain("redwall");
      expect(skipped).not.toContain("redwall");
    });

    test("on a headless machine it is never reached, preference or not", async () => {
      for (const ctx of [redwallOn, redwallOff]) {
        const { seen, surfaces } = spy();
        await applyThemeEverywhere("marble", server, surfaces, ctx);
        expect(invoked(seen)).not.toContain("redwall");
      }
    });
  });
});
