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

/** Dim label above its values, the way the right column reads. */
export function Section(label: string, ...lines: string[]) {
  return Box(
    { flexDirection: "column", marginBottom: 1 },
    Text({ bold: true }, label),
    ...lines.map((l) => Text({ dim: true }, l)),
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
export function Accented(color: string, rows: number, ...children: Parameters<typeof Box>[1][]) {
  return Box(
    { flexDirection: "row" },
    Box(
      { flexDirection: "column" },
      ...Array.from({ length: Math.max(1, rows) }, () => Text({ color }, "│")),
    ),
    Box({ flexDirection: "column", marginLeft: 1 }, ...children),
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
    Text({ color: "red", bold: true }, title),
    Text({ dim: true }, context),
  );
}

/** The bottom edge: hints left, version and cwd right. */
export function StatusLine(left: string, right: string) {
  return Box(
    { flexDirection: "row", justifyContent: "space-between", marginTop: 1 },
    Text({ dim: true }, left),
    Text({ dim: true }, right),
  );
}
