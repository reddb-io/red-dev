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
import type { Theme } from "./themes.ts";

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
export const VSCODE_THEMES: Record<string, { extension: string; label: string }> = {
  "tokyo-night": { extension: "enkia.tokyo-night", label: "Tokyo Night" },
  catppuccin: { extension: "Catppuccin.catppuccin-vsc", label: "Catppuccin Macchiato" },
  gruvbox: { extension: "jdinhlife.gruvbox", label: "Gruvbox Dark Medium" },
  everforest: { extension: "sainnhe.everforest", label: "Everforest Dark" },
  kanagawa: { extension: "qufiwefefwoyn.kanagawa", label: "Kanagawa" },
  // Was AndreiVoronkov.matte-black, which the marketplace has never
  // published. Label taken from the extension's own contributes.themes
  // rather than from its display name — "Matte Black Theme", not
  // "Matte Black", and workbench.colorTheme wants the former.
  "matte-black": { extension: "CleanThemes.matte-black-theme", label: "Matte Black Theme" },
  nord: { extension: "arcticicestudio.nord-visual-studio-code", label: "Nord" },
  // Was kaiwood.monokai-pro, which does not exist; this is the
  // publisher's own.
  ristretto: {
    extension: "monokai.theme-monokai-pro-vscode",
    label: "Monokai Pro (Filter Ristretto)",
  },
  "rose-pine": { extension: "mvllow.rose-pine", label: "Rosé Pine" },
  // osaka-jade is deliberately absent. solomonhyt.osaka-jade does not
  // exist either, and no VS Code theme of that name does — the nearest
  // matches are Solarized Osaka, which is a different palette. Falling
  // through to "no VS Code theme mapped" leaves the editor alone, which
  // is honest; pointing at a plausible-looking neighbour would theme it
  // wrong and say it succeeded.
};

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

  const spec = VSCODE_THEMES[slug];
  if (!spec) {
    log.skip(`no VS Code theme mapped for ${slug}`);
    return false;
  }

  // Installing the extension first: setting a theme that is not there
  // leaves the editor on its default.
  const code = Bun.which("code") ?? Bun.which("code.cmd") ?? "code.cmd";
  const install = Bun.spawn(codeArgv([code, "--install-extension", spec.extension, "--force"]), {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await install.exited) !== 0) {
    // Deliberately not "not installed": VS Code is here, its CLI ran,
    // and the marketplace call is what failed. Reporting the two as the
    // same thing sent someone looking for an editor that was already on
    // their machine.
    log.warn(`VS Code is here but installing ${spec.extension} failed; leaving the theme alone`);
    return false;
  }

  const path = await codeSettingsPath(p);
  if (!path) {
    log.warn("could not locate VS Code's settings directory");
    return false;
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
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

  settings["workbench.colorTheme"] = spec.label;
  await Bun.write(path, JSON.stringify(settings, null, 2) + "\n");
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
const GNOME_ACCENTS: Record<string, string> = {
  "tokyo-night": "blue",
  catppuccin: "purple",
  gruvbox: "orange",
  everforest: "green",
  kanagawa: "purple",
  "matte-black": "slate",
  nord: "blue",
  "osaka-jade": "teal",
  ristretto: "pink",
  "rose-pine": "pink",
};

export async function applyGnomeTheme(p: Platform, slug: string): Promise<boolean> {
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

  // Every palette shipped here is dark; when a light one lands this
  // should read the background's luminance rather than assume.
  await run("org.gnome.desktop.interface", "color-scheme", "prefer-dark");

  const accent = GNOME_ACCENTS[slug];
  if (accent) {
    // Accent colours are GNOME 47+. On older versions the key does not
    // exist and gsettings fails, which is fine and not worth a warning.
    await run("org.gnome.desktop.interface", "accent-color", accent);
  }

  return true;
}
