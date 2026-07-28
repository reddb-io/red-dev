/**
 * Interactive layer, built on tuiuiu.js.
 *
 * Omakub uses gum for this. gum is a separate binary that has to be
 * installed before any menu can be drawn — which is exactly why a
 * broken gum download aborted the whole omakub-wsl install before it
 * reached a single prompt. Compiling the UI into our own binary removes
 * that bootstrap dependency: red-dev can always draw its own interface,
 * including the screen that reports a failed install.
 *
 * The prompt helpers are blocking readline wrappers, so they degrade
 * predictably when stdin is not a TTY (CI, piped input); callers must
 * check `interactive()` before offering a menu.
 */

import { Box, Text, renderToString, prompt } from "tuiuiu.js";

export function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function banner(subtitle: string): string {
  return renderToString(
    Box(
      { flexDirection: "column", padding: 1, borderStyle: "round" },
      Text({ color: "red", bold: true }, "red-dev"),
      Text({ dim: true }, subtitle),
    ),
  );
}

export async function select<T extends string>(
  message: string,
  choices: readonly T[],
  fallback: T,
): Promise<T> {
  if (!interactive()) return fallback;
  return await prompt.select(message, choices);
}

export async function confirm(message: string, fallback = false): Promise<boolean> {
  if (!interactive()) return fallback;
  return await prompt.confirm(message, { default: fallback });
}

export async function checkbox<T extends string>(
  message: string,
  choices: readonly T[],
  fallback: T[] = [],
): Promise<T[]> {
  if (!interactive()) return fallback;
  return await prompt.checkbox(message, choices);
}

export async function text(message: string, fallback = ""): Promise<string> {
  if (!interactive()) return fallback;
  return await prompt.input(message, fallback ? { default: fallback } : {});
}
