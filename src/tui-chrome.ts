/**
 * The shared visual language.
 *
 * Modelled on OpenCode's, after seeing the two side by side. The
 * difference is not decoration, it is what does the separating: my
 * version drew a rounded border around every region, which fills the
 * screen with lines that carry no information and make a 30-row
 * terminal feel cramped. OpenCode separates with whitespace and
 * typography — a bold label over dim values, an accent bar on the one
 * thing that has focus, a status line at the very bottom edge.
 *
 * So: no boxes. Anything that needs to stand out does it with weight or
 * colour, and anything that needs to be apart is apart because of a
 * blank line.
 */

import { Box, Text } from "tuiuiu.js";
import { muted, subtle, text, ui } from "./tui-theme.ts";

/**
 * The screen itself, painted rather than assumed.
 *
 * Every colour in this interface was chosen against black, and then the
 * black was never drawn — so on a terminal with its own background the
 * whole identity is whatever the user's profile decided. The default
 * Windows PowerShell profile is #012456, and red-dev ran inside a blue
 * rectangle with grey text on it.
 *
 * All three of these are load-bearing. A Box with only a backgroundColor
 * paints the rect its content happens to occupy, which is a few
 * characters wide; the explicit width and height are what make the fill
 * reach the edges and the empty rows below the content.
 */
export function Screen(width: number, height: number, ...children: Parameters<typeof Box>[1][]) {
  return Box(
    {
      flexDirection: "column",
      padding: 1,
      width,
      height,
      backgroundColor: ui.bg0,
    },
    ...children,
  );
}

export interface CenteredFrame {
  width: number;
  height: number;
}

/** Size of a composed card inside Screen's one-cell outer padding. */
export function centeredFrame(
  viewportWidth: number,
  viewportHeight: number,
  maxWidth: number,
  maxHeight: number,
): CenteredFrame {
  return {
    width: Math.max(1, Math.min(maxWidth, viewportWidth - 2)),
    height: Math.max(1, Math.min(maxHeight, viewportHeight - 2)),
  };
}

/**
 * A bounded, horizontally and vertically centred application surface.
 *
 * Omarchy Quattro's provisioner measures the live console and composes its
 * logo/form in the middle instead of starting at row one. The reactive TUI
 * already redraws when geometry changes; this is the corresponding layout
 * primitive, keeping a large Ubuntu terminal from stretching the installer
 * across the whole display while still consuming every cell on a small one.
 */
export function CenteredScreen(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
  ...children: Parameters<typeof Box>[1][]
) {
  const frame = centeredFrame(width, height, maxWidth, maxHeight);
  return Screen(
    width,
    height,
    Box(
      {
        flexDirection: "column",
        width: Math.max(1, width - 2),
        height: Math.max(1, height - 2),
        alignItems: "center",
        justifyContent: "center",
      },
      Box(
        { flexDirection: "column", width: frame.width, height: frame.height },
        ...children,
      ),
    ),
  );
}

/**
 * One step up from the screen: the column that holds decisions.
 *
 * OpenCode separates its sidebar from its main region by a shade rather
 * than a border, which is what lets the log stay the brightest thing on
 * screen while the status column is still clearly its own surface. bg2
 * over bg0 is a small difference deliberately — two steps read as a
 * dialog floating over the app rather than part of it.
 *
 * minHeight, not height, and that distinction is the whole reason this
 * takes a number at all. A fixed height shorter than its content does
 * not clip it, it draws the overflow on top of what is already there:
 * "it resumes from here." and "…and re-run;" came out of one render as
 * "it resumes from here.run;". A minimum still paints the empty rows
 * below short content — which is the point — without corrupting the
 * screen on a terminal too short for the column.
 */
export function Surface(width: number, rows: number, ...children: Parameters<typeof Box>[1][]) {
  return Box(
    {
      flexDirection: "column",
      width,
      minHeight: rows,
      paddingLeft: 2,
      paddingRight: 1,
      paddingTop: 1,
      backgroundColor: ui.bg2,
    },
    ...children,
  );
}

/**
 * A labelled block in the right column.
 *
 * The column reads as a record of what was decided and what it cost, so
 * a value that carries a decision can be highlighted while the ones
 * that are merely context stay quiet. `accent` on a line is what marks
 * "this is the answer", not "this is important" — everything in a
 * status column looks important, which is why the distinction has to be
 * made by colour rather than by weight.
 */
export function Section(
  label: string,
  ...lines: (string | { text: string; color?: string; bold?: boolean })[]
) {
  return Box(
    { flexDirection: "column", marginBottom: 1 },
    Text({ color: muted, bold: true }, label),
    ...lines.map((l) =>
      typeof l === "string"
        ? Text({ color: subtle }, l)
        : Text({ color: l.color ?? text, ...(l.bold ? { bold: true } : {}) }, l.text),
    ),
  );
}

/** A decision and its answer, on one line, with the answer standing out. */
export function Decision(label: string, value: string, color: string = ui.accent) {
  return Box(
    { flexDirection: "row" },
    Text({ color: subtle }, `${label.padEnd(11)}`),
    Text({ color }, value),
  );
}

/**
 * A left accent bar instead of a border.
 *
 * One column of colour marks the focused region; a full frame would cost
 * four lines of terminal and say the same thing.
 *
 * `rows` is required because the bar has to be as tall as what it marks.
 * The first version emitted a single `│` and left the rest of the block
 * unmarked, which reads as a stray character rather than an edge.
 */
export function Accented(
  color: string,
  rows: number,
  width: number,
  ...children: Parameters<typeof Box>[1][]
) {
  return Box(
    { flexDirection: "row" },
    // flexShrink: 0 and an explicit width on both sides, neither of
    // which is decoration.
    //
    // On tuiuiu 1.0.64 a bare column of bars beside auto-width content
    // worked. On 1.0.74 a ListItem or LogViewer child expands to fill
    // and the bar column collapses to nothing — the bars simply stop
    // being drawn, silently, with the text shifted one column left.
    // Pinning the bar at 1 and giving the content the remaining width
    // keeps the child from taking the column it does not own.
    Box(
      { flexDirection: "column", width: 1, flexShrink: 0 },
      ...Array.from({ length: Math.max(1, rows) }, () => Text({ color }, "│")),
    ),
    Box({ flexDirection: "column", width: Math.max(1, width - 2), marginLeft: 1 }, ...children),
  );
}

/**
 * One command's output, inside the interface rather than after it.
 *
 * Picking a theme used to leave the fullscreen, apply it, and print six
 * lines to the console you had just been taken out of — which reads as
 * the application quitting on you, because that is what it did. The
 * converge moved inside first and made the inconsistency louder: one
 * choice kept you, the others threw you out.
 */
export function Task(
  title: string,
  lines: string[],
  rows: number,
  width: number,
  done: boolean,
  accent: string = ui.accent,
) {
  // Truncated, not wrapped. The accent bar is one glyph per row, so a
  // line that wraps produces content the bar does not reach and the edge
  // stops lining up — a backup path with a long directory in it was
  // enough to bend it.
  const room = Math.max(8, width - 4);
  const fit = (l: string): string => (l.length > room ? `${l.slice(0, room - 1)}…` : l);
  const visible = lines.slice(-rows);
  return Box(
    { flexDirection: "column" },
    Text({ color: muted, bold: true }, title),
    Text({}, ""),
    Accented(
      done ? ui.ok : accent,
      Math.max(1, rows),
      width,
      ...visible.map((l) => Text({ color: text }, fit(l))),
      // Held open at full height so the block does not grow line by
      // line and push the hint around underneath it.
      ...Array.from({ length: Math.max(0, rows - visible.length) }, () => Text({}, "")),
    ),
  );
}

/**
 * Title on the left, context on the right, nothing between them.
 *
 * justifyContent does the work a border would otherwise be asked to do.
 */
export function Header(title: string, context: string) {
  return Box(
    { flexDirection: "row", justifyContent: "space-between" },
    Text({ color: ui.accent, bold: true }, title),
    Text({ color: subtle }, context),
  );
}

/** The bottom edge: hints left, version and cwd right. */
export function StatusLine(left: string, right: string) {
  return Box(
    { flexDirection: "row", justifyContent: "space-between", marginTop: 1 },
    Text({ color: subtle }, left),
    Text({ color: subtle }, right),
  );
}
