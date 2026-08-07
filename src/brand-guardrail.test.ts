/**
 * The brand's own contrast audit, run against red-dev's copy of it.
 *
 * `scripts/audit-contrast.mjs` in the brand repo checks that every
 * guardrail declared in tokens.json agrees with the measured ratio, and
 * the brand's README states the consequence plainly:
 *
 *   > A guardrail that lies fails the build.
 *
 * That build is not this one. red-dev holds a vendored copy, and a copy
 * can be edited, truncated or re-vendored from the wrong commit. Porting
 * the audit means red-dev's own `bun test` refuses a copy whose declared
 * guardrails and measured ratios disagree — so the brand's rule survives
 * the crossing rather than being left on the far side of it.
 *
 * It also pins this repo's contrast maths against the brand's. The
 * themes are built by measuring against these ratios; a luminance
 * function that quietly drifted would pass themes the brand would fail,
 * and nothing else would catch it.
 */

import { describe, expect, test } from "bun:test";
import { contrast, guardrails, neutral, red, token } from "./brand.ts";

/** WCAG's threshold for normal text, and the one audit-contrast.mjs uses. */
const MIN_NORMAL_TEXT = 4.5;

describe("every declared guardrail measures the way it declares", () => {
  for (const rail of guardrails()) {
    // asFill inverts the pair: the owner is the ground and `against` is
    // the text drawn on it. normalText is the ordinary way round.
    const [fg, bg] =
      rail.relation === "asFill" ? [rail.against, rail.owner] : [rail.owner, rail.against];

    const label = `${rail.owner} ${rail.relation} vs ${rail.against} declares ${
      rail.passes ? "PASS" : "FAIL"
    }`;

    test(label, () => {
      const ratio = contrast(token(fg), token(bg));
      expect(ratio >= MIN_NORMAL_TEXT).toBe(rail.passes);
    });
  }
});

/**
 * The numbers themselves, not just their verdicts.
 *
 * The loop above would still pass if the luminance formula were wrong in
 * a way that happened to land every pair on the same side of 4.5. These
 * are the values the brand's own audit produces, pinned to two decimals,
 * so a "tidied" formula has to disagree with an actual number rather
 * than merely with a boolean.
 */
describe("the checker agrees with the brand's published ratios", () => {
  test("the accent on the two grounds it is allowed on", () => {
    expect(contrast(red[500], neutral[950])).toBeCloseTo(5.34, 2);
    expect(contrast(red[500], neutral[900])).toBeCloseTo(4.9, 2);
  });

  test("and on the one it is not", () => {
    // 4.23 — the reason `cobalt` may use the accent as a fill and never
    // as text, and the reason the theme type has no accent-as-text role.
    expect(contrast(red[500], neutral[800])).toBeCloseTo(4.23, 2);
  });

  test("white on the accent fails, near-black on it passes", () => {
    expect(contrast(neutral[0], red[500])).toBeCloseTo(3.75, 2);
    expect(contrast(neutral[950], red[500])).toBeCloseTo(5.34, 2);
  });

  test("neutral.500 fails as text on every dark ground", () => {
    // The trap in a grey-heavy dark theme, and the reason brightBlack in
    // the fixed terminal palette is a documented exception rather than
    // an oversight.
    for (const ground of [neutral[950], neutral[900], neutral[800]]) {
      expect(contrast(neutral[500], ground)).toBeLessThan(MIN_NORMAL_TEXT);
    }
  });

  test("neutral.300 and neutral.400 pass on every dark ground", () => {
    for (const fg of [neutral[300], neutral[400]]) {
      for (const ground of [neutral[950], neutral[900], neutral[800]]) {
        expect(contrast(fg, ground)).toBeGreaterThanOrEqual(MIN_NORMAL_TEXT);
      }
    }
  });
});
