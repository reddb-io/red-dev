/**
 * The outline reader, checked against the face it was written for.
 *
 * There is no fixture font here and there should not be one: the
 * embedded subset is the only face Redwall will ever draw with, it is
 * pinned by digest in `vendor/font/font.lock.json`, and a hand-built
 * fixture would prove the reader agrees with whatever the fixture's
 * author believed about `glyf`.
 *
 * What is checkable without a picture is shape rather than pixels: a
 * glyph's points must land inside the box its own header declares, a
 * monospaced face must advance by one width for every character, and the
 * blank must be blank. Each of those fails loudly under the coordinate
 * bugs that otherwise render as "the text looks a bit wrong".
 */

import { describe, expect, test } from "bun:test";
import { REDWALL_CHARSET } from "./redwall-charset.ts";
import { REDWALL_SUBSET } from "./redwall-font.ts";
import { readFont, view, requireTable, type Font } from "./ttf.ts";

const bytes = await Bun.file(REDWALL_SUBSET).bytes();
const font: Font = readFont(bytes);

/** Every character the overlay may draw, minus the one with no ink. */
const drawn = [...REDWALL_CHARSET].filter((ch) => ch !== " ");

function glyph(ch: string): number {
  const gid = font.glyphFor(ch.codePointAt(0)!);
  if (gid === undefined) throw new Error(`the subset does not map '${ch}'`);
  return gid;
}

describe("the face as a whole", () => {
  test("declares an em square and one glyph per character plus .notdef", () => {
    expect(font.unitsPerEm).toBeGreaterThan(0);
    expect(font.glyphCount).toBe(REDWALL_CHARSET.length + 1);
  });

  test("is monospaced, which is what lets a pen advance without measuring", () => {
    const widths = [...new Set(drawn.map((ch) => font.advanceOf(glyph(ch))))];
    expect(widths).toHaveLength(1);
    // The space is a character with an advance and no outline. A face
    // where it advanced by zero would set every line on top of itself.
    expect(font.advanceOf(glyph(" "))).toBe(widths[0]!);
  });
});

describe("every glyph the overlay can draw", () => {
  test.each(drawn)("'%s' has an outline inside the box its header declares", (ch) => {
    const gid = glyph(ch);
    const contours = font.contoursOf(gid);
    expect(contours.length).toBeGreaterThan(0);

    // The glyph header's own bounding box, read straight out of `glyf`
    // rather than from the reader under test. A sign error in the delta
    // decoding puts points outside it; nothing else does.
    const dv = view(bytes);
    const glyf = requireTable(bytes, "glyf");
    const loca = requireTable(bytes, "loca");
    const at = glyf.offset + dv.getUint32(loca.offset + gid * 4);
    const box = {
      xMin: dv.getInt16(at + 2),
      yMin: dv.getInt16(at + 4),
      xMax: dv.getInt16(at + 6),
      yMax: dv.getInt16(at + 8),
    };

    for (const contour of contours) {
      for (const point of contour) {
        expect(point.x).toBeGreaterThanOrEqual(box.xMin);
        expect(point.x).toBeLessThanOrEqual(box.xMax);
        expect(point.y).toBeGreaterThanOrEqual(box.yMin);
        expect(point.y).toBeLessThanOrEqual(box.yMax);
      }
    }
  });

  test("'0' and 'o' are different shapes, which is the whole point of a face", () => {
    const zero = font.contoursOf(glyph("0"));
    const oh = font.contoursOf(glyph("o"));
    expect(JSON.stringify(zero)).not.toBe(JSON.stringify(oh));
  });
});

describe("the blank", () => {
  test("has no contours at all, rather than an empty one", () => {
    // A zero-length `loca` entry means "no outline", and the format
    // stores no header for it. A reader that parsed one anyway would
    // read the next glyph's bytes as this glyph's contour count.
    expect(font.contoursOf(glyph(" "))).toEqual([]);
  });
});

describe("what the reader refuses", () => {
  test("a glyph index the face does not have", () => {
    expect(() => font.contoursOf(font.glyphCount)).toThrow(/no glyph/);
    expect(() => font.contoursOf(-1)).toThrow(/no glyph/);
  });

  test("a codepoint the subset was not cut for", () => {
    // Undefined rather than a throw: an unmapped character is a question
    // the caller has to answer, and .notdef is one of the answers.
    expect(font.glyphFor("Z".codePointAt(0)!)).toBeUndefined();
  });
});
