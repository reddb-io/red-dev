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
 * Deliberately absent: `glyf` outlines, kerning, `GSUB`. Nothing draws
 * yet, and a parser written ahead of a caller is a parser written
 * against a guess.
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
