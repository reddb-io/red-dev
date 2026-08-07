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
import type { Platform } from "./platform.ts";
import { themeFor, type Theme } from "./themes.ts";

export interface ThemeSurfaceSpec {
  name: string;
  /** False on a target that has no such surface at all. */
  applies: (p: Platform) => boolean;
  apply: (theme: Theme, slug: string, p: Platform) => Promise<boolean>;
}

/**
 * One list, where there used to be two.
 *
 * The names and the functions lived in separate structures that had to
 * agree, and the lookup was `surfaceFns[name]!`. A name present in one
 * and missing from the other threw a TypeError *inside* the try/catch
 * below, so the surface was reported as a benign "skipped" and the
 * disagreement was invisible. One array cannot disagree with itself.
 */
export const THEME_SURFACES: ThemeSurfaceSpec[] = [
  {
    name: "vscode",
    applies: () => true,
    apply: async (theme, slug, p) => {
      const { applyVsCodeTheme } = await import("./theme-editors.ts");
      return applyVsCodeTheme(theme, p, slug);
    },
  },
  {
    // In the registry rather than called separately after it. The
    // wallpaper is the surface a theme change is most visible on, and
    // leaving it outside meant the two callers each remembered to invoke
    // it — which is the shape of a thing one caller eventually forgets.
    name: "wallpaper",
    applies: (p) => p.env !== "server",
    apply: async (theme, slug, p) => {
      const { applyWallpaper, sweepRetiredWallpapers } = await import("./wallpaper.ts");
      const ok = await applyWallpaper(theme, slug, p);
      // Swept after the desktop has been repointed, never before: the
      // other order leaves a moment where the OS references a file that
      // has just been deleted. Only red-dev's own directory is touched.
      if (ok) {
        const gone = await sweepRetiredWallpapers(p);
        if (gone.length > 0) log.plain(`       removed ${gone.length} retired wallpaper(s)`);
      }
      return ok;
    },
  },
  {
    name: "windows",
    applies: (p) => p.env === "wsl" || p.env === "windows",
    apply: async (theme, slug, p) => {
      const { applyWindowsDesktopTheme } = await import("./windows-theme.ts");
      return applyWindowsDesktopTheme(theme, p, slug);
    },
  },
  {
    name: "gnome",
    applies: (p) => p.os !== "windows",
    apply: async (theme, slug, p) => {
      const { applyGnomeTheme } = await import("./theme-editors.ts");
      return applyGnomeTheme(p, theme, slug);
    },
  },
];

export function themeSurfaceNames(p: Platform): string[] {
  return THEME_SURFACES.filter((s) => s.applies(p)).map((s) => s.name);
}

export interface ApplyThemeResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply one theme, named by its slug.
 *
 * The slug is the input, not the theme, and that is the fix for a bug
 * that only ever appeared on the converge path. This used to take a
 * `Theme` with the slug as an optional third argument, and derive it
 * from the display name when omitted:
 *
 *   const key = slug ?? theme.name.toLowerCase().replace(/\s+/g, "-");
 *
 * providers.ts omitted it. So a converge turned "Catppuccin Macchiato"
 * into `catppuccin-macchiato`, which was a key in none of the six
 * slug-indexed maps — no VS Code theme, no GNOME accent, a fallback bat
 * theme, a blue Windows accent, and a wallpaper written under a name
 * nothing else used. `red-dev theme catppuccin` was correct the whole
 * time, which is why it survived: the bug was in the path nobody runs by
 * hand.
 *
 * With one argument the two cannot disagree, and the call site that used
 * to omit it does not compile.
 *
 * `surfaces` is injectable so a test can watch what each one receives.
 * That test could not be written against the old shape at all.
 */
export async function applyThemeEverywhere(
  slug: string,
  p: Platform,
  surfaces: ThemeSurfaceSpec[] = THEME_SURFACES,
): Promise<ApplyThemeResult> {
  const theme = themeFor(slug);
  if (!theme) throw new Error(`unknown theme '${slug}'`);

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const surface of surfaces.filter((s) => s.applies(p))) {
    try {
      if (await surface.apply(theme, slug, p)) applied.push(surface.name);
      else skipped.push(surface.name);
    } catch (err) {
      log.warn(`${surface.name}: ${(err as Error).message}`);
      skipped.push(surface.name);
    }
  }

  return { applied, skipped };
}
