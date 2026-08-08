/**
 * The interface palette, taken from the RedDB design system.
 *
 * Values and names both come from red-ui's
 * `packages/ui-kit/src/tokens/tokens.css`, so a terminal drawn by
 * red-dev and a page drawn by red-ui are the same black and the same
 * red rather than two people's idea of them. The ramp names — bg-0
 * through bg-3, fg-0 through fg-3 — are theirs too: someone moving
 * between the repositories should recognise the vocabulary, not have to
 * translate it.
 *
 * Not the terminal themes in themes.ts. Those are what red-dev applies
 * to *your* machine; this is what red-dev draws *itself* in, and it does
 * not change with the theme you pick, for the same reason an installer
 * does not repaint itself to match what it installs.
 *
 * Everything a terminal cannot use is dropped: radii, shadows, easing
 * curves and the sans stack have no meaning in a cell grid.
 */

export const ui = {
  /** Deepest background. RedDB is near-black, not grey. */
  bg0: "#07080a",
  bg1: "#0c0e11",
  bg2: "#14171c",
  /** Most-raised surface. */
  bg3: "#1c2027",

  /** Primary text. */
  fg0: "#f4f5f7",
  /** Secondary: values, body copy read after the label. */
  fg1: "#c8ccd4",
  /** Labels, units, anything read second. */
  fg2: "#7a8088",
  /** Separators and placeholders: read only if hunted for. */
  fg3: "#4a4f57",

  /**
   * The brand red, identical in both repositories.
   *
   * Reserved for identity and for the one value on a screen that
   * carries the answer. It is deliberately *not* the error colour —
   * `danger` is a separate, lighter red, so a screen with a failure
   * cannot look like a screen without one.
   */
  accent: "#ff2056",

  ok: "#4ade80",
  warn: "#fbbf24",
  danger: "#ff5470",
  info: "#60a5fa",
} as const;

/**
 * Aliases for the names this codebase already used.
 *
 * Kept so the call sites read as intent rather than as a position on a
 * ramp — `ui.muted` says why, `ui.fg2` says where.
 */
export const text = ui.fg0;
export const muted = ui.fg2;
export const subtle = ui.fg3;

/**
 * The wordmark ramp.
 *
 * Symmetric because BigText cycles it per letter, and seven letters over
 * five stops restarted at the darkest shade mid-word. The ends are
 * mixed toward the background rather than being a second brand red:
 * there is one accent in this system and inventing shades of it is how
 * a palette stops being one.
 */
export const wordmarkGradient = ["#8b1533", "#c41e4a", ui.accent, "#c41e4a", "#8b1533"] as const;

/** Outcome to colour, in one place so the views cannot disagree. */
export const outcomeColor: Record<string, string> = {
  installed: ui.ok,
  applied: ui.ok,
  present: ui.fg3,
  skipped: ui.fg3,
  // Amber, and deliberately not the danger colour: an item waiting on
  // rights is the one outcome that is neither done nor broken.
  deferred: ui.warn,
  failed: ui.danger,
};
