/**
 * Every theme, measured against the brand's own rules.
 *
 * The brand machine-checks its palette — `scripts/audit-contrast.mjs`,
 * and *"a guardrail that lies fails the build"*. What it cannot check is
 * a consumer that combines published colours into an unreadable pair:
 * neutral.500 and neutral.800 are both fine tokens and putting one on
 * the other is 1.6:1.
 *
 * So this measures the combinations. A theme that puts red.500 text on
 * neutral.800 fails arithmetic here rather than review, and it fails
 * without anyone having named those two hexes — the rule is expressed as
 * a ratio, so it also catches the pair nobody thought of.
 *
 * src/brand-guardrail.test.ts is the other half: it pins this checker
 * against the brand's published numbers, so a luminance function that
 * drifted would be caught before it started passing bad themes.
 */

import { describe, expect, test } from "bun:test";
import { contrast, neutral, red } from "./brand.ts";
import { THEME_SLUGS, THEMES } from "./themes.ts";

/** WCAG AA for normal text, and what audit-contrast.mjs uses. */
const BODY = 4.5;
/** AAA. Headings carry the answer and are worth the extra margin. */
const HEADING = 7;
/**
 * Secondary text, deliberately below AA.
 *
 * The brand's own dark mapping uses neutral.500 for `--muted`, and its
 * own guardrail declares that as failing 4.5 on every dark ground.
 * Holding muted to AA would either fail the brand's palette or push it
 * up until it stops reading as muted — so the bar is the non-text one,
 * and the exception is recorded rather than hidden.
 */
const SECONDARY = 3;
/** Non-text contrast: a hairline has to be findable, not readable. */
const HAIRLINE = 1.2;

describe.each([...THEME_SLUGS])("%s", (slug) => {
  const t = THEMES[slug];

  test("body text reads on the ground and on a panel", () => {
    // Both, because a theme is not one background. flare's panels are
    // red.700 while its ground is ink, and text legible on one is not
    // automatically legible on the other.
    expect(contrast(t.text.normal, t.surface.bg)).toBeGreaterThanOrEqual(BODY);
    expect(contrast(t.text.normal, t.surface.panel)).toBeGreaterThanOrEqual(BODY);
  });

  test("the strong line clears AAA", () => {
    expect(contrast(t.text.strong, t.surface.bg)).toBeGreaterThanOrEqual(HEADING);
  });

  test("muted text is quiet but findable", () => {
    expect(contrast(t.text.muted, t.surface.bg)).toBeGreaterThanOrEqual(SECONDARY);
  });

  test("the hierarchy runs in the direction it claims", () => {
    // strong louder than normal louder than muted. A theme where muted
    // outshouts body text is legible by every threshold above and still
    // wrong, and this is the only check that would say so.
    const c = (hex: string): number => contrast(hex, t.surface.bg);
    expect(c(t.text.strong)).toBeGreaterThan(c(t.text.normal));
    expect(c(t.text.normal)).toBeGreaterThan(c(t.text.muted));
  });

  test("the edge is visible against its own ground", () => {
    expect(contrast(t.surface.edge, t.surface.bg)).toBeGreaterThanOrEqual(HAIRLINE);
  });

  test("the accent is a fill that can be seen, carrying text that can be read", () => {
    if (t.accent.kind !== "colour") return;
    // As a fill: the non-text bar. The accent is never text — the type
    // has no role for it — so 4.5 against the ground is not required and
    // cobalt would fail it at 3.07.
    expect(contrast(t.accent.value, t.surface.bg)).toBeGreaterThanOrEqual(SECONDARY);
    // What sits ON the fill is text, and is held to the text bar.
    expect(contrast(t.accent.on, t.accent.value)).toBeGreaterThanOrEqual(BODY);
  });
});

describe("the rule the whole exercise exists for", () => {
  test("no theme puts the accent where it would be unreadable as text", () => {
    // Stated as arithmetic, not as a pair of hexes: red.500 on
    // neutral.800 is 4.23, and so is any other combination that lands
    // there. `accent.on` is the only accent-adjacent text role in the
    // type, which is what makes this checkable at all.
    for (const slug of THEME_SLUGS) {
      const accent = THEMES[slug].accent;
      if (accent.kind !== "colour") continue;
      expect(contrast(accent.on, accent.value), slug).toBeGreaterThanOrEqual(BODY);
    }
  });

  test("and the combination the brand explicitly forbids is unreachable", () => {
    // White on the accent measures 3.75. No theme may reach it, and the
    // type is what prevents it: `on` is the only text drawn on a fill.
    expect(contrast(neutral[0], red[500])).toBeLessThan(BODY);
    for (const slug of THEME_SLUGS) {
      const accent = THEMES[slug].accent;
      if (accent.kind === "colour") expect(accent.on, slug).not.toBe(neutral[0]);
    }
  });
});
