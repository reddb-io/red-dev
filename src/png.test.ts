/**
 * The codec, checked against the only images that matter here.
 *
 * A PNG reader is easy to write and easy to write *nearly* right: an
 * off-by-one in the unfilter shifts a row and the result still opens in
 * every viewer, still has the right dimensions, and is wrong. So the
 * round trip is not the interesting assertion — the interesting one is
 * that the six vendored wallpapers decode to what their own headers say
 * they are, including the palette sheet, which travels through a
 * different branch to the other five and would otherwise never be read.
 */

import { describe, expect, test } from "bun:test";
import { decodePng, encodePng, type Raster } from "./png.ts";
import { THEME_SLUGS } from "./themes.ts";

const root = `${import.meta.dir}/..`;

/** A raster with a different value in every channel of every pixel. */
function ramp(width: number, height: number): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = (i * 7) & 0xff;
    data[i * 4 + 1] = (i * 13) & 0xff;
    data[i * 4 + 2] = (i * 29) & 0xff;
    data[i * 4 + 3] = 0xff;
  }
  return { width, height, data };
}

describe("a raster that has been through a PNG", () => {
  test("comes back with every byte it went in with", () => {
    const before = ramp(37, 19);
    const after = decodePng(encodePng(before));
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    expect([...after.data]).toEqual([...before.data]);
  });

  test("keeps its alpha, which is the channel a wallpaper never exercises", () => {
    const data = new Uint8Array([0, 0, 0, 0, 255, 255, 255, 128, 12, 34, 56, 255]);
    const after = decodePng(encodePng({ width: 3, height: 1, data }));
    expect([...after.data]).toEqual([...data]);
  });

  test("survives a single row and a single column", () => {
    // Both are where a stride calculation goes wrong without anything
    // else noticing, and neither is a shape a wallpaper ever has.
    for (const [w, h] of [[1, 40], [40, 1], [1, 1]] as const) {
      const before = ramp(w, h);
      expect([...decodePng(encodePng(before)).data]).toEqual([...before.data]);
    }
  });
});

describe("encoding", () => {
  test("is deterministic, which is what the whole Redwall rests on", () => {
    const raster = ramp(64, 64);
    expect([...encodePng(raster)]).toEqual([...encodePng(raster)]);
  });

  test("refuses a raster whose data does not match its dimensions", () => {
    expect(() => encodePng({ width: 4, height: 4, data: new Uint8Array(12) })).toThrow();
  });
});

describe("the vendored wallpapers", () => {
  test.each([...THEME_SLUGS])("%s decodes to the size its header declares", async (slug) => {
    const raster = decodePng(await Bun.file(`${root}/assets/wallpapers/${slug}.png`).bytes());
    expect(raster.width).toBe(3840);
    expect(raster.height).toBe(2160);
    expect(raster.data.length).toBe(3840 * 2160 * 4);
  });

  test("obsidian is the palette sheet, and its colours survive the indirection", async () => {
    // Colour type 3. The other five are type 2 and never touch the PLTE
    // branch, so without this the palette path ships unread.
    const raster = decodePng(await Bun.file(`${root}/assets/wallpapers/obsidian.png`).bytes());
    const distinct = new Set<string>();
    let translucent = 0;
    for (let i = 0; i < raster.data.length; i += 4) {
      distinct.add(`${raster.data[i]},${raster.data[i + 1]},${raster.data[i + 2]}`);
      if (raster.data[i + 3] !== 255) translucent++;
    }
    // Counted rather than asserted per pixel: eight million assertions
    // say the same thing as one and take a hundred times as long.
    expect(translucent).toBe(0);
    // A palette holds at most 256 entries; a decoder that read the index
    // as a grey value would produce greys and nothing else.
    expect(distinct.size).toBeGreaterThan(1);
    expect(distinct.size).toBeLessThanOrEqual(256);
  });
});

describe("what is not a PNG", () => {
  test("is refused by its signature rather than misread", () => {
    expect(() => decodePng(new Uint8Array(64))).toThrow(/signature/);
    expect(() => decodePng(new Uint8Array(4))).toThrow();
  });

  test("and a PNG with a byte flipped in it is refused by its checksum", () => {
    const bytes = encodePng(ramp(16, 16));
    // Into the IDAT payload: past the signature, the IHDR chunk and the
    // IDAT header. Corrupting the header instead would be caught by
    // length arithmetic, which is a weaker claim.
    bytes[8 + 25 + 12] = bytes[8 + 25 + 12]! ^ 0xff;
    expect(() => decodePng(bytes)).toThrow(/corrupt/);
  });
});
