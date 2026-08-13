/**
 * Compose a Redwall: the theme's art, with this machine's state on it.
 *
 * One function, and it is a pure one — the same art, the same state and
 * the same theme produce the same bytes. That is not a stylistic
 * preference. A Redwall is regenerated every time the state it displays
 * changes, so "did anything actually change" has to be answerable by
 * comparing bytes; and a renderer that could be tested only by looking
 * at a desktop could not be tested at all in CI.
 *
 * ## What it draws, and what it never touches
 *
 * The art underneath is unchanged. This composes *on top of* the brand
 * sheet, never in place of it, which is what keeps Redwall compatible
 * with the decision `wallpaper.ts` records: the desktop carries the
 * mark, and a generator that could not draw one is why the old gradient
 * was retired. Outside the overlay's rounded card the output is the input,
 * pixel for pixel.
 *
 * ## Why there is a plate at all
 *
 * The overlay puts an opaque, rounded card down and writes on that, rather
 * than writing straight onto the art. The reason is `flare`: its sheet
 * is a field of red.500, and paper text on red.500 measures 3.75 — a
 * failure by the brand's own guardrail. Text laid directly on art is
 * legible only if something checked the art, and checking the art means
 * sampling pixels, which Spec #52 ruled out for a reason worth keeping:
 * a sampled colour is a colour nobody declared, so nothing can assert
 * about it before the image exists.
 *
 * With a plate, the ground and both text roles are colours the *theme*
 * declares, and each pair can be
 * measured in `theme-contrast.test.ts` alongside every other pair this
 * project draws. Legibility becomes arithmetic instead of a look.
 *
 * ## Where it sits
 *
 * Top right. The left edge is where GNOME and Windows put desktop icons,
 * while the bottom belongs to the taskbar, activation notices and transient
 * system UI. The top inset also clears desktop chrome after a high-resolution
 * sheet is scaled down to the display. Keeping a small instrument near the
 * top-right edge leaves the brand mark and the working edges of the desktop
 * alone. Its lower half is a year-at-a-glance: week columns, weekday rows,
 * and a continuous progress bar, all derived from the local civil day.
 */

import { rgb } from "./brand.ts";
import type { HostStateAttention } from "./host-state.ts";
import { decodePng, encodePng, type Raster } from "./png.ts";
import { REDWALL_CHARSET } from "./redwall-charset.ts";
import type { Hex, Theme } from "./themes.ts";
import { readFont, type Font } from "./ttf.ts";
import { typeset, type Mask } from "./typeset.ts";

/**
 * What the overlay reports, with `null` meaning "not known".
 *
 * Daemon state and address are independently absent, and that is
 * load-bearing: see `host-state.ts`, which makes sure a daemon that is not
 * running costs its operational facts and not the address as well.
 */
export interface RedwallState {
  /** Workers running here. Zero is a real answer; null is no answer. */
  readonly workers: number | null;
  /** Scheduler capacity, absent when multiple execution domains were merged. */
  readonly capacity?: number | null;
  /** Work waiting across registered projects. */
  readonly queued?: number | null;
  /** The highest-severity condition the daemon can state compactly. */
  readonly attention?: HostStateAttention | null;
  /** Remaining GitHub budgets, kept separate because API and GraphQL reset independently. */
  readonly github?: { readonly api: number; readonly graphql: number } | null;
  /** The address this machine answers on, as a dotted quad. */
  readonly address: string | null;
}

export interface RedwallInput {
  /** The selected bundled or imported wallpaper, as PNG bytes. */
  readonly art: Uint8Array;
  /** The face to rasterise with — the bytes at `REDWALL_SUBSET`. */
  readonly font: Uint8Array;
  readonly theme: Theme;
  readonly state: RedwallState;
  /** Local calendar day to visualise. Explicit keeps the renderer pure. */
  readonly year: RedwallYear;
}

/** The part of a civil year needed to draw its progress. */
export interface RedwallYear {
  readonly year: number;
  /** Days elapsed including today. */
  readonly elapsed: number;
  readonly days: 365 | 366;
  /** Sunday = 0, matching Date#getDay(). */
  readonly firstWeekday: number;
}

/** Turn a local instant into stable calendar coordinates. */
export function yearProgress(at: Date): RedwallYear {
  const year = at.getFullYear();
  const month = at.getMonth();
  const date = at.getDate();
  const elapsed = Math.floor(
    (Date.UTC(year, month, date) - Date.UTC(year, 0, 1)) / 86_400_000,
  ) + 1;
  const days = (new Date(year, 1, 29).getMonth() === 1 ? 366 : 365) as 365 | 366;
  return {
    year,
    elapsed: Math.max(1, Math.min(days, elapsed)),
    days,
    firstWeekday: new Date(year, 0, 1).getDay(),
  };
}

export function yearProgressLabel(value: RedwallYear): string {
  return `${value.year} · ${Math.floor((value.elapsed / value.days) * 100)}%`;
}

export interface RedwallYearCell {
  readonly day: number;
  readonly column: number;
  readonly row: number;
  readonly state: "past" | "today" | "future";
}

/** One square per day, arranged as week columns and weekday rows. */
export function yearCells(value: RedwallYear): RedwallYearCell[] {
  return Array.from({ length: value.days }, (_, index) => {
    const day = index + 1;
    const slot = value.firstWeekday + index;
    return {
      day,
      column: Math.floor(slot / 7),
      row: slot % 7,
      state: day < value.elapsed ? "past" : day === value.elapsed ? "today" : "future",
    };
  });
}

/** The card's bounding box. Everything outside its rounded shape is art. */
export interface RedwallBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The declared colours the overlay is painted in. */
export interface RedwallInk {
  /** The plate the text is set on. */
  readonly plate: Hex;
  /** The text itself. */
  readonly text: Hex;
  /** Operational facts below the headline. */
  readonly secondary: Hex;
  /** The daemon's signal rail and state mark. */
  readonly signal: Hex;
}

/**
 * The overlay's colours, from what the theme declares about itself.
 *
 * The plate is the theme's own deepest ground — the colour `themes.ts`
 * describes as the wallpaper's base — so the block reads as part of the
 * desktop rather than as a sticker on it. Headline and operational facts
 * use the theme's declared strong and normal text roles; the narrow signal
 * rail uses its declared accent when it has one. No pixel is consulted,
 * which makes every pair knowable, and therefore assertable, before drawing.
 */
export function redwallInk(theme: Theme): RedwallInk {
  return {
    plate: theme.surface.bg,
    text: theme.text.strong,
    secondary: theme.text.normal,
    signal: theme.accent.kind === "colour" ? theme.accent.value : theme.text.normal,
  };
}

/**
 * The lines the overlay writes, in the order it writes them.
 *
 * A value the embedded face cannot draw is dropped rather than
 * substituted or thrown over. The face covers `REDWALL_CHARSET` and no
 * more (see `redwall-charset.ts`), so an IPv6 address — which nothing
 * here produces today and a future `lan-address.ts` might — must not be
 * able to turn a wallpaper regeneration into a crash. What is dropped is
 * one line; what is kept is the other, which is the same rule
 * `host-state.ts` states for a missing daemon.
 */
export function redwallLines(state: RedwallState): string[] {
  const address = state.address !== null && validAddress(state.address) && drawable(state.address)
    ? state.address
    : null;
  const github = githubLine(state.github);
  if (state.workers === null) {
    return ["redskilled unavailable", github, address].filter((line): line is string => line !== null);
  }
  if (!Number.isSafeInteger(state.workers) || state.workers < 0) return [];

  const workers = state.workers;
  const capacity = validCount(state.capacity) ? state.capacity : null;
  const queued = validCount(state.queued) ? state.queued : null;
  let headline: string;
  let detail: string;
  if (state.attention) {
    headline = "redskilled needs attention";
    detail = attentionLine(state.attention);
    if (queued !== null && queued > 0) detail += ` · ${queued} queued`;
  } else if (capacity !== null && capacity > 0 && workers >= capacity && (queued ?? 0) > 0) {
    headline = "redskilled at capacity";
    detail = workerLine(workers, capacity);
    if (queued !== null) detail += ` · ${queued} queued`;
  } else if (workers > 0) {
    headline = "redskilled at work";
    detail = workerLine(workers, capacity);
    if (queued !== null) detail += queued === 0 ? " · nothing queued" : ` · ${queued} queued`;
  } else {
    headline = "redskilled standing by";
    detail = queued === 0 ? "nothing queued" : queued === null ? "0 workers" : `${queued} queued`;
  }

  const lines = [headline, detail];
  if (github !== null) lines.push(github);
  if (address !== null) lines.push(address);
  return lines.every(drawable) ? lines : [];
}

function githubLine(value: RedwallState["github"]): string | null {
  if (!value || !validPercent(value.api) || !validPercent(value.graphql)) return null;
  return `github api ${value.api}% · gql ${value.graphql}%`;
}

function validPercent(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100;
}

function validCount(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function drawable(line: string): boolean {
  return [...line].every((ch) => REDWALL_CHARSET.includes(ch));
}

function validAddress(value: string): boolean {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const number = Number.parseInt(octet, 10);
    return number >= 0 && number <= 255;
  });
}

function workerLine(workers: number, capacity: number | null): string {
  if (capacity !== null) return `${workers}/${capacity} workers`;
  return `${workers} ${workers === 1 ? "worker" : "workers"}`;
}

function attentionLine(attention: HostStateAttention): string {
  switch (attention.kind) {
    case "births-paused": return "worker births paused";
    case "admission-refused": return "worker admission refused";
    case "worker-shortfall": return attention.count === null
      ? "workers short"
      : `${attention.count} workers short`;
    case "memory-overcommitted": return "memory overcommitted";
    case "workers-unisolated": return "workers not isolated";
    case "update-available": return "update available";
  }
}

interface RedwallScale {
  title: number;
  detail: number;
  padX: number;
  padY: number;
  gap: number;
  margin: number;
  topInset: number;
  radius: number;
  rail: number;
  calendarCell: number;
  calendarGap: number;
  calendarBar: number;
  sectionGap: number;
}

interface RedwallLayout {
  box: RedwallBox;
  scale: RedwallScale;
  title: Mask;
  details: Mask[];
  year: RedwallYear;
  yearLabel: Mask;
  calendarTop: number;
  calendarWidth: number;
  calendarHeight: number;
}

/** Two levels of type and the quiet space around them, scaled with the art. */
function scaleFor(height: number): RedwallScale {
  const title = Math.max(12, Math.round(height / 66));
  const detail = Math.max(10, Math.round(title * 0.58));
  return {
    title,
    detail,
    padX: Math.round(title * 0.62),
    padY: Math.round(title * 0.52),
    gap: Math.max(4, Math.round(detail * 0.38)),
    margin: Math.round(title * 1.35),
    // A 4K sheet is commonly reduced to less than half size on the desktop.
    // Keep enough vertical room for GNOME's top bar after that projection;
    // the right edge does not need the same system-chrome reserve.
    topInset: Math.round(title * 2.5),
    radius: Math.round(title * 0.5),
    rail: Math.max(2, Math.round(title * 0.1)),
    calendarCell: Math.max(2, Math.round(title * 0.15)),
    calendarGap: Math.max(1, Math.round(title * 0.06)),
    calendarBar: Math.max(2, Math.round(title * 0.14)),
    sectionGap: Math.max(6, Math.round(detail * 0.7)),
  };
}

function layoutFor(
  art: { readonly width: number; readonly height: number },
  font: Font,
  lines: readonly string[],
  year: RedwallYear,
): RedwallLayout | null {
  if (lines.length === 0) return null;
  const scale = scaleFor(art.height);
  const title = typeset(font, [lines[0]!], scale.title);
  const details = lines.slice(1).map((line) => typeset(font, [line], scale.detail));
  const yearLabel = typeset(font, [yearProgressLabel(year)], scale.detail);
  const calendarColumns = Math.ceil((year.firstWeekday + year.days) / 7);
  const calendarWidth = calendarColumns * scale.calendarCell +
    (calendarColumns - 1) * scale.calendarGap;
  const calendarHeight = 7 * scale.calendarCell + 6 * scale.calendarGap;
  const signalReserve = Math.round(scale.title * 1.5);
  const contentWidth = Math.max(
    title.width + signalReserve,
    ...details.map((mask) => mask.width),
    yearLabel.width,
    calendarWidth,
  );
  const stateHeight = title.height +
    details.reduce((sum, mask) => sum + scale.gap + mask.height, 0);
  const calendarTop = scale.padY + stateHeight + scale.sectionGap;
  const contentHeight = stateHeight + scale.sectionGap + yearLabel.height + scale.gap +
    calendarHeight + scale.gap + scale.calendarBar;
  const width = contentWidth + scale.padX * 2;
  const height = contentHeight + scale.padY * 2;
  return {
    box: {
      x: Math.max(0, art.width - scale.margin - width),
      y: Math.max(0, scale.topInset),
      width,
      height,
    },
    scale,
    title,
    details,
    year,
    yearLabel,
    calendarTop,
    calendarWidth,
    calendarHeight,
  };
}

/**
 * Where the overlay lands on art of a given size, or null for no lines.
 *
 * Exported so a test can say "everything outside this rectangle is
 * untouched" without re-deriving the layout from the same constants the
 * renderer used — a check written against its own subject's arithmetic
 * proves only that the arithmetic was copied correctly.
 */
export function redwallBox(
  art: { readonly width: number; readonly height: number },
  font: Font,
  lines: readonly string[],
  year: RedwallYear,
): RedwallBox | null {
  return layoutFor(art, font, lines, year)?.box ?? null;
}

/**
 * The art with the state drawn on it, as PNG bytes.
 *
 * State with no drawable lines returns the art it was given, byte for byte
 * and without a re-encode. An unreachable daemon is itself drawable state:
 * it deliberately produces the quiet unavailable card even without a route.
 */
export function renderRedwall(input: RedwallInput): Uint8Array {
  const lines = redwallLines(input.state);
  if (lines.length === 0) return input.art;

  const raster = decodePng(input.art);
  const font = readFont(input.font);
  const layout = layoutFor(raster, font, lines, input.year)!;

  paint(raster, layout, lines[0]!, redwallInk(input.theme));
  return encodePng(raster);
}

/**
 * Lay the plate down and pour the ink through the mask.
 *
 * The blend is against the plate rather than against the art, because
 * the plate is opaque and already covers every pixel this touches. That
 * is what makes the measured contrast of an antialiased edge a value
 * between the two declared colours and never a third one taken from
 * whatever the sheet happened to have there.
 */
function paint(
  raster: Raster,
  layout: RedwallLayout,
  headline: string,
  ink: RedwallInk,
): void {
  const { box, scale, title, details } = layout;
  const [pr, pg, pb] = rgb(ink.plate);
  const [sr, sg, sb] = rgb(ink.signal);
  const { data, width } = raster;

  for (let y = 0; y < box.height; y++) {
    const row = box.y + y;
    if (row < 0 || row >= raster.height) continue;

    for (let x = 0; x < box.width; x++) {
      const column = box.x + x;
      if (column < 0 || column >= width) continue;
      if (!insideRounded(x, y, box.width, box.height, scale.radius)) continue;

      const at = (row * width + column) * 4;
      const signal = x < scale.rail;
      data[at] = signal ? sr : pr;
      data[at + 1] = signal ? sg : pg;
      data[at + 2] = signal ? sb : pb;
      data[at + 3] = 255;
    }
  }

  let top = box.y + scale.padY;
  pour(raster, title, box.x + scale.padX, top, ink.plate, ink.text);
  top += title.height;
  for (const detail of details) {
    top += scale.gap;
    pour(raster, detail, box.x + scale.padX, top, ink.plate, ink.secondary);
    top += detail.height;
  }
  paintSignal(raster, layout, headline, ink);
  paintYear(raster, layout, ink);
}

/** Draw a week-column calendar and its continuous progress rail. */
function paintYear(raster: Raster, layout: RedwallLayout, ink: RedwallInk): void {
  const { box, scale, year, yearLabel, calendarTop, calendarWidth, calendarHeight } = layout;
  const left = box.x + scale.padX;
  const labelTop = box.y + calendarTop;
  pour(raster, yearLabel, left, labelTop, ink.plate, ink.secondary);

  const gridTop = labelTop + yearLabel.height + scale.gap;
  for (const cell of yearCells(year)) {
    const { column, row } = cell;
    const x = left + column * (scale.calendarCell + scale.calendarGap);
    const y = gridTop + row * (scale.calendarCell + scale.calendarGap);
    const colour = cell.state === "today"
      ? ink.text
      : cell.state === "past"
      ? ink.signal
      : ink.secondary;
    const coverage = cell.state === "future" ? 72 : 255;
    fillRect(raster, x, y, scale.calendarCell, scale.calendarCell, ink.plate, colour, coverage);
  }

  const barTop = gridTop + calendarHeight + scale.gap;
  fillRect(
    raster,
    left,
    barTop,
    calendarWidth,
    scale.calendarBar,
    ink.plate,
    ink.secondary,
    72,
  );
  fillRect(
    raster,
    left,
    barTop,
    Math.max(1, Math.round(calendarWidth * year.elapsed / year.days)),
    scale.calendarBar,
    ink.plate,
    ink.signal,
    255,
  );
}

function fillRect(
  raster: Raster,
  left: number,
  top: number,
  width: number,
  height: number,
  under: Hex,
  over: Hex,
  coverage: number,
): void {
  const [ur, ug, ub] = rgb(under);
  const [or, og, ob] = rgb(over);
  for (let y = top; y < top + height; y++) {
    if (y < 0 || y >= raster.height) continue;
    for (let x = left; x < left + width; x++) {
      if (x < 0 || x >= raster.width) continue;
      const at = (y * raster.width + x) * 4;
      raster.data[at] = mix(ur, or, coverage);
      raster.data[at + 1] = mix(ug, og, coverage);
      raster.data[at + 2] = mix(ub, ob, coverage);
      raster.data[at + 3] = 255;
    }
  }
}

function insideRounded(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): boolean {
  const cx = Math.max(radius, Math.min(width - radius - 1, x));
  const cy = Math.max(radius, Math.min(height - radius - 1, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function pour(
  raster: Raster,
  mask: Mask,
  left: number,
  top: number,
  under: Hex,
  over: Hex,
): void {
  const [ur, ug, ub] = rgb(under);
  const [or, og, ob] = rgb(over);
  for (let y = 0; y < mask.height; y++) {
    const row = top + y;
    if (row < 0 || row >= raster.height) continue;
    for (let x = 0; x < mask.width; x++) {
      const column = left + x;
      if (column < 0 || column >= raster.width) continue;
      const covered = mask.alpha[y * mask.width + x]!;
      if (covered === 0) continue;
      const at = (row * raster.width + column) * 4;
      raster.data[at] = mix(ur, or, covered);
      raster.data[at + 1] = mix(ug, og, covered);
      raster.data[at + 2] = mix(ub, ob, covered);
      raster.data[at + 3] = 255;
    }
  }
}

function paintSignal(
  raster: Raster,
  layout: RedwallLayout,
  headline: string,
  ink: RedwallInk,
): void {
  const { box, scale, title } = layout;
  const radius = Math.max(3, Math.round(scale.title * 0.15));
  const centerX = box.x + box.width - scale.padX - radius;
  const centerY = box.y + scale.padY + Math.round(title.height / 2);
  const colour = headline.endsWith("unavailable") ? ink.secondary : ink.signal;
  const [r, g, b] = rgb(colour);
  const standby = headline.endsWith("standing by");
  const attention = headline.endsWith("needs attention");
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const distance = Math.hypot(dx, dy);
      const covered = attention
        ? Math.abs(dx) + Math.abs(dy) <= radius
        : standby
        ? distance <= radius && distance >= radius - Math.max(2, scale.rail)
        : distance <= radius;
      if (!covered) continue;
      const x = centerX + dx;
      const y = centerY + dy;
      if (x < 0 || x >= raster.width || y < 0 || y >= raster.height) continue;
      const at = (y * raster.width + x) * 4;
      raster.data[at] = r;
      raster.data[at + 1] = g;
      raster.data[at + 2] = b;
      raster.data[at + 3] = 255;
    }
  }
}

function mix(under: number, over: number, coverage: number): number {
  return Math.round((over * coverage + under * (255 - coverage)) / 255);
}
