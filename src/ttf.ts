/**
 * The smallest amount of TrueType this repo has to be able to read.
 *
 * Spec #52 decided the Redwall overlay is drawn by a rasteriser written
 * in TypeScript rather than by an embedded bitmap atlas, so a font
 * parser is arriving here eventually whatever this slice does. This is
 * its first two tables: the directory that says where everything lives,
 * and `cmap`, which says which glyph a character maps to.
 *
 * It exists this early because the vendoring claim needs it. "The subset
 * contains only the characters Redwall draws" can be asserted from the
 * font's own cmap or it can be believed, and a claim nobody can check is
 * the failure mode `brand-lock.test.ts` was written to close.
 *
 * `glyf` outlines arrived when the caller did — `readFont` below is what
 * the Redwall rasteriser reads glyphs through. Still deliberately absent:
 * kerning and `GSUB`. The subset is a monospaced face with the ligature
 * machinery cut out of it (see `ttf-subset.ts`), so a pen that advances
 * by `hmtx` and nothing else is not an approximation of what the face
 * does — it is what the face does.
 */

export type TableRecord = {
  readonly tag: string;
  readonly offset: number;
  readonly length: number;
};

/** `1.0` outlines, and the older Apple spelling of the same thing. */
const SFNT_TRUETYPE = 0x00010000;
const SFNT_TRUE = 0x74727565;

export function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Where each table lives, by tag.
 *
 * `OTTO` is rejected rather than tolerated: it carries CFF outlines, and
 * every reader below assumes `glyf`/`loca`. Failing on the signature
 * gives a sentence; failing later gives a wrong glyph.
 */
export function tableDirectory(bytes: Uint8Array): Map<string, TableRecord> {
  const dv = view(bytes);
  if (bytes.length < 12) throw new Error("not a font: fewer than 12 bytes");

  const sfnt = dv.getUint32(0);
  if (sfnt !== SFNT_TRUETYPE && sfnt !== SFNT_TRUE) {
    throw new Error(`not a TrueType-outline font: sfnt version 0x${sfnt.toString(16).padStart(8, "0")}`);
  }

  const count = dv.getUint16(4);
  const tables = new Map<string, TableRecord>();
  for (let i = 0; i < count; i++) {
    const at = 12 + 16 * i;
    const tag = String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
    tables.set(tag, { tag, offset: dv.getUint32(at + 8), length: dv.getUint32(at + 12) });
  }
  return tables;
}

export function requireTable(bytes: Uint8Array, tag: string): TableRecord {
  const table = tableDirectory(bytes).get(tag);
  if (!table) throw new Error(`font has no '${tag}' table`);
  return table;
}

/** `maxp.numGlyphs` — how many glyphs the file actually carries. */
export function numGlyphs(bytes: Uint8Array): number {
  return view(bytes).getUint16(requireTable(bytes, "maxp").offset + 4);
}

/**
 * Every character the font claims to map, and the glyph each maps to.
 *
 * One subtable is read, not all of them, because a font that disagrees
 * with itself between platform encodings is a font whose coverage is
 * whatever the renderer happened to pick. The preference order is the
 * usual one: Windows full-repertoire, then Windows BMP, then anything
 * Unicode. Nerd Fonts patch in codepoints above the BMP, so format 12
 * has to be understood even though Redwall itself draws none of them.
 */
export function cmapCoverage(bytes: Uint8Array): Map<number, number> {
  const dv = view(bytes);
  const cmap = requireTable(bytes, "cmap");
  const count = dv.getUint16(cmap.offset + 2);

  let best = -1;
  let bestRank = -1;
  for (let i = 0; i < count; i++) {
    const at = cmap.offset + 4 + 8 * i;
    const platform = dv.getUint16(at);
    const encoding = dv.getUint16(at + 2);
    const offset = cmap.offset + dv.getUint32(at + 4);
    const rank =
      platform === 3 && encoding === 10 ? 3 : platform === 3 && encoding === 1 ? 2 : platform === 0 ? 1 : 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = offset;
    }
  }
  if (best < 0) throw new Error("font has no usable cmap subtable");

  const format = dv.getUint16(best);
  if (format === 4) return readFormat4(dv, best);
  if (format === 12) return readFormat12(dv, best);
  throw new Error(`unsupported cmap subtable format ${format}`);
}

function readFormat4(dv: DataView, at: number): Map<number, number> {
  const segCount = dv.getUint16(at + 6) / 2;
  const endAt = at + 14;
  const startAt = endAt + segCount * 2 + 2;
  const deltaAt = startAt + segCount * 2;
  const rangeAt = deltaAt + segCount * 2;

  const map = new Map<number, number>();
  for (let seg = 0; seg < segCount; seg++) {
    const end = dv.getUint16(endAt + seg * 2);
    const start = dv.getUint16(startAt + seg * 2);
    const delta = dv.getInt16(deltaAt + seg * 2);
    const range = dv.getUint16(rangeAt + seg * 2);
    if (start > end) continue;

    for (let cp = start; cp <= end; cp++) {
      // 0xFFFF is the required terminating segment, not a character.
      if (cp === 0xffff) continue;
      let gid: number;
      if (range === 0) {
        gid = (cp + delta) & 0xffff;
      } else {
        // The one genuinely strange corner of format 4: idRangeOffset is
        // a byte offset from its own slot, which is why this is not an
        // ordinary array index.
        gid = dv.getUint16(rangeAt + seg * 2 + range + (cp - start) * 2);
        if (gid !== 0) gid = (gid + delta) & 0xffff;
      }
      if (gid !== 0) map.set(cp, gid);
    }
  }
  return map;
}

function readFormat12(dv: DataView, at: number): Map<number, number> {
  const groups = dv.getUint32(at + 12);
  const map = new Map<number, number>();
  for (let g = 0; g < groups; g++) {
    const rec = at + 16 + g * 12;
    const start = dv.getUint32(rec);
    const end = dv.getUint32(rec + 4);
    const gid = dv.getUint32(rec + 8);
    for (let cp = start; cp <= end; cp++) {
      const id = gid + (cp - start);
      if (id !== 0) map.set(cp, id);
    }
  }
  return map;
}

// ------------------------------------------------------------- outlines

/**
 * A point on a glyph's outline, in font units with y pointing up.
 *
 * `on` is the TrueType distinction: an on-curve point is somewhere the
 * outline passes through, an off-curve point is the control point of a
 * quadratic between its neighbours. Two off-curve points in a row have
 * an on-curve point implied at their midpoint, and the format stores
 * neither it nor any note that it is missing.
 *
 * The sequence is handed over as the file stores it, implications and
 * all. Reconstructing them here would mean this module deciding what a
 * curve is before anything asks it to draw one; the rasteriser is where
 * that belongs, and it is the only caller.
 */
export interface GlyphPoint {
  readonly x: number;
  readonly y: number;
  readonly on: boolean;
}

/** One closed loop of a glyph. The last point joins back to the first. */
export type GlyphContour = readonly GlyphPoint[];

/** A face, with its tables located once instead of on every glyph. */
export interface Font {
  /** The em square's side in font units — the divisor for any size. */
  readonly unitsPerEm: number;
  /**
   * `hhea`'s vertical metrics, in font units: how far above the baseline
   * the face reaches, how far below (negative), and the extra leading it
   * asks for between two lines. Read from `hhea` rather than `OS/2`
   * because `hhea` is the table every TrueType file must carry, and the
   * subsetter copies it through unchanged.
   */
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;
  readonly glyphCount: number;
  /** The glyph for a codepoint, or undefined where the face has none. */
  glyphFor(codepoint: number): number | undefined;
  /** How far the pen moves after drawing it, in font units. */
  advanceOf(gid: number): number;
  /** Its outline, composites already resolved into their parts. */
  contoursOf(gid: number): GlyphContour[];
}

/** Simple-glyph flags, from the `glyf` spec. */
const ON_CURVE = 0x01;
const X_SHORT = 0x02;
const Y_SHORT = 0x04;
const REPEAT = 0x08;
const X_SAME_OR_POSITIVE = 0x10;
const Y_SAME_OR_POSITIVE = 0x20;

/** Composite-glyph flags. The subsetter names the ones it needs too. */
const ARG_1_AND_2_ARE_WORDS = 0x0001;
const ARGS_ARE_XY_VALUES = 0x0002;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;

/**
 * Read a face once, then ask it for glyphs.
 *
 * The tables are found up front and the cmap is walked up front, because
 * the alternative is doing both per character of every line drawn — and
 * `cmapCoverage` expands every mapped codepoint into a Map, which is
 * cheap over a twenty-two character subset and absurd per glyph.
 *
 * Nothing is cached beyond that. A Redwall draws two short lines and the
 * whole face is 4.9 KB; a glyph cache here would be a lifetime question
 * asked on behalf of a cost nobody has measured.
 */
export function readFont(bytes: Uint8Array): Font {
  const dv = view(bytes);
  const head = requireTable(bytes, "head");
  const hhea = requireTable(bytes, "hhea");
  const hmtx = requireTable(bytes, "hmtx");
  const locaTable = requireTable(bytes, "loca");
  const glyf = requireTable(bytes, "glyf");

  const unitsPerEm = dv.getUint16(head.offset + 18);
  if (unitsPerEm === 0) throw new Error("font declares an em square of zero units");
  const longLoca = dv.getInt16(head.offset + 50) === 1;
  const glyphCount = numGlyphs(bytes);
  const metrics = dv.getUint16(hhea.offset + 34);
  const coverage = cmapCoverage(bytes);

  const loca = (gid: number): number =>
    longLoca
      ? dv.getUint32(locaTable.offset + gid * 4)
      : dv.getUint16(locaTable.offset + gid * 2) * 2;

  const contoursOf = (gid: number, depth = 0): GlyphContour[] => {
    if (gid < 0 || gid >= glyphCount) throw new Error(`no glyph ${gid} in a face of ${glyphCount}`);
    // A composite that reaches itself would otherwise recurse until the
    // stack gave out. Five is past anything a real face nests.
    if (depth > 5) throw new Error(`glyph ${gid} nests composites more than five deep`);

    const start = glyf.offset + loca(gid);
    const end = glyf.offset + loca(gid + 1);
    // A zero-length glyph is a blank one — the space character — and has
    // no header at all, let alone contours.
    if (end <= start) return [];

    const contours = dv.getInt16(start);
    return contours >= 0
      ? simpleGlyph(dv, start, contours)
      : compositeGlyph(dv, start, (part) => contoursOf(part, depth + 1));
  };

  return {
    unitsPerEm,
    ascender: dv.getInt16(hhea.offset + 4),
    descender: dv.getInt16(hhea.offset + 6),
    lineGap: dv.getInt16(hhea.offset + 8),
    glyphCount,
    glyphFor: (codepoint) => coverage.get(codepoint),
    advanceOf: (gid) => dv.getUint16(hmtx.offset + Math.min(gid, metrics - 1) * 4),
    contoursOf: (gid) => contoursOf(gid),
  };
}

/**
 * The point stream, with the implied on-curve points put back.
 *
 * The three coordinate arrays are read in the order the format stores
 * them — all the flags, then all the x deltas, then all the y deltas —
 * so the x pass has to run to completion before the y pass knows where
 * to start. That is why the flags are materialised into an array rather
 * than streamed.
 */
function simpleGlyph(dv: DataView, start: number, contours: number): GlyphContour[] {
  const ends: number[] = [];
  for (let i = 0; i < contours; i++) ends.push(dv.getUint16(start + 10 + i * 2));
  const count = contours === 0 ? 0 : ends[contours - 1]! + 1;
  if (count === 0) return [];

  let at = start + 10 + contours * 2;
  at += 2 + dv.getUint16(at); // the hinting instructions, read past

  const flags = new Uint8Array(count);
  for (let i = 0; i < count; ) {
    const flag = dv.getUint8(at++);
    flags[i++] = flag;
    if (flag & REPEAT) {
      let repeats = dv.getUint8(at++);
      while (repeats-- > 0 && i < count) flags[i++] = flag;
    }
  }

  const xs = new Int32Array(count);
  let x = 0;
  for (let i = 0; i < count; i++) {
    const flag = flags[i]!;
    if (flag & X_SHORT) {
      const delta = dv.getUint8(at++);
      x += flag & X_SAME_OR_POSITIVE ? delta : -delta;
    } else if (!(flag & X_SAME_OR_POSITIVE)) {
      // Without the short flag, the "same" bit means the coordinate did
      // not change and nothing is stored for it at all.
      x += dv.getInt16(at);
      at += 2;
    }
    xs[i] = x;
  }

  const ys = new Int32Array(count);
  let y = 0;
  for (let i = 0; i < count; i++) {
    const flag = flags[i]!;
    if (flag & Y_SHORT) {
      const delta = dv.getUint8(at++);
      y += flag & Y_SAME_OR_POSITIVE ? delta : -delta;
    } else if (!(flag & Y_SAME_OR_POSITIVE)) {
      y += dv.getInt16(at);
      at += 2;
    }
    ys[i] = y;
  }

  const out: GlyphContour[] = [];
  let from = 0;
  for (const last of ends) {
    const points: GlyphPoint[] = [];
    for (let i = from; i <= last; i++) {
      points.push({ x: xs[i]!, y: ys[i]!, on: (flags[i]! & ON_CURVE) !== 0 });
    }
    if (points.length > 0) out.push(points);
    from = last + 1;
  }
  return out;
}

/**
 * A glyph assembled out of other glyphs, each under its own transform.
 *
 * Point-matching placement — the form where the arguments are point
 * indices rather than offsets — throws rather than being guessed at. It
 * is used by hand-built accented faces and by nothing in a subset of
 * digits and capitals, and placing a component at the wrong offset draws
 * a glyph that is confidently wrong.
 */
function compositeGlyph(
  dv: DataView,
  start: number,
  partOf: (gid: number) => GlyphContour[],
): GlyphContour[] {
  const out: GlyphContour[] = [];
  let at = start + 10;

  for (;;) {
    const flags = dv.getUint16(at);
    const component = dv.getUint16(at + 2);
    at += 4;

    let dx: number;
    let dy: number;
    if (flags & ARG_1_AND_2_ARE_WORDS) {
      dx = dv.getInt16(at);
      dy = dv.getInt16(at + 2);
      at += 4;
    } else {
      dx = dv.getInt8(at);
      dy = dv.getInt8(at + 1);
      at += 2;
    }
    if (!(flags & ARGS_ARE_XY_VALUES)) {
      throw new Error("composite glyph places a component by point matching, which this reader does not do");
    }

    // F2Dot14: a signed 16-bit fixed-point value with two integer bits.
    const f2dot14 = (offset: number): number => dv.getInt16(offset) / 16384;
    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    if (flags & WE_HAVE_A_SCALE) {
      a = d = f2dot14(at);
      at += 2;
    } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
      a = f2dot14(at);
      d = f2dot14(at + 2);
      at += 4;
    } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
      a = f2dot14(at);
      b = f2dot14(at + 2);
      c = f2dot14(at + 4);
      d = f2dot14(at + 6);
      at += 8;
    }

    for (const contour of partOf(component)) {
      out.push(
        contour.map((p) => ({ x: a * p.x + c * p.y + dx, y: b * p.x + d * p.y + dy, on: p.on })),
      );
    }

    if (!(flags & MORE_COMPONENTS)) break;
  }
  return out;
}
