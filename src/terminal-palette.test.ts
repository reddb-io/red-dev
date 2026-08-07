/**
 * The fixed palette, and the arithmetic behind the eight values the
 * brand does not publish.
 *
 * Two jobs. The first is to stop the derived hues from becoming folklore:
 * they are recomputed here from the vendored tokens, so a literal edited
 * by hand disagrees with the rule that produced it. The second is to
 * hold the decision itself — that the terminal does not vary with the
 * theme — as something executable rather than something written down.
 */

import { describe, expect, test } from "bun:test";
import { contrast, neutral, red } from "./brand.ts";
import {
  ANSI_SCHEME_NAME,
  colorsToml,
  RED_DEV_ANSI,
  wtScheme,
  type TerminalPalette,
} from "./terminal-palette.ts";

// ------------------------------------------------------------- hsl

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function toHsl(hex: string): Hsl {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s, l };
}

function toHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x];
  return `#${[r, g, b].map((v) => Math.round(((v as number) + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** The inputs, every one of them a brand decision. */
const OK = RED_DEV_ANSI.green;
const WARN = RED_DEV_ANSI.yellow;
const dL = toHsl(red[400]).l - toHsl(red[500]).l;
const chroma = toHsl(OK);
const hBlue = toHsl(neutral[400]).h;
const hCyan = (toHsl(OK).h + hBlue) / 2;
const hMagenta = (hBlue + toHsl(red[500]).h) / 2;

// ---------------------------------------------------- the derivation

describe("the derived hues follow the rule, not a hand-picked list", () => {
  test("the bright step is the ramp's own", () => {
    // red.400 is the published bright red. Using the distance the brand
    // already chose between its two reds means the bright row is not a
    // magnitude anyone here invented.
    expect(dL).toBeCloseTo(0.131, 3);
  });

  test("blue is the neutral ramp's hue, not a new one", () => {
    // The load-bearing claim of the whole derivation: the cool-tinted
    // ramp measures 223.6 degrees, so the brand already owns a blue —
    // it has just never raised its chroma or named it.
    expect(hBlue).toBeCloseTo(223.6, 1);
    expect(toHsl(neutral[400]).s).toBeLessThan(0.15);
    expect(RED_DEV_ANSI.blue).toBe(toHex({ h: hBlue, s: chroma.s, l: chroma.l }));
  });

  test("cyan and magenta are hue midpoints", () => {
    expect(RED_DEV_ANSI.cyan).toBe(toHex({ h: hCyan, s: chroma.s, l: chroma.l }));
    expect(RED_DEV_ANSI.purple).toBe(toHex({ h: hMagenta, s: chroma.s, l: chroma.l }));
  });

  test("every bright slot is its normal slot lifted by the ramp step", () => {
    const lifted = (hex: string): string => {
      const c = toHsl(hex);
      return toHex({ ...c, l: c.l + dL });
    };
    expect(RED_DEV_ANSI.brightGreen).toBe(lifted(OK));
    expect(RED_DEV_ANSI.brightYellow).toBe(lifted(WARN));
    expect(RED_DEV_ANSI.brightBlue).toBe(lifted(RED_DEV_ANSI.blue));
    expect(RED_DEV_ANSI.brightCyan).toBe(lifted(RED_DEV_ANSI.cyan));
    expect(RED_DEV_ANSI.brightPurple).toBe(lifted(RED_DEV_ANSI.purple));
  });

  test("bright red is the published token, not the formula", () => {
    // Where the brand has an answer, the derivation defers to it.
    expect(RED_DEV_ANSI.brightRed).toBe(red[400]);
  });
});

// -------------------------------------------------- the brand's rule

describe("the accent stays the only accent", () => {
  test("nothing else in the table reaches its chroma", () => {
    // "The red is the only accent. A product does not carry a second
    // one." Enforced as a number rather than as a sentiment: red is at
    // saturation 1.000 and every other chromatic slot is capped at the
    // chroma of --ok.
    const chromatic = [
      RED_DEV_ANSI.green,
      RED_DEV_ANSI.yellow,
      RED_DEV_ANSI.blue,
      RED_DEV_ANSI.cyan,
      RED_DEV_ANSI.purple,
      RED_DEV_ANSI.brightGreen,
      RED_DEV_ANSI.brightBlue,
      RED_DEV_ANSI.brightCyan,
      RED_DEV_ANSI.brightPurple,
    ];
    expect(toHsl(RED_DEV_ANSI.red).s).toBeCloseTo(1, 3);
    for (const hex of chromatic) {
      expect(toHsl(hex).s).toBeLessThanOrEqual(0.97);
    }
  });

  test("half the table is published tokens, unmodified", () => {
    const published = new Set([
      neutral[0], neutral[50], neutral[300], neutral[500],
      neutral[700], neutral[900], neutral[950],
      red[400], red[500],
    ]);
    const fromBrand = Object.values(RED_DEV_ANSI).filter((v) => published.has(v));
    expect(fromBrand.length).toBeGreaterThanOrEqual(10);
  });
});

describe("legibility on the ink ground", () => {
  const bg = RED_DEV_ANSI.background;

  test("every text slot clears AA, with one recorded exception", () => {
    const exempt = new Set<string>(["background", "black", "selectionBackground", "brightBlack"]);
    for (const [slot, hex] of Object.entries(RED_DEV_ANSI)) {
      if (exempt.has(slot)) continue;
      expect(contrast(hex, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("blue is the tightest, so it is pinned", () => {
    // 4.53 against a 4.5 floor is 0.7% of margin. Without this the next
    // tweak to the chroma rule could drop it below AA and nothing would
    // say so.
    expect(contrast(RED_DEV_ANSI.blue, bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(RED_DEV_ANSI.blue, bg)).toBeCloseTo(4.53, 1);
  });

  test("brightBlack is below AA on purpose, and is the brand's own dim", () => {
    // Inherited, not invented: tokens.json already declares neutral.500
    // as failing normal text on every dark ground. It is the comment
    // slot, and being quiet is the function.
    expect(RED_DEV_ANSI.brightBlack).toBe(neutral[500]);
    expect(contrast(RED_DEV_ANSI.brightBlack, bg)).toBeLessThan(4.5);
  });

  test("the foreground reads on a selection, not only on the ground", () => {
    expect(contrast(RED_DEV_ANSI.foreground, RED_DEV_ANSI.selectionBackground))
      .toBeGreaterThanOrEqual(4.5);
  });
});

// ------------------------------------------------------- the emitters

describe("colorsToml", () => {
  test("carries every value in the palette", () => {
    // Catches a slot added to the type and forgotten in the emitter,
    // which would leave alacritty on its own default for that one colour
    // and look like nothing at all.
    const toml = colorsToml();
    for (const hex of Object.values(RED_DEV_ANSI)) {
      expect(toml).toContain(hex);
    }
  });

  test("translates purple to alacritty's magenta", () => {
    const toml = colorsToml();
    expect(toml).toContain(`magenta = '${RED_DEV_ANSI.purple}'`);
    expect(toml).not.toContain("purple =");
  });

  test("takes no argument, so no caller can vary it", () => {
    expect(colorsToml.length).toBe(0);
  });
});

describe("wtScheme", () => {
  test("has exactly the keys Windows Terminal expects", () => {
    // wsl.ts spreads this object verbatim into settings.schemes, so a
    // field renamed for tidiness — `purple` to `magenta`, say — produces
    // a scheme WT silently ignores. The key set is the contract.
    expect(Object.keys(wtScheme()).sort()).toEqual(
      [
        "name",
        "background", "foreground", "cursorColor", "selectionBackground",
        "black", "red", "green", "yellow", "blue", "purple", "cyan", "white",
        "brightBlack", "brightRed", "brightGreen", "brightYellow",
        "brightBlue", "brightPurple", "brightCyan", "brightWhite",
      ].sort(),
    );
  });

  test("is named by the constant both sides read", () => {
    expect(wtScheme()["name"]).toBe(ANSI_SCHEME_NAME);
  });
});

describe("the decision itself", () => {
  test("the palette is a constant, so there is nothing to vary by theme", () => {
    // The whole point, as an assertion: two calls, no inputs, identical
    // bytes. If a theme argument ever comes back, this is what fails.
    expect(colorsToml()).toBe(colorsToml());
    const twice: TerminalPalette = { ...RED_DEV_ANSI };
    expect(twice).toEqual(RED_DEV_ANSI);
  });
});
