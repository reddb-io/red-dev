/**
 * PNG, read and written, because composing over one needs both halves.
 *
 * Redwall draws state over the theme's wallpaper. The wallpapers are
 * PNGs, what the desktop wants back is a PNG, and there is nothing in
 * Bun or in this project's two dependencies that turns one into pixels.
 * So this is the codec — the whole of it, and no more of it than the six
 * vendored sheets need.
 *
 * ## What it reads
 *
 * Eight bits a channel, non-interlaced, in all five colour types. That
 * covers the sheets as vendored (five are truecolour, obsidian is
 * palette) and leaves room for a re-vendor that arrives with an alpha
 * channel or a greyscale one. Sixteen-bit and interlaced files throw a
 * sentence naming what they are, which is the useful failure: a decoder
 * that quietly halves a 16-bit channel produces an image that looks
 * right until someone measures it.
 *
 * ## What it writes
 *
 * One shape — eight-bit RGBA, non-interlaced — because there is exactly
 * one caller and it always has an alpha channel to write. Choosing the
 * narrowest colour type that fits the pixels would shave a few bytes off
 * a file the desktop reads once, at the price of an encoder with modes,
 * and modes are where "the same input produces the same bytes" goes to
 * die.
 *
 * Every row is filtered with Paeth rather than by the usual adaptive
 * heuristic. The heuristic makes five passes over a 33 MB raster to pick
 * a filter per row, and on smooth gradient art it picks Paeth almost
 * everywhere anyway; one pass is a second of wall clock the regenerator
 * gets to keep. It is a fixed choice, so it is also a deterministic one.
 *
 * ## Why node:zlib rather than Bun's own
 *
 * `Bun.inflateSync` fails with "invalid stored block lengths" on every
 * one of the vendored sheets — they arrive as six 32 KB IDAT chunks and
 * it does not reassemble the stream the way the spec's concatenation
 * requires. `node:zlib` reads all six in 48 ms. This is not a preference
 * between two working libraries; one of them cannot read the images this
 * module exists to read.
 */

import { deflateSync, inflateSync } from "node:zlib";

/** Eight-bit RGBA, row-major. `data.length === width * height * 4`. */
export interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Bytes per pixel in the raw stream, by colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// ------------------------------------------------------------- checksum

let table: Uint32Array | null = null;

/**
 * CRC-32 as the PNG spec defines it, which is the ordinary one.
 *
 * Verified on the way in and not merely written on the way out. The
 * wallpapers travel inside a compiled binary through an import mechanism
 * that has already been observed to mangle a file while leaving its
 * length plausible — see `scripts/embed-smoke.ts` — and a mangled IDAT
 * decodes to noise rather than to an error.
 */
function crc32(data: Uint8Array): number {
  if (table === null) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --------------------------------------------------------------- decode

export function decodePng(bytes: Uint8Array): Raster {
  if (bytes.length < 8 + 25) throw new Error(`not a PNG: ${bytes.length} bytes is shorter than a header`);
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error("not a PNG: signature mismatch");
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let header: Uint8Array | null = null;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const parts: Uint8Array[] = [];

  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = dv.getUint32(at);
    const end = at + 12 + length;
    if (end > bytes.length) throw new Error("PNG is truncated: a chunk runs past the end of the file");

    const tag = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    // The checksum covers the tag and the payload, not the length.
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== dv.getUint32(at + 8 + length)) {
      throw new Error(`PNG chunk '${tag}' is corrupt: the checksum does not match its bytes`);
    }

    const body = bytes.subarray(at + 8, at + 8 + length);
    if (tag === "IHDR") header = body;
    else if (tag === "PLTE") palette = body;
    else if (tag === "tRNS") transparency = body;
    else if (tag === "IDAT") parts.push(body);
    else if (tag === "IEND") break;

    at = end;
  }

  if (header === null) throw new Error("PNG has no IHDR");
  if (parts.length === 0) throw new Error("PNG has no image data");

  const head = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = head.getUint32(0);
  const height = head.getUint32(4);
  const depth = header[8]!;
  const colour = header[9]!;
  const interlace = header[12]!;

  if (width === 0 || height === 0) throw new Error(`PNG is ${width}x${height}, which has no pixels`);
  if (depth !== 8) throw new Error(`PNG is ${depth} bits a channel; this reader handles 8`);
  if (interlace !== 0) throw new Error("PNG is interlaced; this reader handles the progressive-free form");
  const channels = CHANNELS[colour];
  if (channels === undefined) throw new Error(`PNG declares colour type ${colour}, which is not one of the five`);
  if (colour === 3 && palette === null) throw new Error("PNG is palette-indexed and carries no PLTE");

  // One IDAT is the common case; several is the common case for anything
  // large, and the stream is the concatenation rather than each part
  // being its own deflate stream.
  const joined = parts.length === 1 ? parts[0]! : concat(parts);
  const raw = new Uint8Array(inflateSync(joined));

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    throw new Error(`PNG decompressed to ${raw.length} bytes, short of the ${(stride + 1) * height} its size needs`);
  }

  return {
    width,
    height,
    data: toRgba(unfilter(raw, height, stride, channels), width * height, colour, palette, transparency),
  };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The one non-obvious predictor: PNG §9.4, unchanged. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Undo the per-row filters, in place of the leading type byte.
 *
 * `bpp` is a byte offset, not a pixel one, and at eight bits a channel
 * the two happen to be the same number — which is exactly why this reader
 * refuses other depths rather than growing a case for them.
 */
function unfilter(raw: Uint8Array, height: number, stride: number, bpp: number): Uint8Array {
  const out = new Uint8Array(stride * height);
  let read = 0;

  for (let y = 0; y < height; y++) {
    const type = raw[read++]!;
    const row = y * stride;
    const prior = row - stride;

    for (let x = 0; x < stride; x++) {
      const value = raw[read + x]!;
      const a = x >= bpp ? out[row + x - bpp]! : 0;
      const b = y > 0 ? out[prior + x]! : 0;
      let recon: number;
      switch (type) {
        case 0: recon = value; break;
        case 1: recon = value + a; break;
        case 2: recon = value + b; break;
        case 3: recon = value + ((a + b) >> 1); break;
        case 4: recon = value + paeth(a, b, x >= bpp && y > 0 ? out[prior + x - bpp]! : 0); break;
        default: throw new Error(`PNG row ${y} uses filter ${type}, which is not one of the five`);
      }
      out[row + x] = recon & 0xff;
    }
    read += stride;
  }
  return out;
}

function toRgba(
  pixels: Uint8Array,
  count: number,
  colour: number,
  palette: Uint8Array | null,
  transparency: Uint8Array | null,
): Uint8Array {
  if (colour === 6) return pixels;

  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (colour === 0 || colour === 4) {
      const grey = pixels[i * (colour === 4 ? 2 : 1)]!;
      out[o] = grey;
      out[o + 1] = grey;
      out[o + 2] = grey;
      out[o + 3] = colour === 4 ? pixels[i * 2 + 1]! : 255;
    } else if (colour === 2) {
      out[o] = pixels[i * 3]!;
      out[o + 1] = pixels[i * 3 + 1]!;
      out[o + 2] = pixels[i * 3 + 2]!;
      out[o + 3] = 255;
    } else {
      const index = pixels[i]!;
      out[o] = palette![index * 3]!;
      out[o + 1] = palette![index * 3 + 1]!;
      out[o + 2] = palette![index * 3 + 2]!;
      // tRNS on a palette is a prefix: entries past its end are opaque.
      out[o + 3] = transparency?.[index] ?? 255;
    }
  }
  return out;
}

// --------------------------------------------------------------- encode

export function encodePng(raster: Raster): Uint8Array {
  const { width, height, data } = raster;
  if (width <= 0 || height <= 0) throw new Error(`cannot encode a ${width}x${height} raster`);
  if (data.length !== width * height * 4) {
    throw new Error(`raster is ${data.length} bytes, not the ${width * height * 4} a ${width}x${height} RGBA image is`);
  }

  const header = new Uint8Array(13);
  const head = new DataView(header.buffer);
  head.setUint32(0, width);
  head.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  // compression 0, filter 0, interlace 0 — the zeroed buffer already
  // says all three, and there is no other legal value for any of them.

  const idat = deflateSync(filtered(data, width, height), { level: 9 });

  const chunks = [chunk("IHDR", header), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(8 + chunks.reduce((n, c) => n + c.length, 0));
  out.set(SIGNATURE, 0);
  let at = 8;
  for (const part of chunks) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Every row Paeth-filtered, each behind the type byte that says so. */
function filtered(data: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const out = new Uint8Array((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prior = row - stride;
    const write = y * (stride + 1);
    out[write] = 4;

    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? data[row + x - 4]! : 0;
      const b = y > 0 ? data[prior + x]! : 0;
      const c = x >= 4 && y > 0 ? data[prior + x - 4]! : 0;
      out[write + 1 + x] = (data[row + x]! - paeth(a, b, c)) & 0xff;
    }
  }
  return out;
}

function chunk(tag: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = tag.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}
