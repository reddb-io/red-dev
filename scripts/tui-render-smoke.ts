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

if (problems.length > 0) {
  console.error("\nRENDER SMOKE FAILED");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log("\nRENDER OK");
