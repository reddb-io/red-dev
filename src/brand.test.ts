/**
 * The vendored palette, pinned.
 *
 * These sixteen values are the brand, and red-dev is now downstream of a
 * copy it holds itself. A golden test is what makes a re-vendor visible:
 * `scripts/vendor-brand.ts` overwrites the JSON, and if a colour moved,
 * this fails and someone has to look at it. Without it the copy could
 * change under a diff nobody reads, which is the whole failure mode
 * vendoring is supposed to prevent.
 */

import { describe, expect, test } from "bun:test";
import { brand, contrast, guardrails, luminance, neutral, red, token } from "./brand.ts";

describe("the red ramp", () => {
  test("is the four published stops", () => {
    expect(red[400]).toBe("#ff6389");
    expect(red[500]).toBe("#ff2056");
    expect(red[600]).toBe("#d11a46");
    expect(red[700]).toBe("#ad163a");
  });

  test("red.500 is the locked mark colour", () => {
    // tokens.json calls this out by name: "red.500 is the locked mark
    // colour #ff2056". If it ever moves, it is not a token change, it is
    // a rebrand, and it should not arrive quietly through a re-vendor.
    expect(red[500]).toBe("#ff2056");
  });
});

describe("the neutral ramp", () => {
  test("is the twelve published stops, ink to paper", () => {
    expect(neutral[0]).toBe("#ffffff");
    expect(neutral[50]).toBe("#f4f5f7");
    expect(neutral[100]).toBe("#e7e9ee");
    expect(neutral[200]).toBe("#d3d6de");
    expect(neutral[300]).toBe("#b3b8c4");
    expect(neutral[400]).toBe("#8b91a1");
    expect(neutral[500]).toBe("#666d7e");
    expect(neutral[600]).toBe("#4a5162");
    expect(neutral[700]).toBe("#333949");
    expect(neutral[800]).toBe("#1e222d");
    expect(neutral[900]).toBe("#12141b");
    expect(neutral[950]).toBe("#07080a");
  });

  test("runs monotonically dark, so a ramp step is always a step", () => {
    // Every theme picks grounds by walking this ramp. A stop tuned out
    // of order upstream would make `panel` lighter than `raised` in a
    // dark theme, and nothing else would notice.
    const stops = [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
    for (let i = 1; i < stops.length; i++) {
      const lighter = luminance(neutral[stops[i - 1] as 0]);
      const darker = luminance(neutral[stops[i] as 0]);
      expect(darker).toBeLessThan(lighter);
    }
  });
});

describe("aliases", () => {
  test("resolve to the primitive they point at", () => {
    expect(brand.primary).toBe(red[500]);
    expect(brand.hover).toBe(red[600]);
    expect(brand.active).toBe(red[700]);
    expect(brand.ink).toBe(neutral[950]);
    expect(brand.paper).toBe(neutral[50]);
  });

  test("on-primary is the black R on the red field, not white", () => {
    // The single most load-bearing alias for this work: it is why every
    // accented theme sets `on: neutral.950`. White on the accent measures
    // 3.75 and the brand's own guardrail declares it a failure.
    expect(brand.onPrimary).toBe(neutral[950]);
    expect(contrast(brand.onPrimary, brand.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(neutral[0], brand.primary)).toBeLessThan(4.5);
  });
});

describe("token()", () => {
  test("reads a primitive by its DTCG path", () => {
    expect(token("color.neutral.800")).toBe("#1e222d");
  });

  test("throws on a path that is not there, rather than falling back", () => {
    // A missing token means the vendored copy and this repo disagree
    // about what the brand contains. A silent #000000 would ship that
    // disagreement to somebody's desktop.
    expect(() => token("color.neutral.42")).toThrow();
  });

  test("throws on a path that is a group rather than a colour", () => {
    expect(() => token("color.neutral")).toThrow();
  });
});

describe("contrast", () => {
  test("is symmetric, since a ratio has no near side", () => {
    expect(contrast(neutral[0], neutral[950])).toBeCloseTo(
      contrast(neutral[950], neutral[0]),
      10,
    );
  });

  test("spans 1 to 21", () => {
    expect(contrast(red[500], red[500])).toBeCloseTo(1, 10);
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 1);
  });
});

describe("guardrails()", () => {
  test("finds the ones the vendored file declares", () => {
    const rails = guardrails();
    expect(rails.length).toBeGreaterThan(0);

    // red.500 is the token the brand annotates most heavily, and the one
    // this project leans on hardest.
    const accent = rails.filter((r) => r.owner === "color.red.500");
    expect(accent.length).toBeGreaterThanOrEqual(4);
  });

  test("reads asFill as the inverted pair it is", () => {
    const fill = guardrails().find(
      (r) => r.owner === "color.red.500" && r.relation === "asFill" && !r.passes,
    );
    // "textFails: [color.neutral.0]" means white text ON the red fill —
    // owner is the background here, not the foreground.
    expect(fill?.against).toBe("color.neutral.0");
  });
});
