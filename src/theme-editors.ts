/**
 * Theming the two surfaces that are not terminals: VS Code and GNOME.
 *
 * These are the last of omakub's eight per-theme files this project did
 * not touch, and they are the ones people notice: a terminal in
 * Kanagawa next to an editor still in whatever it shipped with is what
 * makes a theme switch feel half-applied.
 *
 * Both are optional by nature — plenty of machines have neither — so a
 * missing one is a skip with a reason, never a failure.
 */

import { existsSync, mkdirSync } from "node:fs";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import type { GnomeAccent, Theme } from "./themes.ts";

/**
 * A batch file is not an executable, and CreateProcess knows it.
 *
 * VS Code's CLI on Windows is `code.cmd` — a shell script — so spawning
 * it directly fails the same way spawning `winget` did before it was
 * wrapped: the call returns non-zero without ever reaching the program.
 * That is why every theme change on Windows reported "could not install
 * <extension>" on a machine with VS Code plainly installed, and then
 * listed it as "not present".
 *
 * Exported for the test: the wrapping is the whole fix, and it is
 * invisible in any run where the spawn merely fails quietly.
 */
export function codeArgv(argv: string[], platform: string = process.platform): string[] {
  const [bin, ...rest] = argv;
  if (platform !== "win32" || !bin) return argv;
  if (!/\.(cmd|bat)$/i.test(bin)) return argv;
  return ["cmd.exe", "/c", bin, ...rest];
}

/**
 * VS Code theme extensions, by our theme slug.
 *
 * The extension id matters as much as the display name: setting
 * `workbench.colorTheme` to a theme that is not installed leaves VS
 * Code on its default with a notification nobody reads.
 */
/**
 * No mapping any more, and no extension to install.
 *
 * This was a per-slug table of marketplace ids, and it carried the scar
 * tissue to prove it: two ids that had never been published, one theme
 * with no extension at all, and a label taken from a extension's
 * contributes.themes rather than its display name. A theme now names a
 * VS Code *built-in*, so the install step — and the `code.cmd` quoting
 * bug that lived in it — is gone.
 *
 * The cost is real and worth stating: a theme drives VS Code's
 * appearance and nothing more, until a RedDB VS Code theme exists to
 * point at. Extensions someone already installed stay installed and go
 * inert; uninstalling them would be over-reach.
 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ",") {
      const rest = text.slice(i + 1);
      if (/^\s*[\]}]/.test(rest)) continue;
    }
    out += c;
  }
  return out;
}

export function parseJsoncObject(text: string): Record<string, unknown> {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text))) as Record<string, unknown>;
}

export function vscodeSettingsJson(original: string, label: string): string {
  const settings = original.trim() ? parseJsoncObject(original) : {};
  settings["workbench.colorTheme"] = label;
  return JSON.stringify(settings, null, 2) + "\n";
}

/**
 * Where the VS Code that will actually run reads its settings.
 *
 * Under WSL this is the third tool in a row that belongs to the host
 * rather than the distro: `code` resolves through interop to
 * `/mnt/c/.../Microsoft VS Code/bin/code`, so writing
 * ~/.config/Code/User/settings.json inside Ubuntu produces a file that
 * editor never opens — and the theme silently does not change while
 * every step reports success.
 *
 * Branching on which `code` won, not on which OS we are.
 */
async function codeSettingsPath(p: Platform): Promise<string | null> {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";

  if (p.os === "windows") {
    const appdata = process.env["APPDATA"] ?? `${home}\\AppData\\Roaming`;
    return `${appdata}\\Code\\User\\settings.json`;
  }

  const bin = Bun.which("code");
  if (p.env === "wsl" && bin?.startsWith("/mnt/")) {
    // The Windows VS Code. Ask Windows for its own %APPDATA% rather
    // than reconstructing it, which breaks for redirected profiles.
    const proc = Bun.spawn(["cmd.exe", "/c", "echo %APPDATA%"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const raw = (await new Response(proc.stdout).text()).trim().replace(/\r$/, "");
    if ((await proc.exited) !== 0 || !/^[A-Za-z]:\\/.test(raw)) return null;

    const conv = Bun.spawn(["wslpath", "-u", raw], { stdout: "pipe", stderr: "ignore" });
    const unix = (await new Response(conv.stdout).text()).trim();
    if ((await conv.exited) !== 0 || !unix) return null;
    return `${unix}/Code/User/settings.json`;
  }

  return `${home}/.config/Code/User/settings.json`;
}

/**
 * Set the VS Code colour theme.
 *
 * Parsed and re-serialised rather than sed-substituted the way omakub
 * does: a regex replace only works when the key already exists, so on a
 * fresh install — where settings.json is `{}` or absent — it silently
 * does nothing. This writes the key either way, and leaves every other
 * setting untouched.
 */
export async function applyVsCodeTheme(theme: Theme, p: Platform, slug: string): Promise<boolean> {
  if (!Bun.which("code") && !Bun.which("code.cmd")) {
    log.skip("VS Code not installed");
    return false;
  }

  void slug;
  const path = await codeSettingsPath(p);
  if (!path) {
    log.warn("could not locate VS Code's settings directory");
    return false;
  }

  let original = "";
  if (existsSync(path)) {
    try {
      original = await Bun.file(path).text();
      parseJsoncObject(original);
    } catch {
      // A settings.json with comments or a trailing comma is common and
      // valid to VS Code but not to JSON.parse. Overwriting it would
      // discard someone's entire configuration.
      log.warn("VS Code settings.json is not plain JSON; not touching it");
      return false;
    }
  } else {
    mkdirSync(path.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  }

  await Bun.write(path, vscodeSettingsJson(original, theme.vscode));
  void theme;
  return true;
}

/**
 * GNOME: the shell's light/dark preference and the accent colour.
 *
 * Deliberately not a full GTK theme install. omakub ships one because
 * it targets a desktop it fully controls; here the useful, reversible
 * part is telling GNOME whether this palette is dark and which accent
 * belongs to it, which every GNOME 47+ desktop honours natively.
 */
/**
 * GNOME's accent, or the absence of one.
 *
 * It used to be a per-slug map of nine different accents — blue for
 * nord, orange for gruvbox — which made sense when the themes came from
 * nine different projects. There is one accent now, and the only
 * question a theme answers is whether it has it.
 *
 * `slate` is GNOME's own neutral, which is the closest thing its fixed
 * list has to "none". Unlike Windows, saying so here is enough: GNOME
 * has no second place the old accent keeps showing through.
 */
function gnomeAccentOf(theme: Theme): GnomeAccent {
  return theme.accent.kind === "colour" ? theme.accent.gnome : "slate";
}

export function gnomeColorScheme(theme: Theme): "prefer-light" | "prefer-dark" {
  return theme.appearance === "light" ? "prefer-light" : "prefer-dark";
}

export async function applyGnomeTheme(p: Platform, theme: Theme, slug: string): Promise<boolean> {
  if (!p.caps.gui || !Bun.which("gsettings")) {
    log.skip("no GNOME session here");
    return false;
  }

  const run = async (schema: string, key: string, value: string): Promise<boolean> => {
    const proc = Bun.spawn(["gsettings", "set", schema, key, value], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  };

  await run("org.gnome.desktop.interface", "color-scheme", gnomeColorScheme(theme));

  void slug;
  // Accent colours are GNOME 47+. On older versions the key does not
  // exist and gsettings fails, which is fine and not worth a warning.
  await run("org.gnome.desktop.interface", "accent-color", gnomeAccentOf(theme));

  return true;
}
