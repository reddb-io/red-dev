/**
 * The log has to be readable while it is being written to.
 *
 * There was never a scroll bug to fix: LogViewer registers no key
 * handling of its own — ScrollArea does, LogViewer does not — so nothing
 * could move the view, and autoScroll pinned it to the tail on every one
 * of thirty frames a second regardless. These check the two halves that
 * make it work: that an external state can hold a position, and that
 * autoScroll is what overrides it.
 */

import { describe, expect, test } from "bun:test";
import { LogViewer, createScrollArea, renderToString } from "tuiuiu.js";
import { handleInstallScroll } from "./tui-install.ts";

const LINES = Array.from({ length: 40 }, (_, i) => `linha ${i}`);
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("the converge log", () => {
  test("the install key handler moves up and pauses tail-following", () => {
    const state = createScrollArea({ height: 5, content: LINES, autoScroll: false });
    state.scrollToBottom();
    const before = state.scrollTop();
    let following = true;

    const handled = handleInstallScroll(state, (value) => (following = value), "", {
      upArrow: true,
    });

    expect(handled).toBe(true);
    expect(state.scrollTop()).toBeLessThan(before);
    expect(following).toBe(false);
  });

  test("G returns to the tail and resumes following", () => {
    const state = createScrollArea({ height: 5, content: LINES, autoScroll: false });
    state.scrollToTop();
    let following = false;

    expect(handleInstallScroll(state, (value) => (following = value), "G", {})).toBe(true);
    expect(state.scrollTop()).toBe(state.maxScroll());
    expect(following).toBe(true);
  });

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
});
