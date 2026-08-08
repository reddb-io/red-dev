/**
 * Cut a font down to the characters that are actually drawn.
 *
 * FiraCode Nerd Font Mono is 2.7 MB and 12,780 glyphs. Redwall draws
 * twenty-two characters. Embedding the whole face to reach them would
 * put more bytes of unused ligature and icon outlines into the binary
 * than the six wallpapers weigh together, so the face is subset first.
 *
 * Generated, never hand-built — the same verdict `src/themes.ts`
 * recorded about transcribing palettes, for the same reason. A glyph
 * copied out by hand is a typo nobody sees until a digit renders wrong.
 * This runs from the upstream face on demand, so a re-vendor is a
 * command rather than an act of care.
 *
 * It lives in `src/` rather than `scripts/` because `tsconfig.json`
 * type-checks `src/**` and nothing else, and because a subsetter that
 * silently drops a glyph is exactly the kind of thing that needs tests
 * around it. `scripts/vendor-font.ts` is the thin CLI over it.
 *
 * What is deliberately dropped: `GSUB` and `GPOS` (FiraCode's ligature
 * machinery — Redwall composes no ligatures and the two tables are 65 KB
 * of the source), `GDEF`, `gasp`, and the hinting triple `cvt `/`fpgm`/
 * `prep` along with every glyph's instructions. Hinting is a hint to a
 * hinting interpreter; the rasteriser Spec #52 calls for has none, and
 * keeping instructions while dropping the control values they index
 * would leave the font referring to tables that are no longer there.
 *
 * The output is deterministic: the same face and the same characters
 * produce the same bytes, which is what lets the lock pin a digest.
 */

import { cmapCoverage, requireTable, view } from "./ttf.ts";

/** Composite glyph component flags, from the `glyf` spec. */
const ARG_1_AND_2_ARE_WORDS = 0x0001;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;
const WE_HAVE_INSTRUCTIONS = 0x0100;

type Composite = {
  readonly end: number;
  readonly glyphIndexAt: readonly number[];
  readonly lastFlagsAt: number;
  readonly hasInstructions: boolean;
};

export function subsetFont(source: Uint8Array, characters: string): Uint8Array {
  const dv = view(source);
  const head = requireTable(source, "head");
  const maxp = requireTable(source, "maxp");
  const hhea = requireTable(source, "hhea");
  const hmtx = requireTable(source, "hmtx");
  const locaTable = requireTable(source, "loca");
  const glyf = requireTable(source, "glyf");
  const name = requireTable(source, "name");
  const os2 = requireTable(source, "OS/2");
  const post = requireTable(source, "post");

  const points = [...characters].map((ch) => ch.codePointAt(0)!);
  for (let i = 0; i < points.length; i++) {
    const cp = points[i]!;
    // Format 4 is a BMP format, and the output carries only a format 4
    // subtable. An astral character would be silently unmapped.
    if (cp > 0xffff) throw new Error(`character U+${cp.toString(16)} is outside the BMP`);
    if (i > 0 && cp <= points[i - 1]!) throw new Error("characters must be sorted and unique");
  }

  const longLoca = dv.getInt16(head.offset + 50) === 1;
  const sourceGlyphs = dv.getUint16(maxp.offset + 4);
  const loca = (gid: number): number =>
    longLoca ? dv.getUint32(locaTable.offset + gid * 4) : dv.getUint16(locaTable.offset + gid * 2) * 2;

  // ------------------------------------------------------- which glyphs

  const coverage = cmapCoverage(source);
  // .notdef is glyph 0 by definition and is what a renderer falls back
  // to, so it is never optional.
  const keep = new Set<number>([0]);
  for (const cp of points) {
    const gid = coverage.get(cp);
    if (gid === undefined) {
      throw new Error(`the face does not map U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
    }
    if (gid >= sourceGlyphs) throw new Error(`cmap maps U+${cp.toString(16)} to glyph ${gid}, past the end`);
    keep.add(gid);
  }

  // A composite glyph is a reference to other glyphs. Dropping the ones
  // it points at leaves an outline that draws whatever now sits at those
  // indices — a wrong glyph rather than a missing one.
  const pending = [...keep];
  while (pending.length > 0) {
    const gid = pending.pop()!;
    for (const part of componentsOf(dv, glyf.offset, loca, gid)) {
      if (!keep.has(part)) {
        keep.add(part);
        pending.push(part);
      }
    }
  }

  const order = [...keep].sort((a, b) => a - b);
  const remap = new Map<number, number>(order.map((old, index) => [old, index]));

  // ------------------------------------------------------- glyf + loca

  const outlines = order.map((gid) => rewriteGlyph(source, dv, glyf.offset, loca, gid, remap));
  let glyfLength = 0;
  for (const outline of outlines) glyfLength += align4(outline.length);

  const glyfOut = new Uint8Array(glyfLength);
  const locaOut = new Uint8Array((order.length + 1) * 4);
  const locaView = view(locaOut);
  let at = 0;
  for (let i = 0; i < outlines.length; i++) {
    locaView.setUint32(i * 4, at);
    glyfOut.set(outlines[i]!, at);
    at += align4(outlines[i]!.length);
  }
  locaView.setUint32(order.length * 4, at);

  // ------------------------------------------------------------- hmtx

  const numberOfHMetrics = dv.getUint16(hhea.offset + 34);
  const hmtxOut = new Uint8Array(order.length * 4);
  const hmtxView = view(hmtxOut);
  for (let i = 0; i < order.length; i++) {
    const gid = order[i]!;
    // Past numberOfHMetrics the advance is implicitly the last one and
    // only the left side bearing is stored. Every glyph gets a full
    // metric on the way out, which costs two bytes each and removes the
    // rule.
    const metric = gid < numberOfHMetrics ? gid : numberOfHMetrics - 1;
    const advance = dv.getUint16(hmtx.offset + metric * 4);
    const bearing =
      gid < numberOfHMetrics
        ? dv.getInt16(hmtx.offset + gid * 4 + 2)
        : dv.getInt16(hmtx.offset + numberOfHMetrics * 4 + (gid - numberOfHMetrics) * 2);
    hmtxView.setUint16(i * 4, advance);
    hmtxView.setInt16(i * 4 + 2, bearing);
  }

  // -------------------------------------------------- the patched heads

  const headOut = source.slice(head.offset, head.offset + head.length);
  const headView = view(headOut);
  // Zero now, computed over the finished file at the end.
  headView.setUint32(8, 0);
  headView.setInt16(50, 1);

  const hheaOut = source.slice(hhea.offset, hhea.offset + hhea.length);
  view(hheaOut).setUint16(34, order.length);

  const maxpOut = source.slice(maxp.offset, maxp.offset + maxp.length);
  view(maxpOut).setUint16(4, order.length);

  const os2Out = source.slice(os2.offset, os2.offset + os2.length);
  if (os2Out.length >= 68) {
    view(os2Out).setUint16(64, points[0]!);
    view(os2Out).setUint16(66, points[points.length - 1]!);
  }

  // Version 3.0 is the "this font ships no glyph names" version. The
  // source carries format 2.0, whose name array is indexed by glyph and
  // is 230 KB — larger than the rest of the subset by two orders of
  // magnitude, and meaningless once the glyphs are renumbered.
  const postOut = source.slice(post.offset, post.offset + 32);
  view(postOut).setUint32(0, 0x00030000);

  return assemble([
    ["OS/2", os2Out],
    ["cmap", buildCmap(points, points.map((cp) => remap.get(coverage.get(cp)!)!))],
    ["glyf", glyfOut],
    ["head", headOut],
    ["hhea", hheaOut],
    ["hmtx", hmtxOut],
    ["loca", locaOut],
    ["maxp", maxpOut],
    ["name", source.slice(name.offset, name.offset + name.length)],
    ["post", postOut],
  ]);
}

// ---------------------------------------------------------------- glyf

function componentsOf(
  dv: DataView,
  glyfAt: number,
  loca: (gid: number) => number,
  gid: number,
): readonly number[] {
  const parsed = parseComposite(dv, glyfAt, loca, gid);
  return parsed ? parsed.glyphIndexAt.map((at) => dv.getUint16(at)) : [];
}

function parseComposite(
  dv: DataView,
  glyfAt: number,
  loca: (gid: number) => number,
  gid: number,
): Composite | null {
  const start = glyfAt + loca(gid);
  // A zero-length glyph is a blank one — the space character is the
  // obvious example — and has no header at all.
  if (glyfAt + loca(gid + 1) <= start) return null;
  if (dv.getInt16(start) >= 0) return null;

  const glyphIndexAt: number[] = [];
  let at = start + 10;
  let lastFlagsAt = at;
  let hasInstructions = false;
  for (;;) {
    const flags = dv.getUint16(at);
    lastFlagsAt = at;
    glyphIndexAt.push(at + 2);
    at += 4;
    at += flags & ARG_1_AND_2_ARE_WORDS ? 4 : 2;
    if (flags & WE_HAVE_A_SCALE) at += 2;
    else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) at += 4;
    else if (flags & WE_HAVE_A_TWO_BY_TWO) at += 8;
    if (!(flags & MORE_COMPONENTS)) {
      hasInstructions = (flags & WE_HAVE_INSTRUCTIONS) !== 0;
      break;
    }
  }
  return { end: at, glyphIndexAt, lastFlagsAt, hasInstructions };
}

/**
 * One glyph, renumbered and stripped of its hinting instructions.
 */
function rewriteGlyph(
  source: Uint8Array,
  dv: DataView,
  glyfAt: number,
  loca: (gid: number) => number,
  gid: number,
  remap: Map<number, number>,
): Uint8Array {
  const start = glyfAt + loca(gid);
  const end = glyfAt + loca(gid + 1);
  if (end <= start) return new Uint8Array(0);

  const contours = dv.getInt16(start);
  if (contours >= 0) {
    const lengthAt = start + 10 + contours * 2;
    const instructions = dv.getUint16(lengthAt);
    const before = source.subarray(start, lengthAt + 2);
    const after = source.subarray(lengthAt + 2 + instructions, end);
    const out = new Uint8Array(before.length + after.length);
    out.set(before, 0);
    out.set(after, before.length);
    view(out).setUint16(lengthAt - start, 0);
    return out;
  }

  const parsed = parseComposite(dv, glyfAt, loca, gid)!;
  const out = source.slice(start, parsed.end);
  const outView = view(out);
  for (const indexAt of parsed.glyphIndexAt) {
    const component = dv.getUint16(indexAt);
    const renumbered = remap.get(component);
    if (renumbered === undefined) throw new Error(`glyph ${gid} references ${component}, which was dropped`);
    outView.setUint16(indexAt - start, renumbered);
  }
  if (parsed.hasInstructions) {
    // The instructions themselves are already gone — `parsed.end` stops
    // before them — so the flag claiming they follow has to go too.
    outView.setUint16(parsed.lastFlagsAt - start, outView.getUint16(parsed.lastFlagsAt - start) & ~WE_HAVE_INSTRUCTIONS);
  }
  return out;
}

// ---------------------------------------------------------------- cmap

/**
 * A format 4 subtable with one segment per character.
 *
 * Segments normally cover runs, which is what makes format 4 compact for
 * a real font. Twenty-two characters do not need compact, and one
 * segment each removes the only interesting question — whether a run of
 * codepoints still maps to a run of glyphs after renumbering.
 */
function buildCmap(points: readonly number[], glyphs: readonly number[]): Uint8Array {
  const segments = points.length + 1;
  const subtableLength = 16 + segments * 8;
  const out = new Uint8Array(12 + subtableLength);
  const dv = view(out);

  dv.setUint16(0, 0);
  dv.setUint16(2, 1);
  dv.setUint16(4, 3); // Windows
  dv.setUint16(6, 1); // Unicode BMP
  dv.setUint32(8, 12);

  const base = 12;
  const entrySelector = Math.floor(Math.log2(segments));
  const searchRange = 2 * 2 ** entrySelector;
  dv.setUint16(base, 4);
  dv.setUint16(base + 2, subtableLength);
  dv.setUint16(base + 4, 0);
  dv.setUint16(base + 6, segments * 2);
  dv.setUint16(base + 8, searchRange);
  dv.setUint16(base + 10, entrySelector);
  dv.setUint16(base + 12, segments * 2 - searchRange);

  const endAt = base + 14;
  const startAt = endAt + segments * 2 + 2;
  const deltaAt = startAt + segments * 2;
  for (let i = 0; i < points.length; i++) {
    const cp = points[i]!;
    dv.setUint16(endAt + i * 2, cp);
    dv.setUint16(startAt + i * 2, cp);
    dv.setInt16(deltaAt + i * 2, ((glyphs[i]! - cp) << 16) >> 16);
  }
  // The terminating segment every format 4 subtable must end with.
  dv.setUint16(endAt + points.length * 2, 0xffff);
  dv.setUint16(startAt + points.length * 2, 0xffff);
  dv.setInt16(deltaAt + points.length * 2, 1);
  // idRangeOffset is zero for every segment, which the zeroed buffer
  // already says.

  return out;
}

// ------------------------------------------------------------- assembly

function align4(n: number): number {
  return (n + 3) & ~3;
}

function checksum(data: Uint8Array): number {
  const padded = align4(data.length);
  let sum = 0;
  for (let at = 0; at < padded; at += 4) {
    let word = 0;
    for (let b = 0; b < 4; b++) word = ((word << 8) | (data[at + b] ?? 0)) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}

function assemble(tables: ReadonlyArray<readonly [string, Uint8Array]>): Uint8Array {
  // Tag order in the directory is required to be ascending; the data
  // follows in the same order so that two runs of this function on the
  // same input cannot differ.
  const sorted = [...tables].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const directory = 12 + sorted.length * 16;
  let size = directory;
  for (const [, data] of sorted) size += align4(data.length);

  const out = new Uint8Array(size);
  const dv = view(out);
  const entrySelector = Math.floor(Math.log2(sorted.length));
  const searchRange = 16 * 2 ** entrySelector;

  dv.setUint32(0, 0x00010000);
  dv.setUint16(4, sorted.length);
  dv.setUint16(6, searchRange);
  dv.setUint16(8, entrySelector);
  dv.setUint16(10, sorted.length * 16 - searchRange);

  let at = directory;
  let headAt = -1;
  for (let i = 0; i < sorted.length; i++) {
    const [tag, data] = sorted[i]!;
    const record = 12 + i * 16;
    for (let b = 0; b < 4; b++) out[record + b] = tag.charCodeAt(b);
    dv.setUint32(record + 4, checksum(data));
    dv.setUint32(record + 8, at);
    dv.setUint32(record + 12, data.length);
    out.set(data, at);
    if (tag === "head") headAt = at;
    at += align4(data.length);
  }

  // The whole-file checksum goes into `head` last, because writing it
  // changes the file it is computed over — which is why the spec defines
  // it against a file whose own slot reads zero.
  if (headAt >= 0) dv.setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}
