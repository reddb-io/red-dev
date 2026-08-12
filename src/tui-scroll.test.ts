/**
 * The log has to be readable while it is being written to.
 *
 * LogViewer can display an externally moved position, but it registers
 * neither keyboard nor wheel handling. The live pane uses ScrollArea so
 * the component that draws the viewport also owns its input. These tests
 * cross the real renderer boundary: raw terminal sequences must move the
 * same external state the frame reads.
 */

import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { LogViewer, createScrollArea, render, renderToString } from "tuiuiu.js";
import { InstallLayout, type InstallModel } from "./tui-install.ts";

const LINES = Array.from({ length: 40 }, (_, i) => `linha ${i}`);
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function interactiveLog() {
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream;
  Object.assign(stdin, {
    isTTY: true,
    isRaw: false,
    setRawMode: () => stdin,
  });
  Object.assign(stdout, { isTTY: true, columns: 96, rows: 30 });

  const state = createScrollArea({ height: 5, content: LINES, autoScroll: true });
  state.scrollToBottom();
  const model = {
    lines: () => LINES,
    results: () => [],
    setupResults: () => [],
    setupTotal: () => 0,
    current: () => "git",
    scope: () => "desktop",
    finished: () => false,
    following: () => false,
    followScroll: () => {},
    elapsedMs: () => 1000,
    total: 40,
    logScroll: state,
    prelude: () => {},
    setupBegin: () => {},
    setupStepStart: () => {},
    setupStepEnd: () => {},
    begin: () => {},
    note: () => {},
  } as unknown as InstallModel;

  const app = render(() => InstallLayout(model, 96, 30), {
    stdin,
    stdout,
    fullHeight: true,
  });
  return { app, stdin, state };
}

describe("the converge log", () => {
  test("an external scroll state decides what is shown", () => {
    const state = createScrollArea({ height: 5, content: LINES, autoScroll: false });
    state.scrollToTop();
    const out = strip(renderToString(LogViewer({ lines: LINES, height: 5, autoScroll: false, state }), 40));
    expect(out).toContain("linha 0");
    expect(out).not.toContain("linha 39");
  });

  test("scrollBy moves it, and the render follows", () => {
    const state = createScrollArea({ height: 5, content: LINES, autoScroll: false });
    state.scrollToTop();
    state.scrollBy(10);
    const out = strip(renderToString(LogViewer({ lines: LINES, height: 5, autoScroll: false, state }), 40));
    expect(out).toContain("linha 10");
    expect(out).not.toContain("linha 0\n");
  });

  test("autoScroll pins to the tail — which is why it must be conditional", () => {
    const state = createScrollArea({ height: 5, content: LINES, autoScroll: false });
    state.scrollToTop();
    // The bug, reproduced: asking to follow the tail discards the
    // position that was just set, on every frame.
    const out = strip(renderToString(LogViewer({ lines: LINES, height: 5, autoScroll: true, state }), 40));
    expect(out).toContain("linha 39");
    expect(out).not.toContain("linha 0");
  });

  test("paging and the bottom edge agree on where the end is", () => {
    const state = createScrollArea({ height: 5, content: LINES, autoScroll: false });
    state.scrollToBottom();
    expect(state.scrollTop()).toBe(state.maxScroll());
    state.pageUp();
    expect(state.scrollTop()).toBeLessThan(state.maxScroll());
    state.pageDown();
    // Back at the bottom is what re-arms following in tui-install.
    expect(state.scrollTop()).toBe(state.maxScroll());
  });

  test("the rendered log receives arrow and page keys", async () => {
    const { app, stdin, state } = interactiveLog();
    try {
      const bottom = state.scrollTop();
      stdin.write("\x1b[A");
      await Bun.sleep(40);
      expect(state.scrollTop()).toBeLessThan(bottom);

      const afterArrow = state.scrollTop();
      stdin.write("\x1b[5~");
      await Bun.sleep(40);
      expect(state.scrollTop()).toBeLessThan(afterArrow);
    } finally {
      app.unmount();
    }
  });

  test("the rendered log receives the mouse wheel inside its bounds", async () => {
    const { app, stdin, state } = interactiveLog();
    try {
      const bottom = state.scrollTop();
      // SGR mouse: wheel-up at column 5, row 6 (one-based).
      stdin.write("\x1b[<64;5;6M");
      await Bun.sleep(40);
      expect(state.scrollTop()).toBeLessThan(bottom);
    } finally {
      app.unmount();
    }
  });
});
