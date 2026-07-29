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
 * VS Code theme extensions, by our theme slug.
 *
 * The extension id matters as much as the display name: setting
 * `workbench.colorTheme` to a theme that is not installed leaves VS
 * Code on its default with a notification nobody reads.
 */
const VSCODE_THEMES: Record<string, { extension: string; label: string }> = {
  "tokyo-night": { extension: "enkia.tokyo-night", label: "Tokyo Night" },
  catppuccin: { extension: "Catppuccin.catppuccin-vsc", label: "Catppuccin Macchiato" },
  gruvbox: { extension: "jdinhlife.gruvbox", label: "Gruvbox Dark Medium" },
  everforest: { extension: "sainnhe.everforest", label: "Everforest Dark" },
  kanagawa: { extension: "qufiwefefwoyn.kanagawa", label: "Kanagawa" },
  "matte-black": { extension: "AndreiVoronkov.matte-black", label: "Matte Black" },
  nord: { extension: "arcticicestudio.nord-visual-studio-code", label: "Nord" },
  "osaka-jade": { extension: "solomonhyt.osaka-jade", label: "Osaka Jade" },
  ristretto: { extension: "kaiwood.monokai-pro", label: "Monokai Pro (Filter Ristretto)" },
  "rose-pine": { extension: "mvllow.rose-pine", label: "Rosé Pine" },
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
  const code = Bun.which("code") ?? "code.cmd";
  const install = Bun.spawn([code, "--install-extension", spec.extension, "--force"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await install.exited) !== 0) {
    log.warn(`could not install ${spec.extension}; leaving the theme alone`);
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
