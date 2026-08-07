/**
 * The Windows half of what omakub does to GNOME.
 *
 * omakub sets the shell's light/dark preference and an accent colour,
 * and that is most of why a theme switch feels like it reached the
 * desktop rather than just the terminal. Windows has the same two
 * settings and they are plain registry values — no dependency, no
 * elevation, no extension to install.
 *
 * The accent comes off the theme itself, which is a smaller job than it
 * used to be: there is one accent in the brand, and the only question
 * left is whether a theme has it. Two do not, and expressing that on
 * Windows takes more than it should — see accentOf.
 *
 * What this deliberately does not do is tiling. Windows 11 has Snap
 * Layouts natively and PowerToys has FancyZones, which is the real
 * analogue of omakub's tactile — but PowerToys is a program to install
 * and a decision to make, not something a theme switch should do behind
 * your back.
 */

import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import type { Theme } from "./themes.ts";

/**
 * The accent Windows should paint with, and what "none" means here.
 *
 * It used to be a per-slug pick out of the theme's ANSI palette, with a
 * fallback to blue. Both are gone: a theme carries its accent directly,
 * and there is only one accent in the brand.
 *
 * Windows has no way to say "no accent". ColorPrevalence 0 keeps it off
 * title bars and the taskbar, but the AccentColor already stored still
 * tints Start, focus rings and window borders — so a user switching from
 * dark to obsidian would keep red in their chrome. Absence therefore has
 * to be written as a colour: the theme's own edge, which is the quietest
 * thing it owns.
 */
function accentOf(theme: Theme): string {
  return theme.accent.kind === "colour" ? theme.accent.value : theme.surface.edge;
}

/**
 * The registry writes, as a script, so the decisions can be read.
 *
 * Pure and exported because the interesting half of this function is not
 * the spawn — it is which values a theme with no accent produces, and
 * that was untestable while the script was built inline.
 */
export function windowsThemeScript(theme: Theme): string {
  const lightTheme = windowsLightThemeValue(theme);
  const dword = accentDword(accentOf(theme));
  // Prevalence is the only lever Windows offers for "quiet", and it is
  // not enough on its own — see accentOf.
  const prevalence = theme.accent.kind === "colour" ? 1 : 0;

  return [
    `$pers = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'`,
    `$dwm  = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\DWM'`,
    // Apps and shell together: setting only one leaves a light taskbar
    // over dark windows, which looks like a half-applied theme because
    // it is one.
    `Set-ItemProperty $pers -Name AppsUseLightTheme -Value ${lightTheme} -Type DWord`,
    `Set-ItemProperty $pers -Name SystemUsesLightTheme -Value ${lightTheme} -Type DWord`,
    `Set-ItemProperty $dwm -Name AccentColor -Value ${dword} -Type DWord`,
    // Without this the accent is stored and never shown: it only reaches
    // title bars and the taskbar when prevalence is on.
    `Set-ItemProperty $dwm -Name ColorPrevalence -Value ${prevalence} -Type DWord`,
    `'ok'`,
  ].join("; ");
}

/**
 * Windows stores the accent as 0xAABBGGRR, which is not the order the
 * name suggests and not the order anyone guesses.
 *
 * Established by reading what was already there rather than from
 * documentation: the value was 0xFFD47800, and Windows' own default
 * accent is #0078D4. Only one byte order makes those the same colour.
 */
export function accentDword(hex: string): number {
  const n = parseInt(hex.replace(/^#/, ""), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  // Unsigned, because the alpha byte makes this larger than a signed
  // 32-bit integer and PowerShell rejects the negative.
  return ((0xff << 24) >>> 0) + (b << 16) + (g << 8) + r;
}

export function windowsLightThemeValue(theme: Theme): 0 | 1 {
  return theme.appearance === "light" ? 1 : 0;
}

/**
 * Apply the desktop half of a theme on Windows.
 */
export async function applyWindowsDesktopTheme(
  theme: Theme,
  p: Platform,
  slug: string,
): Promise<boolean> {
  if (p.os !== "windows" && p.env !== "wsl") return false;
  void slug;

  const accent = accentOf(theme);
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", windowsThemeScript(theme)], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out.includes("ok")) {
    const err = (await new Response(proc.stderr).text()).trim();
    log.warn(`Windows desktop theme: ${err.split("\n")[0] ?? "failed"}`);
    return false;
  }

  const mode = theme.appearance === "light" ? "light mode" : "dark mode";
  const where = theme.accent.kind === "colour" ? "accent on title bars" : "no accent, chrome left neutral";
  log.plain(`       accent ${accent}, ${mode}, ${where}`);
  log.plain(`       already-open windows keep their colour until reopened`);
  return true;
}
