/**
 * Apply a theme to the surfaces a theme still owns.
 *
 * It used to own eleven, nine of which were inside the terminal window.
 * That is the arrangement .red/adr/0002 reversed and .red/adr/0003
 * finished: every program in a
 * terminal paints over the ANSI slots beneath it, so a theme spread
 * across nine of them arrived as neither the old one nor the new one,
 * and switching looked like it had failed. The terminal now takes one
 * fixed palette — src/terminal-surfaces.ts — and a theme is what changes
 * the things you can see at a glance and nothing else overrides.
 *
 * What is left is the desktop: the wallpaper, the system accent and
 * light-dark, the editor that is a window rather than a pane, and — for
 * the machines that use it — the Redwall drawn over the selected art.
 *
 * Each writer is independent and failure-tolerant: a missing application
 * is not an error, it is just a surface that does not exist here.
 */

import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import { isThemeSlug, themeFor, type Theme } from "./themes.ts";

/**
 * What a surface needs to know that the platform does not say.
 *
 * Redwall is the first surface whose existence is a decision rather than
 * a property of the machine, and the decision lives in a file. Resolved
 * once, up front, and handed to every `applies` — rather than read from
 * disk inside the predicate — for two reasons. A predicate that touches
 * the filesystem is a predicate whose answer depends on which machine
 * the test suite is running on, and reading it per surface would spawn
 * `cmd.exe` once per surface under WSL to find %APPDATA%.
 */
export interface ThemeSurfaceContext {
  /** Whether Redwall is on for this machine. */
  readonly redwall: boolean;
  /** Bundled slug or managed custom reference; null follows the colour theme. */
  readonly wallpaper: string | null;
}

/** What this machine has decided, for the surfaces that ask. */
export async function themeSurfaceContext(p: Platform): Promise<ThemeSurfaceContext> {
  const { readPreferences, resolveRedwall, validWallpaperPreference } = await import("./preferences.ts");
  const choice = (await readPreferences(p)).wallpaper;
  return {
    redwall: await resolveRedwall(p),
    wallpaper: validWallpaperPreference(choice) ? choice : null,
  };
}

export interface ThemeSurfaceSpec {
  name: string;
  /** False on a target that has no such surface at all. */
  applies: (p: Platform, ctx: ThemeSurfaceContext) => boolean;
  apply: (theme: Theme, slug: string, p: Platform, ctx: ThemeSurfaceContext) => Promise<boolean>;
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
    apply: async (theme, slug, p, ctx) => {
      const { applyWallpaperPreference, sweepRetiredWallpapers } = await import("./wallpaper.ts");
      const ok = await applyWallpaperPreference(theme, slug, ctx.wallpaper, p);
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
  {
    // After the wallpaper, and last, because it has the final word on
    // the background: Redwall composes over the art the surface above
    // just installed, so a theme change that ran them the other way
    // round would end with the plain art on screen and the overlay in a
    // directory nothing points at.
    //
    // It has the final word on the lock screen too, where the target has
    // one red-dev can write — see `setLockScreenBackground`, which is
    // also where the reason Windows is not such a target is recorded.
    //
    // The resolved surface slug is passed down rather than re-read: it
    // may be the new theme or an independently pinned wallpaper.
    name: "redwall",
    applies: (p, ctx) => ctx.redwall && p.env !== "server",
    apply: async (_theme, slug, p, ctx) => {
      const { applyRedwall } = await import("./redwall.ts");
      const { shown, removed } = await applyRedwall(p, slug, {}, ctx.wallpaper);
      if (removed.length > 0) log.plain(`       removed ${removed.length} superseded redwall(s)`);
      return shown;
    },
  },
];

export function themeSurfaceNames(p: Platform, ctx: ThemeSurfaceContext): string[] {
  return THEME_SURFACES.filter((s) => s.applies(p, ctx)).map((s) => s.name);
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
 * That test could not be written against the old shape at all. `ctx` is
 * injectable for the same reason one step further out: it is what
 * decides whether a surface is in the run, so absence is observable
 * through the same seam as presence.
 */
export async function applyThemeEverywhere(
  slug: string,
  p: Platform,
  surfaces: ThemeSurfaceSpec[] = THEME_SURFACES,
  ctx?: ThemeSurfaceContext,
): Promise<ApplyThemeResult> {
  const theme = themeFor(slug);
  if (!theme) throw new Error(`unknown theme '${slug}'`);

  // After the slug check, so an unknown theme still fails without having
  // gone to disk for a preference it will not use.
  const context = ctx ?? (await themeSurfaceContext(p));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const surface of surfaces.filter((s) => s.applies(p, context))) {
    try {
      const surfaceSlug = surface.name === "wallpaper" || surface.name === "redwall"
        ? (context.wallpaper && isThemeSlug(context.wallpaper) ? context.wallpaper : slug)
        : slug;
      const surfaceTheme = themeFor(surfaceSlug)!;
      if (await surface.apply(surfaceTheme, surfaceSlug, p, context)) applied.push(surface.name);
      else skipped.push(surface.name);
    } catch (err) {
      log.warn(`${surface.name}: ${(err as Error).message}`);
      skipped.push(surface.name);
    }
  }

  return { applied, skipped };
}
