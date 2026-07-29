#!/usr/bin/env bun
/**
 * Renders the fullscreen layout once and asserts what came out.
 *
 * An interactive session cannot be driven from here, but the part most
 * likely to be wrong is not the key handling — it is whether the layout
 * composes at all, whether the palette strip carries real colours, and
 * whether the panel text survives the width calculation. All three are
 * visible in one frame.
 */

import { Box, Text, renderToString } from "tuiuiu.js";
import { THEMES, themeNames } from "../src/themes.ts";

function Swatches(hexes: string[]) {
  return Box({ flexDirection: "row" }, ...hexes.map((h) => Text({ backgroundColor: h }, "    ")));
}

function paletteOf(slug: string): string[] {
  const t = THEMES[slug];
  if (!t) return [];
  const c = t.terminal;
  return [c.background, c.red, c.green, c.yellow, c.blue, c.purple, c.cyan, c.foreground];
}

const active = "kanagawa";

const frame = renderToString(
  Box(
    { flexDirection: "column", padding: 1 },
    Box(
      { flexDirection: "row", justifyContent: "space-between", marginBottom: 1 },
      Text({ color: "red", bold: true }, "red-dev"),
      Text({ dim: true }, "os=linux env=wsl"),
    ),
    Box(
      { flexDirection: "row" },
      Box(
        { flexDirection: "column", width: 24, borderStyle: "round", padding: 1 },
        Text({ dim: true }, "THEME"),
        ...themeNames().map((n) =>
          Text({ color: n === active ? "red" : undefined, bold: n === active }, `${n === active ? "❯ " : "  "}${n}`),
        ),
      ),
      Box(
        { flexDirection: "column", width: 44, borderStyle: "round", padding: 1, marginLeft: 1 },
        Text({ bold: true }, THEMES[active]?.name ?? active),
        Text({}, ""),
        Swatches(paletteOf(active)),
        Text({}, ""),
        Text({ dim: true }, "background · red · green · yellow"),
      ),
    ),
  ),
);

console.log(frame);

const problems: string[] = [];

// Every theme has to appear in the list, or the selector is lying about
// what is available.
for (const name of themeNames()) {
  if (!frame.includes(name)) problems.push(`missing theme in list: ${name}`);
}

// The swatch row is the entire point. Without a background escape
// sequence it rendered as blank space and nobody would know.
if (!/\x1b\[48;2;\d+;\d+;\d+m/.test(frame)) {
  problems.push("no truecolor background escapes — swatches did not render as colour");
}

// The kanagawa background is #1F1F28 = 31,31,40.
if (!frame.includes("\x1b[48;2;31;31;40m")) {
  problems.push("kanagawa background swatch missing its actual colour");
}

if (!frame.includes("Kanagawa")) problems.push("panel title missing");
if (!frame.includes("❯ kanagawa")) problems.push("selection marker missing");


// --- the install timeline -------------------------------------------
// The progress view is the other reason for a fullscreen mode, and its
// bar is the piece most likely to break silently: an off-by-one in the
// fill maths renders as an empty or overflowing row, not an error.
function Bar(done: number, total: number, width: number) {
  const filled = total === 0 ? 0 : Math.round((done / total) * width);
  return Box(
    { flexDirection: "row" },
    Text({ color: "red" }, "\u2588".repeat(Math.max(0, filled))),
    Text({ dim: true }, "\u2591".repeat(Math.max(0, width - filled))),
  );
}

const progress = renderToString(
  Box(
    { flexDirection: "column", padding: 1 },
    Box({ flexDirection: "row" }, Bar(14, 33, 30), Text({ dim: true }, "  14/33  \u00b7  1m 12s")),
    Box(
      { flexDirection: "column", borderStyle: "round", padding: 1 },
      Box({ flexDirection: "row" }, Text({ color: "green" }, "\u2713 "), Text({}, "ripgrep".padEnd(16)), Text({ dim: true }, "installed")),
      Box({ flexDirection: "row" }, Text({ color: "red" }, "\u2717 "), Text({}, "docker".padEnd(16)), Text({ dim: true }, "failed")),
      Box({ flexDirection: "row" }, Text({ color: "yellow" }, "\u25b8 "), Text({ bold: true }, "zellij".padEnd(16)), Text({ dim: true }, "gh:zellij-org")),
    ),
  ),
);

console.log(progress);

// 14 of 33 over 30 cells is 13 filled. A bar that is all-empty or
// all-full means the maths broke, and both look plausible in isolation.
const filledCount = (progress.match(/\u2588/g) ?? []).length;
if (filledCount !== 13) problems.push(`progress bar filled ${filledCount} cells, expected 13`);
if (!(progress.match(/\u2591/g) ?? []).length) problems.push("progress bar has no empty portion");
if (!progress.includes("14/33")) problems.push("counter missing");
// Glyph and name are separate Text nodes, so an ANSI reset sits between
// them: asserting on the raw frame tests the renderer's escape placement
// rather than the content. Strip colour first and check what a human
// actually reads.
const plain = progress.replace(/\x1b\[[0-9;]*m/g, "");
if (!plain.includes("\u2713 ripgrep")) problems.push("completed step marker missing");
if (!plain.includes("\u2717 docker")) problems.push("failed step marker missing");
if (!plain.includes("\u25b8 zellij")) problems.push("running step marker missing");
if (problems.length > 0) {
  console.error("\nRENDER SMOKE FAILED");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log("\nRENDER OK");
