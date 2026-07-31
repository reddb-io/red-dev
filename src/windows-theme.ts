/**
 * The Windows half of what omakub does to GNOME.
 *
 * omakub sets the shell's light/dark preference and an accent colour,
 * and that is most of why a theme switch feels like it reached the
 * desktop rather than just the terminal. Windows has the same two
 * settings and they are plain registry values — no dependency, no
 * elevation, no extension to install.
 *
 * The accent is picked from the same per-theme map GNOME uses, so
 * "gruvbox is orange" means the same thing on both sides rather than
 * being decided twice.
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
 * The accent, per theme, as a colour from the palette.
 *
 * GNOME takes a name from a fixed list — blue, purple, orange — and
 * Windows takes a colour, so this maps the same intent onto the palette
 * we already have rather than inventing a second opinion.
 */
function accentOf(theme: Theme, slug: string): string {
  const c = theme.terminal;
  const byTheme: Record<string, string> = {
    "tokyo-night": c.blue,
    catppuccin: c.purple,
    gruvbox: c.yellow,
    everforest: c.green,
    kanagawa: c.purple,
    "matte-black": c.red,
    nord: c.blue,
    "osaka-jade": c.cyan,
    ristretto: c.red,
    "rose-pine": c.purple,
  };
  return byTheme[slug] ?? c.blue;
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

/**
 * Apply the desktop half of a theme on Windows.
 *
 * Every palette this project ships is dark, so dark mode is not a
 * question — light mode with a dark terminal is the seam omakub's GNOME
 * step exists to close.
 */
export async function applyWindowsDesktopTheme(
  theme: Theme,
  p: Platform,
  slug: string,
): Promise<boolean> {
  if (p.os !== "windows" && p.env !== "wsl") return false;

  const accent = accentOf(theme, slug);
  const dword = accentDword(accent);

  const script = [
    `$pers = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'`,
    `$dwm  = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\DWM'`,
    // Apps and shell together: setting only one leaves a light taskbar
    // over dark windows, which looks like a half-applied theme because
    // it is one.
    `Set-ItemProperty $pers -Name AppsUseLightTheme -Value 0 -Type DWord`,
    `Set-ItemProperty $pers -Name SystemUsesLightTheme -Value 0 -Type DWord`,
    `Set-ItemProperty $dwm -Name AccentColor -Value ${dword} -Type DWord`,
    // Without this the accent is stored and never shown: it only reaches
    // title bars and the taskbar when prevalence is on.
    `Set-ItemProperty $dwm -Name ColorPrevalence -Value 1 -Type DWord`,
    `'ok'`,
  ].join("; ");

  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", script], {
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

  log.plain(`       accent ${accent}, dark mode, accent on title bars`);
  log.plain(`       already-open windows keep their colour until reopened`);
  return true;
}
