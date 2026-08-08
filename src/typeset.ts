/**
 * Lines of text turned into coverage, one glyph outline at a time.
 *
 * This is the rasteriser Spec #52 chose over an embedded bitmap atlas.
 * The reason is in `redwall-font.ts`: the overlay has to look the same
 * on a machine whose owner picked a different terminal font, and a
 * bitmap atlas would have fixed the size at vendor time — a 4K desktop
 * and a 1080p one would then get the same pixel height of text, which is
 * half the size on one of them.
 *
 * What comes out is a mask, not an image. Coverage says how much of each
 * pixel the letterforms cover and says nothing about colour; the caller
 * decides what to pour through it. That is what keeps the ink colour a
 * decision `redwall-render.ts` makes from the theme, in one place, where
 * the contrast table can see it.
 *
 * ## Determinism
 *
 * Every number here is IEEE double arithmetic on inputs that are
 * integers from the font file, so the same text at the same size is the
 * same mask, byte for byte, on every machine. Nothing samples, nothing
 * consults a clock, and the curve flattening subdivides by a count
 * derived from the control polygon rather than by an error tolerance
 * loop — a loop would still be deterministic, but a count is obviously
 * so.
 *
 * ## Fill rule
 *
 * Non-zero winding, which is what TrueType specifies: a counter is
 * incremented on downward crossings and decremented on upward ones, and
 * anything not at zero is inside. The even-odd rule would hollow out the
 * bowl of an 'O' correctly by accident and get an overlapping contour
 * wrong, and overlapping contours are ordinary in a real face.
 */

import type { Font, GlyphContour } from "./ttf.ts";

/** Coverage, 0 (bare) to 255 (solid), row-major, `width * height` bytes. */
export interface Mask {
  readonly width: number;
  readonly height: number;
  readonly alpha: Uint8Array;
}

/**
 * How many sub-scanlines each pixel row is sampled at.
 *
 * Vertical coverage is sampled and horizontal coverage is exact — the
 * span arithmetic below counts the fraction of a pixel a span covers
 * rather than testing its centre — so four rows buys most of what
 * sixteen would. Text this size is read at a glance from across a room,
 * not measured.
 */
const SAMPLES = 4;

interface Vertex {
  readonly x: number;
  readonly y: number;
}

interface Edge {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Where a set of lines will sit, before any of it is drawn. */
export interface Metrics {
  /** The widest line, in pixels. */
  readonly width: number;
  /** Every line's box stacked, in pixels. */
  readonly height: number;
  /** Baseline to baseline. */
  readonly lineHeight: number;
  /** Baseline of the first line, measured from the top of the box. */
  readonly ascent: number;
}

export function measure(font: Font, lines: readonly string[], size: number): Metrics {
  const scale = size / font.unitsPerEm;
  const ascent = font.ascender * scale;
  const lineHeight = (font.ascender - font.descender + font.lineGap) * scale;

  let width = 0;
  for (const line of lines) width = Math.max(width, lineWidth(font, line, scale));

  // The last line needs its descender, not another whole line box, or
  // every block would carry a strip of nothing along its bottom edge.
  const height = lines.length === 0 ? 0 : lineHeight * (lines.length - 1) + ascent - font.descender * scale;
  return { width, height, lineHeight, ascent };
}

function lineWidth(font: Font, line: string, scale: number): number {
  let width = 0;
  for (const ch of line) width += font.advanceOf(glyphOf(font, ch)) * scale;
  return width;
}

/**
 * The glyph for a character, or a refusal naming the character.
 *
 * `.notdef` is deliberately not the fallback. The subset is cut from the
 * character set Redwall declares (`redwall-charset.ts`), so a character
 * outside it means the two have drifted apart — and the failure mode
 * that matters is the silent one, where a machine's address renders as a
 * row of empty boxes on somebody's desktop and nothing says why.
 */
function glyphOf(font: Font, ch: string): number {
  const gid = font.glyphFor(ch.codePointAt(0)!);
  if (gid === undefined) {
    throw new Error(`the embedded face has no glyph for '${ch}' (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`);
  }
  return gid;
}

/**
 * Set the lines and fill them, left-aligned, at `size` pixels to the em.
 *
 * The mask is exactly as large as `measure` says the block is, so the
 * caller positions one rectangle rather than reasoning about baselines.
 */
export function typeset(font: Font, lines: readonly string[], size: number): Mask {
  const metrics = measure(font, lines, size);
  const width = Math.max(1, Math.ceil(metrics.width));
  const height = Math.max(1, Math.ceil(metrics.height));
  if (lines.length === 0) return { width: 1, height: 1, alpha: new Uint8Array(1) };

  const scale = size / font.unitsPerEm;
  const edges: Edge[] = [];

  for (let i = 0; i < lines.length; i++) {
    const baseline = metrics.ascent + i * metrics.lineHeight;
    let pen = 0;
    for (const ch of lines[i]!) {
      const gid = glyphOf(font, ch);
      for (const contour of font.contoursOf(gid)) {
        // Font space has y pointing up from the baseline; a raster has
        // it pointing down from the top. The flip is the subtraction.
        addContour(edges, contour, (x, y) => ({ x: pen + x * scale, y: baseline - y * scale }));
      }
      pen += font.advanceOf(gid) * scale;
    }
  }

  return { width, height, alpha: fill(edges, width, height) };
}

// -------------------------------------------------------------- outlines

/**
 * One contour, flattened into the polyline that approximates it.
 *
 * The awkward part is the format's implied points: two off-curve points
 * in a row have an on-curve point at their midpoint that is not stored,
 * and a contour may have no stored on-curve point at all — in which case
 * the start is the midpoint of the last and first controls. Both cases
 * are ordinary, and both draw garbage if assumed away.
 */
function addContour(
  edges: Edge[],
  contour: GlyphContour,
  place: (x: number, y: number) => Vertex,
): void {
  const n = contour.length;
  if (n < 2) return;

  const points = contour.map((p) => ({ ...place(p.x, p.y), on: p.on }));
  const onCurve = points.findIndex((p) => p.on);
  const start: Vertex = onCurve >= 0 ? points[onCurve]! : midpoint(points[n - 1]!, points[0]!);

  // With a stored start, that point is already placed and the walk
  // continues past it. Without one, the walk begins at the first control.
  const from = onCurve >= 0 ? onCurve + 1 : 0;
  const count = onCurve >= 0 ? n - 1 : n;

  const line: Vertex[] = [start];
  let current = start;
  let control: Vertex | null = null;

  for (let k = 0; k < count; k++) {
    const point = points[(from + k) % n]!;
    if (point.on) {
      if (control === null) line.push(point);
      else curve(line, current, control, point);
      current = point;
      control = null;
    } else if (control === null) {
      control = point;
    } else {
      const implied = midpoint(control, point);
      curve(line, current, control, implied);
      current = implied;
      control = point;
    }
  }

  // Closing the loop, through a final control if one is still open.
  if (control === null) line.push(start);
  else curve(line, current, control, start);

  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    if (a.y !== b.y) edges.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
  }
}

function midpoint(a: Vertex, b: Vertex): Vertex {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * A quadratic, subdivided into segments no longer than about a pixel.
 *
 * The count comes from the control polygon's length, which is an upper
 * bound on the curve's own — so the segments are never coarser than
 * asked for, and a curve two pixels across costs two segments rather
 * than the thirty-two a fixed count would spend on it.
 */
function curve(line: Vertex[], p0: Vertex, control: Vertex, p1: Vertex): void {
  const span = distance(p0, control) + distance(control, p1);
  const steps = Math.max(2, Math.min(32, Math.ceil(span)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    line.push({
      x: u * u * p0.x + 2 * u * t * control.x + t * t * p1.x,
      y: u * u * p0.y + 2 * u * t * control.y + t * t * p1.y,
    });
  }
}

function distance(a: Vertex, b: Vertex): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// ------------------------------------------------------------------ fill

function fill(edges: readonly Edge[], width: number, height: number): Uint8Array {
  const coverage = new Float64Array(width * height);
  const crossings: Array<{ x: number; winding: number }> = [];
  const weight = 1 / SAMPLES;

  for (let row = 0; row < height; row++) {
    const at = row * width;
    for (let sample = 0; sample < SAMPLES; sample++) {
      const y = row + (sample + 0.5) / SAMPLES;

      crossings.length = 0;
      for (const edge of edges) {
        const top = Math.min(edge.y0, edge.y1);
        const bottom = Math.max(edge.y0, edge.y1);
        // Half-open in y: an edge that ends exactly on this scanline
        // belongs to the edge that starts there, and counting both would
        // wind twice at every horizontal join.
        if (y < top || y >= bottom) continue;
        crossings.push({
          x: edge.x0 + ((y - edge.y0) * (edge.x1 - edge.x0)) / (edge.y1 - edge.y0),
          winding: edge.y1 > edge.y0 ? 1 : -1,
        });
      }
      if (crossings.length < 2) continue;

      crossings.sort((a, b) => a.x - b.x);
      let winding = 0;
      for (let i = 0; i + 1 < crossings.length; i++) {
        winding += crossings[i]!.winding;
        if (winding !== 0) span(coverage, at, crossings[i]!.x, crossings[i + 1]!.x, weight, width);
      }
    }
  }

  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = Math.min(255, Math.round(coverage[i]! * 255));
  }
  return alpha;
}

/**
 * Add one sub-scanline's worth of coverage between two x positions.
 *
 * The two ends are fractional and the middle is not, which is where the
 * horizontal antialiasing comes from: a span covering a fifth of a pixel
 * adds a fifth of this sample's weight to it.
 */
function span(
  coverage: Float64Array,
  at: number,
  from: number,
  to: number,
  weight: number,
  width: number,
): void {
  const left = Math.max(from, 0);
  const right = Math.min(to, width);
  if (right <= left) return;

  const first = Math.floor(left);
  const last = Math.floor(right);
  if (first === last) {
    coverage[at + first] = coverage[at + first]! + (right - left) * weight;
    return;
  }

  coverage[at + first] = coverage[at + first]! + (first + 1 - left) * weight;
  for (let x = first + 1; x < last; x++) coverage[at + x] = coverage[at + x]! + weight;
  if (last < width) coverage[at + last] = coverage[at + last]! + (right - last) * weight;
}
