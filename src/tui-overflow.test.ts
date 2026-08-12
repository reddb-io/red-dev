/**
 * A log line wider than its column must not wrap.
 *
 * LogViewer draws each line with a plain Text, and Text wraps. In a
 * two-column frame that costs a row the layout budgeted for something
 * else, and it breaks a path across two rows mid-segment — so a converge
 * full of Windows paths produces a log you cannot read down and a right
 * column starting one row lower than it should. A 96-column PowerShell
 * window is where this was noticed.
 *
 * Rendered rather than reasoned about, and rendered through the real
 * scroll area. The first version of this test built a stub whose
 * visibleItems() returned the lines it was given, which meant it never
 * exercised the truncation at all: it passed identically with the fix
 * and without it.
 */

import { describe, expect, test } from "bun:test";
import { createScrollArea, renderToString } from "tuiuiu.js";
import { fitToWidth, InstallLayout, type InstallModel } from "./tui-install.ts";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** The window in the screenshot that reported this. */
const WIDTH = 96;
const HEIGHT = 30;

/** Both real, both off that screenshot. */
const LONG = [
  "ok  dotfiles: 2 file(s) written to C:/Users/filip/.local/share/red-dev/config/bash",
  "skip alacritty.toml exists — theme and font updated, yours left alone",
];

function frame(lines: string[]): string[] {
  const model = {
    lines: () => lines,
    results: () => [],
    setupResults: () => [],
    setupTotal: () => 0,
    current: () => "dotfiles",
    scope: () => "core",
    finished: () => false,
    following: () => true,
    followScroll: () => {},
    elapsedMs: () => 8000,
    total: 39,
    logScroll: createScrollArea({
      height: 10,
      content: [],
      autoScroll: true,
      isActive: true,
    }),
    begin: () => {},
    note: () => {},
  } as unknown as InstallModel;

  return strip(renderToString(InstallLayout(model, WIDTH, HEIGHT), WIDTH, HEIGHT)).split("\n");
}

/**
 * Rows carrying log text.
 *
 * The accent bar is drawn on every row of the region, and the status
 * column's own text sits to the right of it on the same rows, so
 * "contains a bar followed by something" counts eleven rows for two
 * lines. Only the columns between the bar and the status column belong
 * to the log, so only those are looked at.
 */
function logRows(rows: string[]): string[] {
  const LOG_COLUMNS = 50;
  return rows.filter((r) => {
    const bar = r.indexOf("│");
    if (bar < 0) return false;
    return r.slice(bar + 1, bar + 1 + LOG_COLUMNS).trim() !== "";
  });
}

describe("a log line wider than its column", () => {
  test("takes one row per line, not two", () => {
    // The measurement that matters: two lines wrapped into four rows,
    // and every row after them sat one lower than the layout intended.
    expect(logRows(frame(LONG))).toHaveLength(LONG.length);
  });

  test("never starts a row with the tail of the line above", () => {
    // What a wrap looks like from the reader's side: a row beginning
    // with half a path and no indication of which line it belongs to.
    const rows = frame(LONG);
    expect(rows.some((r) => /│\s+C:\/Users/.test(r))).toBe(false);
    expect(rows.some((r) => /│\s+updated, yours/.test(r))).toBe(false);
  });

  test("says it cut, rather than looking like the whole path", () => {
    expect(frame(LONG).some((r) => r.includes("…"))).toBe(true);
  });

  test("keeps the front of the line, which is the part that says what happened", () => {
    expect(frame(LONG).some((r) => r.includes("ok  dotfiles: 2 file(s) written to"))).toBe(
      true,
    );
  });

  test("leaves a line that already fits alone", () => {
    const short = ["ok  git", "ok  curl"];
    const rows = frame(short);
    expect(logRows(rows)).toHaveLength(2);
    // The log column specifically: the status column has its own
    // truncation and an ellipsis there says nothing about this.
    expect(logRows(rows).some((r) => r.slice(0, r.indexOf("│") + 51).includes("…"))).toBe(
      false,
    );
  });
});

describe("the transition from a full viewport to a scrollbar", () => {
  test("does not turn one logical line into two physical rows", () => {
    // At WIDTH=96 the log text receives 50 columns before overflow. The
    // scrollbar adds both a margin and a glyph when line 23 arrives; if
    // only one of those columns is reserved, every 50-column line wraps.
    const edge = Array.from(
      { length: 23 },
      (_, index) => `L${String(index).padStart(2, "0")} ${"x".repeat(46)}`,
    );
    const visibleLabels = frame(edge).flatMap((row) => row.match(/L\d\d/g) ?? []);

    // logRows is 22, so following the tail must show L01 through L22.
    expect(visibleLabels).toEqual(
      Array.from({ length: 22 }, (_, index) => `L${String(index + 1).padStart(2, "0")}`),
    );
  });
});

describe("fitToWidth", () => {
  test("leaves a line that fits", () => {
    expect(fitToWidth("short", 20)).toBe("short");
  });

  test("marks the cut", () => {
    expect(fitToWidth("abcdefghij", 5)).toBe("abcd…");
    expect(fitToWidth("abcdefghij", 5)).toHaveLength(5);
  });

  test("does not fall over at an absurd width", () => {
    // Terminals report 0 and 1 while a window is being dragged.
    expect(fitToWidth("abc", 1)).toBe("");
    expect(fitToWidth("abc", 0)).toBe("");
  });
});
