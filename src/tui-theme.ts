/**
 * The interface palette.
 *
 * Not the terminal themes in themes.ts — those are what red-dev applies
 * to *your* machine. These are the colours red-dev draws *itself* in,
 * and they do not change with the theme you pick, for the same reason
 * an installer does not repaint itself to match what it installs.
 *
 * Taken from the identity already in this repository rather than
 * invented: docs/hero.svg, the section banners and the README badges
 * have been using #ff2056 on #0d1117 since the first commit today. This
 * gives those values names so a fourth surface cannot drift from the
 * other three.
 *
 * RedDB is black and red. Everything here is a shade of one, the other,
 * or the grey between them — with exactly two exceptions, both earned:
 * a green for what succeeded and an amber for what needs attention,
 * because a red that means "brand" cannot also mean "failure".
 */

export const ui = {
  /** Page background. Near-black rather than pure, so borders can sit under it. */
  bg: "#0d1117",
  /** A panel or row lifted off the background. */
  surface: "#151a23",

  /** Primary text. */
  text: "#e6edf3",
  /** Secondary text: labels, units, anything read second. */
  muted: "#8b949e",
  /** Tertiary: separators, placeholders, things read only if hunted for. */
  subtle: "#484f58",

  /** The brand red. Accent bars, the wordmark, the selected row. */
  accent: "#ff2056",
  /** Lighter red, for a gradient ramp or a hover state. */
  accentLight: "#ff6b8a",
  /** Darker red, for the far end of a ramp. */
  accentDark: "#8b1533",

  /**
   * Status colours, and only these three.
   *
   * `accent` is the brand and must not double as an error, or a screen
   * with one failure looks the same as a screen with none.
   */
  success: "#3fb950",
  warning: "#d29922",
  danger: "#f85149",
} as const;

/** The wordmark ramp. Symmetric, because BigText cycles it per letter. */
export const wordmarkGradient = [
  ui.accentDark,
  ui.accent,
  ui.accentLight,
  ui.accent,
  ui.accentDark,
] as const;

/** Outcome to colour, in one place so the two views cannot disagree. */
export const outcomeColor: Record<string, string> = {
  installed: ui.success,
  applied: ui.success,
  present: ui.subtle,
  skipped: ui.subtle,
  failed: ui.danger,
};
