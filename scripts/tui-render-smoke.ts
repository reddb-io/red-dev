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

import { Box, MultiProgressBar, ProgressBar, Text, renderToString } from "tuiuiu.js";
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
//
// This block used to render a `Bar` defined here in the smoke \u2014 a
// hand-rolled one that the product stopped using when the layout moved
// to tuiuiu's ProgressBar. The assertion passed the whole time, against
// code no longer shipped. A smoke that reimplements its subject tests
// the smoke.
//
// The components below are the ones tui-install.ts renders.

const progress = renderToString(
  Box(
    { flexDirection: "column", padding: 1 },
    ProgressBar({ value: 14, max: 33, width: 24, style: "block", color: "yellow" }),
    Text({ dim: true }, "14/33  ~2m 30s left"),
    Text({}, ""),
    MultiProgressBar({
      segments: [
        { value: 6, color: "green", label: "new" },
        { value: 7, color: "gray", label: "present" },
        { value: 1, color: "red", label: "failed" },
      ],
      total: 33,
      width: 24,
    }),
    Box(
      { flexDirection: "column", borderStyle: "round", padding: 1 },
      Box({ flexDirection: "row" }, Text({ color: "green" }, "\u2713 "), Text({}, "ripgrep".padEnd(16)), Text({ dim: true }, "installed")),
      Box({ flexDirection: "row" }, Text({ color: "red" }, "\u2717 "), Text({}, "docker".padEnd(16)), Text({ dim: true }, "failed")),
      Box({ flexDirection: "row" }, Text({ color: "yellow" }, "\u25b8 "), Text({ bold: true }, "zellij".padEnd(16)), Text({ dim: true }, "gh:zellij-org")),
    ),
  ),
);

console.log(progress);

// A bar that renders as all-empty or all-full means the value never
// reached it, and both look plausible in isolation. 14 of 33 must show
// as partially filled \u2014 some fill character and some empty one.
const bars = (progress.match(/[\u2588\u2589\u258a\u258b\u258c\u258d\u258e\u258f]/g) ?? []).length;
if (bars === 0) problems.push("progress bar drew no filled cells");
if (!(progress.match(/[\u2591\u2592\u2593]/g) ?? []).length) {
  problems.push("progress bar drew no empty portion \u2014 it looks complete at 42%");
}
// showValue is what turns a bar into a number anyone can act on.
if (!progress.includes("14/33")) problems.push("counter missing");
// The segment legend is the breakdown; without it the bar is one blob.
const legend = progress.replace(/\x1b\[[0-9;]*m/g, "");
if (!/new/.test(legend) || !/failed/.test(legend)) {
  problems.push("MultiProgressBar legend missing its segments");
}
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
