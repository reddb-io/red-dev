/**
 * The six, and the properties that make them a set rather than six
 * separate decisions.
 *
 * Colour values themselves are checked in theme-contrast.test.ts, which
 * measures them; this file is about shape and provenance.
 */

import { describe, expect, test } from "bun:test";
import { neutral, red } from "./brand.ts";
import {
  DEFAULT_THEME,
  isThemeSlug,
  RETIRED_THEMES,
  resolveThemeSlug,
  swatches,
  THEME_SLUGS,
  THEMES,
  themeFor,
  themeNames,
} from "./themes.ts";

describe("the set", () => {
  test("is the six, and the record has no others", () => {
    expect(themeNames()).toEqual(["dark", "light", "obsidian", "marble", "cobalt", "flare"]);
    expect(Object.keys(THEMES).sort()).toEqual([...THEME_SLUGS].sort());
  });

  test("defaults to dark, because the brand is dark-first", () => {
    expect(DEFAULT_THEME).toBe("dark");
    expect(isThemeSlug(DEFAULT_THEME)).toBe(true);
  });

  test("every appearance is one of the two GNOME and Windows understand", () => {
    for (const slug of THEME_SLUGS) {
      expect(["light", "dark"], slug).toContain(THEMES[slug].appearance);
    }
  });

  test("two light and four dark", () => {
    const light = THEME_SLUGS.filter((s) => THEMES[s].appearance === "light");
    expect(light.sort()).toEqual(["light", "marble"]);
  });

  test("every colour comes from the brand ramp, with no hex literal", () => {
    // The point of vendoring tokens.json. A hex typed into this file
    // would be a second source of truth waiting to disagree with the
    // first, and it would not be caught by anything else here.
    const brandColours = new Set<string>([...Object.values(neutral), ...Object.values(red)]);
    for (const slug of THEME_SLUGS) {
      const t = THEMES[slug];
      const used = [
        ...Object.values(t.surface),
        ...Object.values(t.text),
        ...(t.accent.kind === "colour" ? [t.accent.value, t.accent.on] : []),
      ];
      for (const hex of used) {
        expect(brandColours, `${slug}: ${hex}`).toContain(hex);
      }
    }
  });

  test("each carries a blurb, since it replaced the note the TUI showed", () => {
    for (const slug of THEME_SLUGS) {
      expect(THEMES[slug].blurb.length, slug).toBeGreaterThan(10);
    }
  });

  test("VS Code gets a built-in name, never an extension id", () => {
    // No RedDB VS Code theme is published, so the honest maximum is
    // light or dark. A dotted id here would mean the marketplace install
    // path had crept back in.
    for (const slug of THEME_SLUGS) {
      const name = THEMES[slug].vscode;
      expect(name, slug).toMatch(/^Default (Dark|Light) Modern$/);
      const wantsLight = THEMES[slug].appearance === "light";
      expect(name.includes("Light"), slug).toBe(wantsLight);
    }
  });
});

describe("the accent", () => {
  test("obsidian and marble have none — that is what they are for", () => {
    expect(THEMES.obsidian.accent.kind).toBe("none");
    expect(THEMES.marble.accent.kind).toBe("none");
  });

  test("everything else carries the one brand accent, and only one", () => {
    for (const slug of ["dark", "light", "cobalt", "flare"] as const) {
      const accent = THEMES[slug].accent;
      expect(accent.kind, slug).toBe("colour");
      if (accent.kind !== "colour") continue;
      expect(accent.value, slug).toBe(red[500]);
      // The black R on the red field. White on the accent measures 3.75
      // and the brand's guardrail declares it a failure.
      expect(accent.on, slug).toBe(neutral[950]);
      expect(accent.gnome, slug).toBe("red");
    }
  });
});

describe("swatches", () => {
  test("an accented theme shows eight cells, an accentless one seven", () => {
    // Not a rendering quirk: the absence of the accent is the most
    // important thing about obsidian and marble, and the preview strip
    // is the only place anyone sees it before choosing.
    expect(swatches("dark")).toHaveLength(8);
    expect(swatches("obsidian")).toHaveLength(7);
    expect(swatches("marble")).toHaveLength(7);
  });

  test("the accent is last, where the eye lands", () => {
    expect(swatches("dark").at(-1)).toBe(red[500]);
  });

  test("the six read as six, so a preview can tell them apart", () => {
    const strips = THEME_SLUGS.map((s) => swatches(s).join());
    expect(new Set(strips).size).toBe(THEME_SLUGS.length);
  });

  test("an unknown slug is empty rather than a crash in the renderer", () => {
    expect(swatches("tokyo-night")).toEqual([]);
  });
});

describe("retired slugs", () => {
  test("all ten are mapped", () => {
    expect(Object.keys(RETIRED_THEMES).sort()).toEqual(
      [
        "catppuccin", "everforest", "gruvbox", "kanagawa", "matte-black",
        "nord", "osaka-jade", "ristretto", "rose-pine", "tokyo-night",
      ].sort(),
    );
  });

  test("each lands on a theme that exists", () => {
    for (const [old, next] of Object.entries(RETIRED_THEMES)) {
      expect(isThemeSlug(next), old).toBe(true);
    }
  });

  test("the one light palette lands on light", () => {
    // rose-pine was the only theme with appearance: "light". Sending it
    // to dark would darken a machine that had deliberately chosen not
    // to be.
    expect(resolveThemeSlug("rose-pine")).toBe("light");
    expect(THEMES[resolveThemeSlug("rose-pine")].appearance).toBe("light");
  });

  test("a live slug is a fixed point", () => {
    for (const slug of THEME_SLUGS) expect(resolveThemeSlug(slug)).toBe(slug);
  });

  test("anything else falls to the default rather than throwing", () => {
    // This runs on read, during a converge, against a preferences file
    // that may hold anything. Throwing here would make a stale record
    // fatal.
    expect(resolveThemeSlug(undefined)).toBe(DEFAULT_THEME);
    expect(resolveThemeSlug("")).toBe(DEFAULT_THEME);
    expect(resolveThemeSlug("something-nobody-shipped")).toBe(DEFAULT_THEME);
  });
});

describe("themeFor", () => {
  test("narrows a string to a theme", () => {
    expect(themeFor("cobalt")).toBe(THEMES.cobalt);
  });

  test("returns undefined for a retired slug rather than guessing", () => {
    // resolveThemeSlug is where healing happens. If themeFor healed too,
    // a caller could never tell a live slug from a dead one.
    expect(themeFor("tokyo-night")).toBeUndefined();
  });
});
