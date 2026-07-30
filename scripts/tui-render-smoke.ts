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

import { Box, ListItem, MultiProgressBar, ProgressBar, Text, renderToString } from "tuiuiu.js";
import { THEMES, themeNames } from "../src/themes.ts";
import { Accented, Header, Screen, Section, StatusLine, Surface } from "../src/tui-chrome.ts";
import { ui } from "../src/tui-theme.ts";

const problems: string[] = [];
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** The truecolor escape a hex lands as, so a colour can be asserted. */
// The SGR parameters only, without the \x1b[ and the m. Bold and a
// background are merged into the same escape as the foreground —
// "\x1b[1;38;2;255;32;86;48;2;7;8;10m" — so matching a whole escape
// sequence reports a colour as absent while it is on the screen.
function bg(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}
function fg(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}

/**
 * Every row carries the screen background.
 *
 * This is the assertion that was missing while the interface ran inside
 * PowerShell's blue: nothing here ever painted a background, so red-dev
 * wore whatever the terminal profile was and none of the palette below
 * the text was ours. Checking the top-left pixel is not enough — the
 * failure looked fine on the rows that had content and blue everywhere
 * else.
 */
function assertPainted(label: string, out: string, expected: string): void {
  const rows = out.split("\n").filter((l) => l.length > 0);
  const unpainted = rows.filter((l) => !l.includes(expected)).length;
  if (unpainted > 0) {
    problems.push(`${label}: ${unpainted}/${rows.length} rows do not carry the screen background`);
  }
}

function paletteOf(slug: string): string[] {
  const t = THEMES[slug];
  if (!t) return [];
  const c = t.terminal;
  return [c.background, c.red, c.green, c.yellow, c.blue, c.purple, c.cyan, c.foreground];
}

// ---------------------------------------------------------------- setup
const active = "kanagawa";
const setup = renderToString(
  Screen(
    100,
    24,
    Header("red-dev setup", "os=windows env=windows"),
    Text({}, ""),
    Box(
      { flexDirection: "row" },
      Box(
        { flexDirection: "column", width: 24 },
        Text({ color: ui.fg2, bold: true }, "Steps"),
        ...["Terminal", "Agents", "Runtimes", "Tools", "ble.sh", "Font", "Theme"].map((s, i) =>
          ListItem({ primary: s, selected: i === 6, status: i < 6 ? "success" : "running" }),
        ),
      ),
      Box(
        { marginLeft: 2 },
        Surface(
          52,
          14,
          Text({ color: ui.accent, bold: true }, "Theme"),
          Text({}, ""),
          Text({ color: ui.fg2 }, "One palette reaches eight surfaces."),
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

// The identity, asserted rather than assumed. Every one of these was
// true of a screen that rendered on PowerShell blue and looked nothing
// like RedDB.
assertPainted("setup", setup, bg(ui.bg0));
if (!setup.includes(bg(ui.bg2))) {
  problems.push("setup: the question column is not on its own shade — bg2 never drawn");
}
if (!setup.includes(fg(ui.accent))) {
  problems.push(`setup: the accent ${ui.accent} appears nowhere — nothing is RedDB red`);
}

// -------------------------------------------------------------- install
const rightWidth = 34;
const rightOuter = rightWidth + 3;
// Rendered at 100 columns, not the 80-column default: the two-column
// layout only activates at 92, so a narrower fixture asserts a layout
// the product never draws — and gave the right column 19 columns where
// it really has 34.
const install = renderToString(
  Screen(
    100,
    24,
    Header("red-dev", "core · zellij"),
    Text({}, ""),
    Box(
      { flexDirection: "row" },
      Box(
        { width: 55 },
        Accented(
          ui.accent,
          8,
          55,
          // Plain Text, matching the product: LogViewer creates signals
          // in its body, so inside a render loop it recreates them every
          // frame and the library prints a warning across the screen.
          ...[
            "-- core · 33 items",
            "✓ ripgrep          installed  2s",
            "✗ docker           failed",
            "    aptrepo: gpg key fetch returned 502",
            "· fd               present",
          ].map((l) => Text(/✗|failed/.test(l) ? { color: ui.danger } : { color: ui.fg1 }, l)),
        ),
      ),
      Box(
        { marginLeft: 2 },
        Surface(
          rightOuter,
          10,
          Text({ color: ui.fg2, bold: true }, "Progress"),
          ProgressBar({ value: 14, max: 33, width: rightWidth - 14, style: "block", color: ui.warn }),
          Text({ color: ui.fg2 }, "14/33  ~2m 30s left"),
          Text({}, ""),
          MultiProgressBar({
            segments: [
              { value: 6, color: ui.ok },
              { value: 7, color: ui.fg3 },
              { value: 1, color: ui.danger },
            ],
            total: 33,
            width: rightWidth - 6,
            showLegend: false,
          }),
          Text({}, ""),
          // The accented line is the point of this column: one number
          // carries the answer and the rest is context.
          Section("Changed", { text: "6 installed", color: ui.accent, bold: true }, "7 already present", "1 skipped"),
          Section("Elapsed", { text: "1m 12s", color: ui.fg0 }),
          Text({ color: ui.danger, bold: true }, "Failed"),
          ListItem({ primary: "docker", status: "error" }),
          Text({}, ""),
          Section("Incomplete", "Fix the cause and re-run;", "it resumes from here."),
        ),
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
if (!plain.includes("Changed")) problems.push("decisions section missing");
if (/[╭╮╰╯]/.test(install)) problems.push("install view is drawing a border");

assertPainted("install", install, bg(ui.bg0));
if (!install.includes(bg(ui.bg2))) {
  problems.push("install: the status column is not on its own shade — bg2 never drawn");
}
// The one number that carries the decision has to be in the accent, or
// the column is the wall of grey this layout was meant to replace.
if (!install.includes(fg(ui.accent))) {
  problems.push("install: nothing is drawn in the accent — no line carries the decision");
}
// Overflow does not clip here, it overwrites — so a column whose content
// outgrows its box comes out as two lines spliced into one. Assert on
// the shape rather than on any one string.
for (const line of install.split("\n")) {
  if (/[a-z]\.[a-z]{2,}[;,]/.test(strip(line))) {
    problems.push(`install: two lines rendered on top of each other: ${strip(line).trim()}`);
    break;
  }
}

// Clipping inside a column is invisible to the total-width check: the
// line fits the terminal, the words do not fit their panel. These are
// the strings the right column has to hold whole.
for (const s of ["Incomplete", "Fix the cause and re-run;", "6 installed", "Elapsed"]) {
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
