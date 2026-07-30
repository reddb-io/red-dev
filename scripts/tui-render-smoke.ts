#!/usr/bin/env bun
/**
 * Renders each fullscreen surface once and asserts what came out.
 *
 * An interactive session cannot be driven from here, but the parts most
 * likely to be wrong are visible in one frame: whether the layout
 * composes, whether the palette strip carries real colours, whether a
 * component's own chrome overflows the column it was given. The last one
 * is what a screenshot caught after this file had been passing for two
 * releases against a function the product had deleted.
 */

import { Box, ListItem, LogViewer, MultiProgressBar, ProgressBar, Text, renderToString } from "tuiuiu.js";
import { THEMES, themeNames } from "../src/themes.ts";
import { Accented, Header, Section, StatusLine } from "../src/tui-chrome.ts";

const problems: string[] = [];
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function paletteOf(slug: string): string[] {
  const t = THEMES[slug];
  if (!t) return [];
  const c = t.terminal;
  return [c.background, c.red, c.green, c.yellow, c.blue, c.purple, c.cyan, c.foreground];
}

// ---------------------------------------------------------------- setup
const active = "kanagawa";
const setup = renderToString(
  Box(
    { flexDirection: "column", padding: 1 },
    Header("red-dev setup", "os=windows env=windows"),
    Text({}, ""),
    Box(
      { flexDirection: "row" },
      Box(
        { flexDirection: "column", width: 24 },
        Text({ bold: true }, "Steps"),
        ...["Terminal", "Agents", "Runtimes", "Tools", "ble.sh", "Font", "Theme"].map((s, i) =>
          ListItem({ primary: s, selected: i === 6, status: i < 6 ? "success" : "running" }),
        ),
      ),
      Box(
        { flexDirection: "column", width: 52, marginLeft: 2 },
        Accented(
          "red",
          9,
          52,
          Text({ dim: true }, "One palette reaches eight surfaces."),
          Text({}, ""),
          ...themeNames()
            .slice(2, 6)
            .map((n, i) => ListItem({ primary: THEMES[n]?.name ?? n, selected: i === 2 })),
          Text({}, ""),
          Box({ flexDirection: "row" }, ...paletteOf(active).map((h) => Text({ backgroundColor: h }, "    "))),
        ),
      ),
    ),
    StatusLine("up/down move · enter next · q skip", "red-dev 0.7.0"),
  ),
  100,
);

console.log(setup);

for (const name of themeNames().slice(2, 6)) {
  const label = THEMES[name]?.name ?? name;
  if (!strip(setup).includes(label)) problems.push(`theme missing from setup list: ${label}`);
}
// The swatches are the reason this screen exists; without a background
// escape they render as blank space and nobody would notice.
if (!/\x1b\[48;2;\d+;\d+;\d+m/.test(setup)) {
  problems.push("no truecolor background escapes — swatches did not render as colour");
}
if (!setup.includes("\x1b[48;2;31;31;40m")) {
  problems.push("kanagawa background swatch missing its actual colour (#1F1F28)");
}
// No boxes: the whole point of the restyle. A round border here means a
// Panel crept back in.
if (/[╭╮╰╯]/.test(setup)) problems.push("a rounded border is being drawn — regions should separate by whitespace");
if (!setup.includes("│")) problems.push("accent bar missing — nothing marks the focused region");

// -------------------------------------------------------------- install
const rightWidth = 34;
// Rendered at 100 columns, not the 80-column default: the two-column
// layout only activates at 92, so a narrower fixture asserts a layout
// the product never draws — and gave the right column 19 columns where
// it really has 34.
const install = renderToString(
  Box(
    { flexDirection: "column", padding: 1 },
    Header("red-dev", "core · zellij"),
    Text({}, ""),
    Box(
      { flexDirection: "row" },
      Box(
        { width: 58 },
        Accented(
          "red",
          8,
          58,
          LogViewer({
            lines: [
              "-- core · 33 items",
              "✓ ripgrep          installed  2s",
              "✗ docker           failed",
              "    aptrepo: gpg key fetch returned 502",
              "· fd               present",
            ],
            height: 8,
            autoScroll: true,
            highlightPattern: /(✗|failed)/,
            highlightColor: "red",
          }),
        ),
      ),
      Box(
        { flexDirection: "column", width: rightWidth, marginLeft: 2 },
        Text({ bold: true }, "Progress"),
        ProgressBar({ value: 14, max: 33, width: rightWidth - 14, style: "block", color: "yellow" }),
        Text({ dim: true }, "14/33  ~2m 30s left"),
        Text({}, ""),
        MultiProgressBar({
          segments: [
            { value: 6, color: "green" },
            { value: 7, color: "gray" },
            { value: 1, color: "red" },
          ],
          total: 33,
          width: rightWidth - 6,
          showLegend: false,
        }),
        Text({}, ""),
        Section("Counts", "installed  6", "present    7", "skipped    1"),
        Section("Elapsed", "1m 12s"),
        Text({ color: "red", bold: true }, "Failed"),
        ListItem({ primary: "docker", status: "error" }),
        Text({}, ""),
        Section("Incomplete", "Fix the cause and re-run;", "it resumes from here."),
      ),
    ),
    StatusLine("working…", "red-dev 0.7.0"),
  ),
  100,
);

console.log(install);

const plain = strip(install);
// Every line has to fit the terminal: a component drawing its own
// brackets and percentage outside the width it was given is what put
// "100" on a line of its own and truncated a legend to "faile".
const widest = Math.max(...plain.split("\n").map((l) => l.length));
if (widest > 100) problems.push(`a line is ${widest} columns wide — something overflowed its column`);

if (!plain.includes("14/33")) problems.push("counter missing");
if (!plain.includes("✓ ripgrep")) problems.push("completed step marker missing");
if (!plain.includes("✗ docker")) problems.push("failed step marker missing");
if (!plain.includes("Counts")) problems.push("counts section missing");
if (/[╭╮╰╯]/.test(install)) problems.push("install view is drawing a border");

// Clipping inside a column is invisible to the total-width check: the
// line fits the terminal, the words do not fit their panel. These are
// the strings the right column has to hold whole.
for (const s of ["Incomplete", "Fix the cause and re-run;", "installed", "Elapsed"]) {
  if (!plain.includes(s)) problems.push(`right column truncated: "${s}" is cut`);
}

if (problems.length > 0) {
  console.error("\nRENDER SMOKE FAILED");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log("\nRENDER OK");

// Explicit exit: the components register effects that keep the event
// loop alive after a one-shot renderToString, so without this the
// script prints everything, passes, and then hangs until CI kills it.
process.exit(0);
