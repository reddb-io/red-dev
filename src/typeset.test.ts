/**
 * The rasteriser, checked without anybody looking at the output.
 *
 * A mask cannot be asserted pixel by pixel against a reference without
 * committing a reference, and a committed reference is a test that fails
 * whenever the renderer improves. So what is measured here is what stays
 * true across any correct rasteriser: ink lands where the glyphs are and
 * nowhere else, a blank has no ink, wider text is wider, and the same
 * call twice is the same bytes.
 *
 * The last one is the load-bearing one. `redwall-render.ts` is pure only
 * if this is, and everything downstream of that — comparing a composed
 * Redwall against the one already on disk to decide whether to write —
 * rests on it.
 */

import { describe, expect, test } from "bun:test";
import { REDWALL_SUBSET } from "./redwall-font.ts";
import { readFont } from "./ttf.ts";
import { measure, typeset } from "./typeset.ts";

const font = readFont(await Bun.file(REDWALL_SUBSET).bytes());

/** How much ink a mask carries, as a fraction of its own area. */
function inked(text: string, size = 32): number {
  const mask = typeset(font, [text], size);
  let total = 0;
  for (const value of mask.alpha) total += value;
  return total / (mask.alpha.length * 255);
}

describe("the same call twice", () => {
  test("produces the same coverage, byte for byte", () => {
    const first = typeset(font, ["workers 12", "lan 10.0.0.1"], 24);
    const second = typeset(font, ["workers 12", "lan 10.0.0.1"], 24);
    expect(first.width).toBe(second.width);
    expect(first.height).toBe(second.height);
    expect([...first.alpha]).toEqual([...second.alpha]);
  });
});

describe("what lands in the mask", () => {
  test("is ink for a character with an outline", () => {
    // A number rather than a threshold on any one pixel: a rasteriser
    // that filled with the wrong winding rule would draw the counter of
    // an '0' solid, and one that flipped y would still draw something.
    expect(inked("0")).toBeGreaterThan(0.1);
    expect(inked("0")).toBeLessThan(0.9);
  });

  test("and nothing at all for a line of blanks", () => {
    // The space is a glyph with an advance and no contours. It is the
    // one character whose correct rendering is an empty mask, and a
    // reader that parsed its absent header would put noise here.
    expect(inked("   ")).toBe(0);
  });

  test("with the counters of the letters left open", () => {
    // 'o' is a contour inside a contour wound the other way. Non-zero
    // winding leaves the middle empty; a rasteriser that ignored
    // direction fills it, and 'o' then carries more ink than '0'.
    const mask = typeset(font, ["o"], 64);
    const centre = mask.alpha[Math.floor(mask.height / 2) * mask.width + Math.floor(mask.width / 2)]!;
    expect(centre).toBe(0);
  });
});

describe("the geometry", () => {
  test("advances by the same width for every character, because the face is one", () => {
    const one = measure(font, ["0"], 40).width;
    const four = measure(font, ["0000"], 40).width;
    expect(four).toBeCloseTo(one * 4, 6);
    // The blank advances too. A face where it did not would set the
    // address hard against its label.
    expect(measure(font, ["0 0"], 40).width).toBeCloseTo(one * 3, 6);
  });

  test("scales linearly with the size asked for", () => {
    expect(measure(font, ["workers"], 60).width).toBeCloseTo(measure(font, ["workers"], 30).width * 2, 6);
  });

  test("stacks lines rather than overprinting them", () => {
    const one = measure(font, ["lan"], 32);
    const three = measure(font, ["lan", "lan", "lan"], 32);
    expect(three.height).toBeCloseTo(one.height + one.lineHeight * 2, 6);
    // And the mask is as tall as the measurement says, so a caller can
    // position the block without knowing where a baseline is.
    expect(typeset(font, ["lan", "lan", "lan"], 32).height).toBe(Math.ceil(three.height));
  });

  test("is a widest-line measurement, not a last-line one", () => {
    expect(measure(font, ["0", "000"], 32).width).toBeCloseTo(measure(font, ["000"], 32).width, 6);
    expect(measure(font, ["000", "0"], 32).width).toBeCloseTo(measure(font, ["000"], 32).width, 6);
  });

  test("and nothing at all is a block of no height", () => {
    expect(measure(font, [], 32).height).toBe(0);
  });
});

describe("a character the face was not cut for", () => {
  test("is a refusal naming it, not a row of empty boxes", () => {
    // .notdef is deliberately not the fallback: a subset and a charset
    // that have drifted apart is a re-vendor, and the failure has to say
    // so rather than shipping tofu to somebody's desktop.
    expect(() => typeset(font, ["Z"], 32)).toThrow(/U\+005A/);
    expect(() => measure(font, ["x"], 32)).toThrow(/no glyph/);
  });
});
