import { describe, expect, test } from "bun:test";
import type { Platform } from "./platform.ts";
import {
  applyThemeEverywhere,
  themeSurfaceNames,
  THEME_SURFACES,
  type ThemeSurfaceSpec,
} from "./theme-apply.ts";
import { DEFAULT_THEME, THEMES } from "./themes.ts";

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

describe("theme surfaces", () => {
  test("a theme reaches the desktop and nothing inside the terminal", () => {
    // Nine of the eleven surfaces this used to name were terminal
    // programs. They take the fixed palette now — see
    // src/terminal-surfaces.ts and .red/adr/0002 — so a name reappearing
    // in this list is a theme leaking back into a pane.
    expect(themeSurfaceNames(windows)).toEqual(["vscode", "wallpaper", "windows"]);
  });

  test("no terminal program is a theme surface any more", () => {
    const inTheTerminal = ["zellij", "btop", "neovim", "bat", "delta", "lazygit", "opencode", "herdr"];
    for (const p of [windows, wsl]) {
      for (const name of inTheTerminal) {
        expect(themeSurfaceNames(p)).not.toContain(name);
      }
    }
  });

  test("native Windows stays in parity with WSL, apart from GNOME", () => {
    const portable = (name: string) => name !== "gnome";

    expect(themeSurfaceNames(windows).filter(portable)).toEqual(
      themeSurfaceNames(wsl).filter(portable),
    );
  });

  test("every name the registry offers resolves to a spec", () => {
    // The old shape kept names and functions in two structures and did
    // `surfaceFns[name]!`. A name in one and not the other threw inside
    // the try/catch and was reported as a benign "skipped" — invisible.
    // One array cannot disagree with itself, and this says so.
    for (const p of [windows, wsl]) {
      for (const name of themeSurfaceNames(p)) {
        expect(THEME_SURFACES.some((s) => s.name === name)).toBe(true);
      }
    }
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
      apply: async (theme: (typeof THEMES)[string], slug: string) => {
        seen.push({ name: s.name, slug, theme: (theme as { name: string }).name });
        return true;
      },
    })) as ThemeSurfaceSpec[];
    return { seen, surfaces };
  }

  test("the caller's slug is what arrives, never one derived from a name", async () => {
    // A theme whose display name does not slugify back to its key is the
    // exact shape that broke: "Catppuccin Macchiato" -> catppuccin.
    const slug = Object.keys(THEMES).find(
      (k) => THEMES[k]!.name.toLowerCase().replace(/\s+/g, "-") !== k,
    );
    if (!slug) throw new Error("no theme whose name and slug differ — the test needs one");

    const { seen, surfaces } = spy();
    await applyThemeEverywhere(slug, wsl, surfaces);

    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) expect(call.slug).toBe(slug);
  });

  test("the theme handed to a surface is the one the slug names", async () => {
    const { seen, surfaces } = spy();
    await applyThemeEverywhere(DEFAULT_THEME, wsl, surfaces);
    for (const call of seen) expect(call.theme).toBe(THEMES[DEFAULT_THEME]!.name);
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
    const { applied, skipped } = await applyThemeEverywhere(DEFAULT_THEME, wsl, surfaces);
    expect(applied).toEqual(["fine"]);
    expect(skipped).toEqual(["boom"]);
  });
});
