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
 * was retired. Outside the overlay's rectangle the output is the input,
 * pixel for pixel.
 *
 * ## Why there is a plate at all
 *
 * The overlay puts an opaque rectangle down and writes on that, rather
 * than writing straight onto the art. The reason is `flare`: its sheet
 * is a field of red.500, and paper text on red.500 measures 3.75 — a
 * failure by the brand's own guardrail. Text laid directly on art is
 * legible only if something checked the art, and checking the art means
 * sampling pixels, which Spec #52 ruled out for a reason worth keeping:
 * a sampled colour is a colour nobody declared, so nothing can assert
 * about it before the image exists.
 *
 * With a plate, the ground is a colour the *theme* declares, the ink is
 * a colour the theme's *appearance* declares, and the pair can be
 * measured in `theme-contrast.test.ts` alongside every other pair this
 * project draws. Legibility becomes arithmetic instead of a look.
 *
 * ## Where it sits
 *
 * Bottom right. The top left is where both GNOME and Windows put desktop
 * icons, the left edge is where GNOME's dock lives, and both lock
 * screens set their clock along the top. What is left is the corner
 * nothing else claims.
 */

import { brand, rgb } from "./brand.ts";
import { decodePng, encodePng, type Raster } from "./png.ts";
import { REDWALL_CHARSET } from "./redwall-charset.ts";
import type { Hex, Theme } from "./themes.ts";
import { readFont, type Font } from "./ttf.ts";
import { typeset, type Mask } from "./typeset.ts";

/**
 * What the overlay reports, with `null` meaning "not known".
 *
 * Both halves are independently absent, and that is load-bearing: see
 * `host-state.ts`, which exists to make sure a daemon that is not
 * running costs the Worker count and not the address as well.
 */
export interface RedwallState {
  /** Workers running here. Zero is a real answer; null is no answer. */
  readonly workers: number | null;
  /** The address this machine answers on, as a dotted quad. */
  readonly address: string | null;
}

export interface RedwallInput {
  /** The theme's wallpaper, as PNG bytes. */
  readonly art: Uint8Array;
  /** The face to rasterise with — the bytes at `REDWALL_SUBSET`. */
  readonly font: Uint8Array;
  readonly theme: Theme;
  readonly state: RedwallState;
}

/** The rectangle the overlay occupies. Everything outside it is art. */
export interface RedwallBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The two colours the overlay is painted in. */
export interface RedwallInk {
  /** The plate the text is set on. */
  readonly plate: Hex;
  /** The text itself. */
  readonly text: Hex;
}

/**
 * The overlay's colours, from what the theme declares about itself.
 *
 * The plate is the theme's own deepest ground — the colour `themes.ts`
 * describes as the wallpaper's base — so the block reads as part of the
 * desktop rather than as a sticker on it. The ink is chosen from
 * `appearance` and nothing else: a dark theme takes paper, a light one
 * takes ink. No pixel is consulted, which is what makes the pair
 * knowable, and therefore assertable, before anything is drawn.
 */
export function redwallInk(theme: Theme): RedwallInk {
  return {
    plate: theme.surface.bg,
    text: theme.appearance === "light" ? brand.ink : brand.paper,
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
  const lines: string[] = [];
  // A count that is not a plain non-negative integer has no decimal form
  // made only of digits — 1e21 and NaN both stringify into characters
  // this face has never been cut for.
  if (state.workers !== null && Number.isSafeInteger(state.workers) && state.workers >= 0) {
    lines.push(`WORKERS ${state.workers}`);
  }
  if (state.address !== null && state.address !== "") {
    const line = `LAN ${state.address}`;
    if ([...line].every((ch) => REDWALL_CHARSET.includes(ch))) lines.push(line);
  }
  return lines;
}

/** Text height in pixels, and the space around it, for art this tall. */
function scaleFor(height: number): { size: number; pad: number; margin: number } {
  // A fortieth of the height puts about forty lines of text on any
  // screen, so a 4K sheet and a 1080p one carry the same overlay at
  // different resolutions rather than the same overlay at different
  // apparent sizes. The floor is what keeps a thumbnail legible.
  const size = Math.max(12, Math.round(height / 40));
  return { size, pad: Math.round(size * 0.75), margin: Math.round(size * 2) };
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
): RedwallBox | null {
  if (lines.length === 0) return null;
  const { size, pad, margin } = scaleFor(art.height);
  const mask = typeset(font, lines, size);

  const width = mask.width + pad * 2;
  const height = mask.height + pad * 2;
  // Clamped rather than allowed to run off the edge: art smaller than
  // the overlay is a thumbnail, and a thumbnail should show what it can.
  return {
    x: Math.max(0, art.width - margin - width),
    y: Math.max(0, art.height - margin - height),
    width,
    height,
  };
}

/**
 * The art with the state drawn on it, as PNG bytes.
 *
 * State with nothing sayable in it returns the art it was given, byte
 * for byte and without a re-encode. A Redwall of an unknown machine is
 * the wallpaper, and saying so by returning the input is both cheaper
 * and more obviously true than encoding an image nothing was drawn on.
 */
export function renderRedwall(input: RedwallInput): Uint8Array {
  const lines = redwallLines(input.state);
  if (lines.length === 0) return input.art;

  const raster = decodePng(input.art);
  const font = readFont(input.font);
  const box = redwallBox(raster, font, lines)!;
  const { size, pad } = scaleFor(raster.height);

  paint(raster, box, pad, typeset(font, lines, size), redwallInk(input.theme));
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
function paint(raster: Raster, box: RedwallBox, pad: number, mask: Mask, ink: RedwallInk): void {
  const [pr, pg, pb] = rgb(ink.plate);
  const [tr, tg, tb] = rgb(ink.text);
  const { data, width } = raster;

  for (let y = 0; y < box.height; y++) {
    const row = box.y + y;
    if (row < 0 || row >= raster.height) continue;
    const my = y - pad;

    for (let x = 0; x < box.width; x++) {
      const column = box.x + x;
      if (column < 0 || column >= width) continue;
      const mx = x - pad;
      const covered =
        mx >= 0 && mx < mask.width && my >= 0 && my < mask.height
          ? mask.alpha[my * mask.width + mx]!
          : 0;

      const at = (row * width + column) * 4;
      data[at] = mix(pr, tr, covered);
      data[at + 1] = mix(pg, tg, covered);
      data[at + 2] = mix(pb, tb, covered);
      data[at + 3] = 255;
    }
  }
}

function mix(under: number, over: number, coverage: number): number {
  return Math.round((over * coverage + under * (255 - coverage)) / 255);
}
