/**
 * The composer, checked the way a desktop cannot check it.
 *
 * Every claim Spec #52 makes about a Redwall is a claim about bytes, and
 * that is the whole design: purity is what makes "did the state change"
 * answerable by comparison, and it is what lets a build with no desktop
 * attached have an opinion at all.
 *
 * Two of these are the same assertion pointing opposite ways —
 * identical inputs must produce identical output, and a different Worker
 * count must produce different output. Either one alone passes for a
 * renderer that ignores its arguments.
 *
 * The legibility half lives in `theme-contrast.test.ts`, beside every
 * other pair this project measures, because that is the table a colour
 * change has to get past. What is here is the pixels: that the two
 * colours the theme declares are the two colours that actually landed.
 */

import { describe, expect, test } from "bun:test";
import { contrast } from "./brand.ts";
import { decodePng, encodePng, type Raster } from "./png.ts";
import { REDWALL_SUBSET } from "./redwall-font.ts";
import {
  redwallBox,
  redwallInk,
  redwallLines,
  renderRedwall,
  type RedwallState,
} from "./redwall-render.ts";
import { THEMES, THEME_SLUGS, type ThemeSlug } from "./themes.ts";
import { readFont } from "./ttf.ts";

const root = `${import.meta.dir}/..`;
const fontBytes = await Bun.file(REDWALL_SUBSET).bytes();
const font = readFont(fontBytes);

/**
 * Stand-in art: a two-way gradient, so that a pixel moved by one in
 * either direction is a pixel with a different value.
 */
function sheet(width = 1280, height = 720): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      data[at] = x & 0xff;
      data[at + 1] = y & 0xff;
      data[at + 2] = (x + y) & 0xff;
      data[at + 3] = 255;
    }
  }
  return { width, height, data };
}

const art = encodePng(sheet());
const running: RedwallState = { workers: 3, address: "192.168.1.42" };

function render(state: RedwallState, slug: ThemeSlug = "dark"): Uint8Array {
  return renderRedwall({ art, font: fontBytes, theme: THEMES[slug], state });
}

describe("the same inputs", () => {
  test("produce byte-identical output", () => {
    // Not "an equivalent image". The regenerator decides whether the
    // desktop needs rewriting by comparing what it just composed with
    // what is already there, and a renderer that varied by a compression
    // timestamp would rewrite the wallpaper on every tick.
    expect([...render(running)]).toEqual([...render(running)]);
  });

  test("and a state that says nothing hands back the art it was given", () => {
    // A machine with no daemon and no route is a machine Redwall has
    // nothing to add to, and the honest picture of it is the wallpaper.
    expect(render({ workers: null, address: null })).toBe(art);
  });
});

describe("a different state", () => {
  test("is a different image when the Worker count changes", () => {
    expect([...render(running)]).not.toEqual([...render({ ...running, workers: 4 })]);
  });

  test("including when the count goes to zero, which is not the same as unknown", () => {
    // `host-state.ts` exists to keep these two apart: a drained queue
    // reports zero, a stopped daemon reports nothing. A renderer that
    // drew them the same would undo that distinction at the last step.
    const drained = render({ ...running, workers: 0 });
    const unknown = render({ ...running, workers: null });
    expect([...drained]).not.toEqual([...unknown]);
  });

  test("and when the address changes", () => {
    expect([...render(running)]).not.toEqual([...render({ ...running, address: "10.0.0.1" })]);
  });

  test("and when the theme changes, because the ink and the plate do", () => {
    expect([...render(running, "dark")]).not.toEqual([...render(running, "light")]);
  });
});

describe("the brand art underneath", () => {
  test("is present unmodified outside the region the overlay occupies", () => {
    const before = sheet();
    const after = decodePng(render(running));
    const box = redwallBox(before, font, redwallLines(running))!;

    let moved = 0;
    let insideBox = 0;
    for (let y = 0; y < before.height; y++) {
      for (let x = 0; x < before.width; x++) {
        const inside =
          x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
        if (inside) {
          insideBox++;
          continue;
        }
        const at = (y * before.width + x) * 4;
        for (let c = 0; c < 4; c++) {
          if (before.data[at + c] !== after.data[at + c]) moved++;
        }
      }
    }

    expect(moved).toBe(0);
    // And the region is a region: an overlay that occupied nothing would
    // pass the assertion above without drawing anything.
    expect(insideBox).toBeGreaterThan(0);
    expect(insideBox).toBeLessThan(before.width * before.height);
  });

  test("survives a real sheet, at the size a real desktop asks for", async () => {
    // The synthetic art above is 1280x720 and has no mark on it. The
    // vendored sheets are 3840x2160 and are the actual subject, and the
    // scale arithmetic is the part that only shows up at their size.
    const real = await Bun.file(`${root}/assets/wallpapers/dark.png`).bytes();
    const before = decodePng(real);
    const after = decodePng(
      renderRedwall({ art: real, font: fontBytes, theme: THEMES.dark, state: running }),
    );
    const box = redwallBox(before, font, redwallLines(running))!;

    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    // The overlay is a corner of the desktop, not a banner across it.
    expect(box.width).toBeLessThan(before.width / 3);
    expect(box.height).toBeLessThan(before.height / 6);

    let moved = 0;
    for (let y = 0; y < before.height; y++) {
      if (y >= box.y && y < box.y + box.height) continue;
      for (let x = 0; x < before.width * 4; x++) {
        if (before.data[y * before.width * 4 + x] !== after.data[y * before.width * 4 + x]) moved++;
      }
    }
    expect(moved).toBe(0);
  });

  test("keeps the machine state quiet and out of the way at the top right", async () => {
    const real = await Bun.file(`${root}/assets/wallpapers/flare.png`).bytes();
    const before = decodePng(real);
    const box = redwallBox(before, font, redwallLines(running))!;

    // Desktop icons own the left edge. The top-right keeps the state visible
    // without competing with the taskbar and Windows activation watermark.
    expect(box.x).toBeGreaterThan(before.width * 0.75);
    expect(box.y).toBeGreaterThan(0);
    expect(box.y + box.height).toBeLessThan(before.height * 0.15);

    // It is a small instrument, not a second brand mark. These bounds are
    // deliberately relative so the same apparent weight survives on 1080p
    // and 4K sheets.
    expect(box.width).toBeLessThan(before.width / 8);
    expect(box.height).toBeLessThan(before.height / 14);
  });
});

describe("what actually landed inside the region", () => {
  test.each([...THEME_SLUGS])("%s writes its declared ink on its declared plate", (slug) => {
    const ink = redwallInk(THEMES[slug]);
    const after = decodePng(render(running, slug));
    const box = redwallBox(after, font, redwallLines(running))!;

    const tally = new Map<string, number>();
    for (let y = box.y; y < box.y + box.height; y++) {
      for (let x = box.x; x < box.x + box.width; x++) {
        const at = (y * after.width + x) * 4;
        const hex = `#${[0, 1, 2].map((c) => after.data[at + c]!.toString(16).padStart(2, "0")).join("")}`;
        tally.set(hex, (tally.get(hex) ?? 0) + 1);
      }
    }

    // Both colours present as themselves, not merely as something near
    // them: the plate is flat and the strokes are wide enough to have
    // solid interiors, so antialiasing accounts for edges and nothing
    // else. This is the pixel-level half of the contrast claim that
    // theme-contrast.test.ts measures as a ratio.
    expect(tally.get(ink.plate) ?? 0).toBeGreaterThan(0);
    expect(tally.get(ink.text) ?? 0).toBeGreaterThan(0);
    expect(contrast(ink.text, ink.plate)).toBeGreaterThanOrEqual(4.5);
  });

  test("and the ink follows the appearance rather than the palette", () => {
    // obsidian and marble are the pair that makes this checkable: they
    // are the same design in opposite appearances and share no accent to
    // confuse the question.
    expect(redwallInk(THEMES.obsidian).text).not.toBe(redwallInk(THEMES.marble).text);
    for (const slug of THEME_SLUGS) {
      const theme = THEMES[slug];
      expect(redwallInk(theme).text, slug).toBe(
        redwallInk(THEMES[theme.appearance === "light" ? "light" : "dark"]).text,
      );
    }
  });
});

describe("the lines", () => {
  test("carry both facts when both are known, in a fixed order", () => {
    expect(redwallLines(running)).toEqual(["WORKERS 3", "LAN 192.168.1.42"]);
  });

  test("keep the half that is known when the other is not", () => {
    expect(redwallLines({ workers: 2, address: null })).toEqual(["WORKERS 2"]);
    expect(redwallLines({ workers: null, address: "10.1.2.3" })).toEqual(["LAN 10.1.2.3"]);
    expect(redwallLines({ workers: null, address: null })).toEqual([]);
  });

  test("drop an address the embedded face was never cut for", () => {
    // Nothing produces an IPv6 address today. When something does, the
    // failure has to be one missing line rather than a wallpaper that
    // stops regenerating — and the charset test is what will say so.
    expect(redwallLines({ workers: 1, address: "fe80::1" })).toEqual(["WORKERS 1"]);
  });

  test("drop a count that has no digits-only decimal form", () => {
    for (const workers of [-1, 1.5, Number.NaN, 1e21, Number.POSITIVE_INFINITY]) {
      expect(redwallLines({ workers, address: null }), String(workers)).toEqual([]);
    }
  });

  test("and there is no box to draw when there are no lines", () => {
    expect(redwallBox({ width: 100, height: 100 }, font, [])).toBeNull();
  });
});
