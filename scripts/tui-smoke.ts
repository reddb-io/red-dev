/**
 * Smoke test: does tuiuiu.js survive `bun build --compile`?
 *
 * A TUI library that works under `bun run` but not inside a standalone
 * binary would quietly invalidate the whole distribution model, so this
 * is checked before anything is built on top of it. renderToString
 * needs no TTY, which makes it runnable in CI and in tool calls.
 */

import { Box, Text, renderToString } from "tuiuiu.js";

const view = Box(
  { flexDirection: "column", padding: 1, borderStyle: "round" },
  Text({ color: "cyan", bold: true }, "red-dev"),
  Text({}, "one environment, five targets"),
);

const out = renderToString(view);
console.log(out);
console.log("SMOKE OK");
