/**
 * The mouse pointer over Alacritty, on a native Linux desktop.
 *
 * On GNOME under Wayland, Alacritty does not read the desktop's cursor
 * theme from the session the way GTK apps do; it asks libwayland-cursor
 * for a theme by name, and with no name it falls back to a default that
 * Ubuntu does not ship under that name. The result is a pointer that
 * vanishes the moment it crosses the terminal window and comes back on
 * the desktop beside it — alacritty/alacritty#8357, #8284, #6981.
 *
 * The fix upstream documents is `XCURSOR_THEME` (and `XCURSOR_SIZE`,
 * or the pointer comes back at the wrong scale). Here that is one file
 * under `~/.config/environment.d`, which the user's systemd manager
 * reads at login and hands to the GNOME session, so every launcher —
 * the dock, the Super key, a `.desktop` file — starts Alacritty with
 * the theme named. The values are the desktop's own, read from
 * gsettings, so a person who changes their pointer changes it here too
 * at the next converge.
 *
 * Only a desktop. Under WSL the terminal is on Windows, and a server
 * has no pointer.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { log } from "./log.ts";

/** The file this owns. */
export const POINTER_ENVIRONMENT_FILE = "60-red-dev-pointer.conf";

/** The environment.d text for one theme and size. PURE. */
export function pointerEnvironment(theme: string, size: number): string {
  return [
    "# Managed by red-dev. Names the desktop's pointer theme for Wayland",
    "# clients that do not ask GNOME for it — Alacritty among them, which",
    "# otherwise draws no pointer at all. Rewritten by `red-dev install`.",
    `XCURSOR_THEME=${theme}`,
    `XCURSOR_SIZE=${size}`,
    "",
  ].join("\n");
}

/** `gsettings get` prints strings quoted; `'Yaru'` is Yaru. PURE. */
export function unquoteGsetting(value: string): string {
  return value.trim().replace(/^'(.*)'$/s, "$1");
}

async function gsetting(key: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gsettings", "get", "org.gnome.desktop.interface", key], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Write the file for this desktop, or leave it when it already says so.
 *
 * A missing gsettings — a desktop that is not GNOME — writes nothing:
 * naming a theme the compositor cannot find is the bug this fixes, not
 * a fix for it.
 */
export async function pinPointerTheme(home: string): Promise<void> {
  const themeRaw = await gsetting("cursor-theme");
  const sizeRaw = await gsetting("cursor-size");
  if (themeRaw === null || sizeRaw === null) {
    log.skip("pointer theme: no gsettings here, so nothing to name for Alacritty");
    return;
  }
  const theme = unquoteGsetting(themeRaw);
  const size = Number.parseInt(sizeRaw, 10);
  if (theme === "" || !Number.isFinite(size) || size <= 0) {
    log.skip("pointer theme: gsettings has no cursor theme to name");
    return;
  }

  const dir = `${home}/.config/environment.d`;
  const path = `${dir}/${POINTER_ENVIRONMENT_FILE}`;
  const wanted = pointerEnvironment(theme, size);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === wanted) {
    log.skip(`pointer theme already named for Alacritty (${theme}, ${size}px)`);
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, wanted);
  log.ok(`pointer theme named for Alacritty on Wayland: ${theme}, ${size}px`);
  log.plain("       takes effect at the next login — the session reads environment.d once");
}
