/**
 * Apply a theme to the surfaces a theme still owns.
 *
 * It used to own eleven, nine of which were inside the terminal window.
 * That is the arrangement .red/adr/0002 reverses: every program in a
 * terminal paints over the ANSI slots beneath it, so a theme spread
 * across nine of them arrived as neither the old one nor the new one,
 * and switching looked like it had failed. The terminal now takes one
 * fixed palette — src/terminal-surfaces.ts — and a theme is what changes
 * the things you can see at a glance and nothing else overrides.
 *
 * What is left is the desktop: the wallpaper, the system accent and
 * light-dark, and the editor that is a window rather than a pane.
 *
 * Each writer is independent and failure-tolerant: a missing application
 * is not an error, it is just a surface that does not exist here.
 */

import { log } from "./log.ts";
import { applyWindowsDesktopTheme } from "./windows-theme.ts";
import type { Platform } from "./platform.ts";
import type { Theme } from "./themes.ts";

// --------------------------------------------------------- entrypoint

const PORTABLE_SURFACE_NAMES = ["vscode"];

export function themeSurfaceNames(p: Platform): string[] {
  return [
    ...PORTABLE_SURFACE_NAMES,
    ...(p.env === "wsl" || p.env === "windows" ? ["windows"] : []),
    ...(p.os !== "windows" ? ["gnome"] : []),
  ];
}

export interface ApplyThemeResult {
  applied: string[];
  skipped: string[];
}

export async function applyThemeEverywhere(
  theme: Theme,
  p: Platform,
  slug?: string,
): Promise<ApplyThemeResult> {
  const applied: string[] = [];
  const skipped: string[] = [];

  const { applyVsCodeTheme, applyGnomeTheme } = await import("./theme-editors.ts");
  // Derive the slug from the display name when the caller did not pass
  // one, so `theme gruvbox` and the menu both reach the same mapping.
  const key = slug ?? theme.name.toLowerCase().replace(/\s+/g, "-");

  const surfaceFns: Record<string, () => Promise<boolean>> = {
    vscode: () => applyVsCodeTheme(theme, p, key),
    windows: () => applyWindowsDesktopTheme(theme, p, key),
    gnome: () => applyGnomeTheme(p, theme, key),
  };
  const surfaces = themeSurfaceNames(p).map((name) => [name, surfaceFns[name]!] as const);

  for (const [name, fn] of surfaces) {
    try {
      if (await fn()) applied.push(name);
      else skipped.push(name);
    } catch (err) {
      log.warn(`${name}: ${(err as Error).message}`);
      skipped.push(name);
    }
  }

  return { applied, skipped };
}
