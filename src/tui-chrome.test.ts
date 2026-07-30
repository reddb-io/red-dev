/**
 * The identity, checked against the product rather than a copy of it.
 *
 * scripts/tui-render-smoke.ts renders a fixture that reassembles the
 * layout by hand, which is the arrangement that once let it pass for two
 * releases against a component the product had already deleted. So the
 * structural half is asserted here, on the real source: whatever the
 * fixture proves about the helpers, these prove the views actually use
 * them.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Text, renderToString } from "tuiuiu.js";
import { Screen, Surface } from "./tui-chrome.ts";
import { ui } from "./tui-theme.ts";

const VIEWS = ["src/tui.ts", "src/tui-setup.ts", "src/tui-install.ts"] as const;
const sourceOf = (p: string): string => readFileSync(p, "utf8");

/** SGR parameters, not the whole escape: bold and a background merge in. */
const sgrBg = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  return `48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};

describe("every fullscreen view", () => {
  for (const view of VIEWS) {
    test(`${view} paints the screen instead of inheriting the terminal`, () => {
      // The bug this replaces: all three returned a bare Box, so the
      // background was whatever the user's profile was — #012456 on a
      // default Windows PowerShell.
      expect(sourceOf(view)).toContain("return Screen(");
    });

    test(`${view} draws no borders`, () => {
      const src = sourceOf(view);
      // Panel and AlertBox both draw a rounded frame. Matched as calls
      // so the prose explaining why they were removed does not count.
      expect(src).not.toMatch(/[^A-Za-z](Panel|AlertBox)\(\s*\{/);
    });

    test(`${view} names its greys instead of asking the terminal to dim`, () => {
      // `dim` leaves the foreground to the terminal and asks it to
      // darken whatever that was, which lands between our palette and
      // the user's.
      expect(sourceOf(view)).not.toContain("dim: true");
    });
  }
});

describe("Screen", () => {
  test("carries the background on every row, not just where content is", () => {
    const out = renderToString(Screen(40, 8, /* one short line */ ...[]), 40);
    const rows = out.split("\n").filter((l) => l.length > 0);
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row).toContain(sgrBg(ui.bg0));
  });
});

describe("Surface", () => {
  test("grows past its minimum rather than drawing over its own content", () => {
    // A fixed height shorter than the content does not clip, it
    // overwrites: two lines came out of one render spliced together as
    // "it resumes from here.run;".
    const lines = ["first line here", "second line here", "third line here"];
    const out = renderToString(Surface(30, 1, ...lines.map((l) => Text({}, l))), 40);
    const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
    for (const line of lines) expect(plain).toContain(line);
    // Spliced output is the failure mode, so check the lines are also
    // still separate.
    expect(plain.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(3);
  });
});
