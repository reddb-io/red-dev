/**
 * The one ANSI palette. Not theme data: it does not vary, ever.
 *
 * Colouring the terminal per theme is the decision this file reverses.
 * The symptom was that switching theme looked like it had done nothing:
 * every program inside the window carries its own palette, applies it
 * over the terminal's, and the sixteen slots underneath stop being
 * legible as a choice. So the terminal gets one palette — this one — and
 * the themes move to the surfaces where a change is actually visible:
 * the wallpaper, the Windows accent, GNOME, VS Code.
 *
 * ## Why an ANSI table is allowed seven hues when the brand publishes one
 *
 * The brand is emphatic: "the red is the only accent", and on syntax
 * colouring, "three tiers, not a rainbow ... a dozen-colour highlighter
 * is the seven-colour spectrum problem arriving through a plugin".
 *
 * That is a producer-side rule — an author choosing how many token
 * classes to spend colour on, where restraint is free because the author
 * owns both ends. The ANSI table is consumer-side. `ls` emits SGR 34 for
 * a directory, `git diff` emits 32 and 31, `grep` emits 01;31, `fzf`
 * emits 36. red-dev does not choose how many colours those programs use;
 * it only chooses what the slots look like. Collapsing blue into the
 * neutral ramp does not produce restraint, it produces a terminal where
 * a directory is indistinguishable from a file.
 *
 * So: the ANSI table is a compatibility interface, not a brand surface.
 * The brand's intent is still honoured, and measurably — exactly one
 * slot carries the accent's chroma. #ff2056 is the only value here at
 * saturation 1.000; every other chromatic slot is capped at 0.692, the
 * chroma of the one non-accent colour the brand has decided. Nothing can
 * compete with the accent, which is the rule, expressed as a number.
 *
 * Ten of the twenty values are published tokens, unmodified.
 *
 * ## Where the five hues the brand does not publish come from
 *
 * Nothing here is a taste judgement; every magnitude is derived from a
 * brand-decided input, and src/terminal-palette.test.ts recomputes the
 * derivation from the vendored tokens rather than trusting these
 * literals.
 *
 *   dL      = L(red.400) - L(red.500) = 0.131   the ramp's own bright step
 *   h(blue) = h(neutral.400)          = 223.6   the ramp is ALREADY blue
 *   h(cyan) = mid(h(green), h(blue))  = 182.8
 *   h(mag)  = mid(h(blue), h(red))    = 284.6
 *   chroma  = S and L of --ok         = 0.692 / 0.580
 *   bright  = same hue and S, L + dL, except where a token exists
 *
 * Blue is the load-bearing one, and it is not invented. The whole
 * neutral ramp measures 220-227 degrees — it is a cool-tinted *blue*.
 * neutral.400 is a blue at S=0.105. Raising its chroma to the level the
 * brand already chose for --ok produces the brand's own blue rather than
 * a new hue. Cyan and magenta are then hue midpoints, not decisions.
 *
 * ## What is a local override, and what was left on the floor
 *
 * green and yellow are `--ok #4ade80` and `--warn #fbbf24`, locked in
 * brand issue #10 and deliberately unpublished (brand ADR 0011 names the
 * absence a known cost). Adopting an undecided brand value is the shape
 * brand ADR 0006 sanctions; inventing a different green would be the
 * fork it forbids.
 *
 * `--danger #ff5470` from the same issue is left on the floor. It sits
 * 4.7 degrees of hue from #ff2056 at identical saturation, and two reds
 * five degrees apart in one sixteen-slot table read as a rendering bug
 * rather than a distinction. ANSI red is the accent.
 *
 * Which collides with issue #10's own rule that "the accent never
 * signals error" — and in a terminal, ANSI red IS how error is
 * signalled, by every compiler and every failed test. There is no
 * ANSI-conformant way out: the slot is named `red` and the programs
 * choose it, not us. Filed upstream rather than resolved here.
 *
 * See .red/adr/0002-the-terminal-palette-is-fixed.md.
 */

import { neutral, red, type Hex } from "./brand.ts";

/**
 * The twenty slots.
 *
 * These field names are Windows Terminal's schema, not ours: src/wsl.ts
 * spreads this object verbatim into `settings.schemes`, so renaming
 * `purple` to `magenta` would silently produce a scheme WT ignores.
 * Alacritty is the one needing the translation, and colorsToml does it.
 */
export interface TerminalPalette {
  background: Hex;
  foreground: Hex;
  cursorColor: Hex;
  selectionBackground: Hex;
  black: Hex;
  red: Hex;
  green: Hex;
  yellow: Hex;
  blue: Hex;
  purple: Hex;
  cyan: Hex;
  white: Hex;
  brightBlack: Hex;
  brightRed: Hex;
  brightGreen: Hex;
  brightYellow: Hex;
  brightBlue: Hex;
  brightPurple: Hex;
  brightCyan: Hex;
  brightWhite: Hex;
}

/**
 * LOCAL OVERRIDE — brand issue #10 decided these and never published
 * them. Adopted rather than reinvented; see the header.
 */
const OK = "#4ade80";
const WARN = "#fbbf24";

/**
 * LOCAL OVERRIDE — the brand has no blue, cyan or magenta at all.
 * Derived by the rule in the header, and re-derived by the test.
 */
const BLUE = "#4a72de";
const CYAN = "#4ad7de";
const MAGENTA = "#b84ade";
const BRIGHT_GREEN = "#83e8a8";
const BRIGHT_YELLOW = "#fcd266";
const BRIGHT_BLUE = "#839ee8";
const BRIGHT_CYAN = "#83e4e8";
const BRIGHT_MAGENTA = "#ce83e8";

export const RED_DEV_ANSI: TerminalPalette = {
  background: neutral[950],
  foreground: neutral[300],
  cursorColor: red[500],
  selectionBackground: neutral[700],

  black: neutral[900],
  red: red[500],
  green: OK,
  yellow: WARN,
  blue: BLUE,
  purple: MAGENTA,
  cyan: CYAN,
  white: neutral[300],

  // neutral.500 measures 3.87 on ink, below AA, and that is deliberate.
  // It is the brand's own --muted, and tokens.json already declares it
  // as failing normal text on every dark ground. This is the dim slot —
  // comments, ignored files, elapsed times. Being quiet is its function,
  // and the alternative (neutral.400 at 6.36) sits one ramp step from
  // the foreground and stops reading as dim at all.
  brightBlack: neutral[500],
  brightRed: red[400],
  brightGreen: BRIGHT_GREEN,
  brightYellow: BRIGHT_YELLOW,
  brightBlue: BRIGHT_BLUE,
  brightPurple: BRIGHT_MAGENTA,
  brightCyan: BRIGHT_CYAN,
  brightWhite: neutral[50],
};

/**
 * The scheme name Windows Terminal stores it under.
 *
 * A constant because two places have to agree on it: the scheme object
 * pushed into `settings.schemes`, and `profiles.defaults.colorScheme`
 * that points at it. They used to agree by both reading `theme.name`,
 * which is what left ten retired schemes behind.
 */
export const ANSI_SCHEME_NAME = "RedDB";

/**
 * Alacritty's colours.
 *
 * Alacritty names the sixth colour `magenta`; every terminal scheme
 * published for the last thirty years calls it `purple`. Map rather than
 * duplicating the palette.
 *
 * No parameter, deliberately. There is nothing else to pass, and a
 * parameter — even a defaulted one — invites a caller to pass something,
 * which is the door this whole change is closing.
 */
export function colorsToml(): string {
  const c = RED_DEV_ANSI;
  return `# Generated by red-dev — the RedDB terminal palette.
#
# This does not change with the theme, and that is on purpose: every
# program inside the terminal carries its own palette and paints over
# these sixteen slots, so varying them made a theme switch look like it
# had failed. Themes move the wallpaper, the system accent and VS Code.
#
# Put personal overrides in alacritty.toml, which red-dev creates once
# and never rewrites.

[colors.primary]
background = '${c.background}'
foreground = '${c.foreground}'

[colors.cursor]
cursor = '${c.cursorColor}'
text = '${c.background}'

[colors.selection]
background = '${c.selectionBackground}'
text = 'CellForeground'

[colors.normal]
black   = '${c.black}'
red     = '${c.red}'
green   = '${c.green}'
yellow  = '${c.yellow}'
blue    = '${c.blue}'
magenta = '${c.purple}'
cyan    = '${c.cyan}'
white   = '${c.white}'

[colors.bright]
black   = '${c.brightBlack}'
red     = '${c.brightRed}'
green   = '${c.brightGreen}'
yellow  = '${c.brightYellow}'
blue    = '${c.brightBlue}'
magenta = '${c.brightPurple}'
cyan    = '${c.brightCyan}'
white   = '${c.brightWhite}'
`;
}

/** The Windows Terminal scheme object, ready to push into settings. */
export function wtScheme(): Record<string, string> {
  return { name: ANSI_SCHEME_NAME, ...RED_DEV_ANSI };
}
