/**
 * Choices that outlive a single run.
 *
 * The one that forced this file into existence: which shell the terminal
 * opens into on a Windows machine that also has WSL. Alacritty has no
 * profiles, so one config means one shell — and until now that shell was
 * decided by whichever side happened to run red-dev last. Converging
 * from the distro pointed it at wsl.exe; converging from Windows pointed
 * it at Git Bash; neither was a decision anyone made.
 *
 * Stored beside the Alacritty config rather than in a home directory,
 * because that is the one location both sides of the WSL boundary
 * already agree on: under WSL red-dev resolves it to the Windows host,
 * and on Windows it is simply local. A preference that lives in two
 * places is not a preference.
 */

import { existsSync, mkdirSync } from "node:fs";
import type { ApplyContext } from "./providers.ts";
import type { Platform } from "./platform.ts";
import { resolveThemeSlug } from "./themes.ts";

export type TerminalShell = "wsl" | "gitbash";

export interface Preferences {
  /** Which shell Alacritty launches on a Windows host. */
  terminalShell?: TerminalShell;
  /** WSL distro to open, when terminalShell is "wsl". */
  distro?: string;
  /**
   * Set once the first-run questions have been answered. Keyed on the
   * answer rather than on installed tools, so a machine set up
   * non-interactively still gets asked the first time someone runs it
   * from a terminal.
   */
  setupCompleted?: boolean;
  theme?: string;
  font?: string;
  /** Terminal font size in points. omakub offers 7 to 14. */
  fontSize?: number;
  blesh?: boolean;
  /** Agent keys chosen for this workstation, mirrored into WSL when selected. */
  agents?: string[];
  /** mise runtime ids chosen for this workstation. */
  runtimes?: string[];
  /** Ids of one-off repairs already applied; see src/migrations.ts. */
  migrations?: string[];
}

const FILE = "red-dev.json";

async function prefDir(p: Platform): Promise<string> {
  const { configDir } = await import("./alacritty.ts");
  return await configDir(p);
}

function join(dir: string, name: string, p: Platform): string {
  return `${dir}${p.os === "windows" ? "\\" : "/"}${name}`;
}

export async function readPreferences(p: Platform): Promise<Preferences> {
  try {
    const path = join(await prefDir(p), FILE, p);
    if (!existsSync(path)) return {};
    return JSON.parse(await Bun.file(path).text()) as Preferences;
  } catch {
    // A corrupt preferences file must not stop a converge; the defaults
    // below are all recoverable.
    return {};
  }
}

export async function writePreferences(p: Platform, prefs: Preferences): Promise<void> {
  const dir = await prefDir(p);
  mkdirSync(dir, { recursive: true });
  const merged = { ...(await readPreferences(p)), ...prefs };
  await Bun.write(join(dir, FILE, p), JSON.stringify(merged, null, 2) + "\n");
}

/**
 * The shell to configure, preferring a recorded choice over an
 * inference.
 *
 * Falling back to "wherever this run happens to be" keeps a first
 * converge working without a prompt, but it is a default, not an
 * answer — `red-dev shell` is how it becomes one.
 */
export async function resolveTerminalShell(p: Platform): Promise<TerminalShell> {
  const prefs = await readPreferences(p);
  if (prefs.terminalShell) return prefs.terminalShell;
  return p.env === "wsl" ? "wsl" : "gitbash";
}

export type ApplyContextEntryPath = "plan" | "install" | "update" | "theme";

export interface InvocationDefaults {
  themeName: string;
  font: string;
  opacity: number;
}

/**
 * Build the apply context after durable preferences have had their say.
 *
 * Command flags remain a run's defaults, but recorded user choices are
 * the better answer when a non-interactive entry point regenerates
 * terminal configuration. Without this, theme switches and converges
 * rewrote font.toml with FiraCode 11 even on machines configured for a
 * different font.
 */
export async function applyContextForEntry(
  p: Platform,
  inv: InvocationDefaults,
  _entry: ApplyContextEntryPath,
): Promise<ApplyContext> {
  const prefs = await readPreferences(p);
  return {
    platform: p,
    // resolveThemeSlug, not the raw value: every machine red-dev has
    // touched has one of the ten retired slugs recorded here, and this
    // is the read that heals it. No write and no ledger, so it is
    // idempotent by construction and correct even against a preferences
    // file restored from a backup.
    theme: resolveThemeSlug(prefs.theme ?? inv.themeName),
    font: prefs.font ?? inv.font,
    fontSize: prefs.fontSize,
    opacity: inv.opacity,
  };
}
