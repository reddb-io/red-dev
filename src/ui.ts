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

/**
 * The third argument is both the non-interactive fallback and the
 * pre-selected value.
 *
 * It used to be only the former: tuiuiu accepts `default` on select and
 * checkbox and neither wrapper passed it, so every list opened on the
 * first item with nothing ticked. omakub pre-ticks its recommended
 * apps, and starting from an empty list makes a user do work the tool
 * already has an opinion about.
 */
export async function select<T extends string>(
  message: string,
  choices: readonly T[],
  fallback: T,
): Promise<T> {
  if (!interactive()) return fallback;
  return await prompt.select(message, choices, { default: fallback });
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
  return await prompt.checkbox(message, choices, { default: fallback });
}

export async function text(message: string, fallback = ""): Promise<string> {
  if (!interactive()) return fallback;
  return await prompt.input(message, fallback ? { default: fallback } : {});
}

/**
 * A bounded number, for the things that are a range rather than a list
 * — font size being the one omakub asks and this did not.
 */
export async function number(
  message: string,
  fallback: number,
  bounds: { min: number; max: number },
): Promise<number> {
  if (!interactive()) return fallback;
  return await prompt.number(message, { default: fallback, ...bounds });
}
