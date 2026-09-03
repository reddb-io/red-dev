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
import { isThemeSlug, resolveThemeSlug, type ThemeSlug } from "./themes.ts";

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
  /** A Red wallpaper slug or managed `custom:<sha256>` image. Absent follows the theme. */
  wallpaper?: string;
  font?: string;
  /** Terminal font size in points. omakub offers 7 to 14. */
  fontSize?: number;
  blesh?: boolean;
  /**
   * Whether the wallpaper carries live machine state — see Redwall in
   * .red/contexts/visual/CONTEXT.md.
   *
   * Absent means on. Boolean false is the durable opt-out and is never
   * overwritten by a later converge.
   */
  redwall?: boolean;
  /**
   * The interface whose address Redwall reports, for a machine that is
   * not reached the way its default route leaves — see src/lan-address.ts.
   *
   * Absent is the ordinary state and means the default route decides,
   * which is the answer that keeps working when adapters come and go.
   */
  redwallInterface?: string;
  /** Agent keys chosen for this workstation, mirrored into WSL when selected. */
  agents?: string[];
  /**
   * The one host red-dev hands work to — see src/default-agent.ts.
   *
   * Recorded here beside the selection it comes from rather than
   * derived from it on every read, because "which of these did you
   * choose" is not answerable from the list. Absent is unset, and unset
   * is a state red-dev reports rather than fills in.
   */
  defaultAgent?: string;
  /**
   * Whether a captured crash may be offered to the Default agent — see
   * src/crash-handoff.ts.
   *
   * Absent means the offer is made. Boolean false is the durable
   * decline: an offer that came back after every crash would be a nag,
   * so `no` is recorded here and honoured from then on. Nothing writes
   * true — accepting one offer is not a standing instruction about the
   * next crash.
   */
  crashHandoff?: boolean;
  /** mise runtime ids chosen for this workstation. */
  runtimes?: string[];
  /**
   * The RedSkills plugins switched on in the agent hosts — see
   * src/red-skills-plugins.ts.
   *
   * Absent means `dev` alone, which is what the interview arrives with.
   * Memory and Brain stay off until chosen, and a plugin that is off is
   * not installed into any host at all — so none of its hooks or MCP
   * servers run there. Recorded as the names the hosts use.
   */
  redSkillsPlugins?: string[];
  /**
   * Where the repair ledger used to live, until 2026-08-19.
   *
   * Read by nothing now. On a WSL machine this file is the Windows
   * host's, so one list spoke for two filesystems and a repair applied
   * inside the distro marked itself done for the host as well. The
   * ledger is per-side now — `migrationLedgerPath` in src/migrations.ts
   * — and this field is left declared so an older field in an existing
   * file round-trips through `writePreferences` rather than being
   * dropped by it.
   */
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

/**
 * Whether Redwall is on for this machine.
 *
 * On unless someone said otherwise. Redwall is part of the default
 * desktop experience; boolean false is the explicit opt-out.
 *
 * `=== true` rather than a truthy read, because this file is JSON a
 * person can edit and "off" written as a string should not turn a
 * desktop into a dashboard.
 */
export async function resolveRedwall(p: Platform): Promise<boolean> {
  const prefs = await readPreferences(p);
  return prefs.redwall === undefined ? true : prefs.redwall === true;
}

/** Resolve the art independently from the colour theme when one was pinned. */
export function wallpaperSlugFor(preference: unknown, theme: string): ThemeSlug {
  return typeof preference === "string" && isThemeSlug(preference)
    ? preference
    : resolveThemeSlug(theme);
}

/** A content-addressed custom wallpaper reference, never its original path or URL. */
export function customWallpaperDigest(preference: unknown): string | null {
  if (typeof preference !== "string") return null;
  const match = /^custom:([a-f0-9]{64})$/.exec(preference);
  return match?.[1] ?? null;
}

/** Whether an edited preference still names a wallpaper red-dev knows how to resolve. */
export function validWallpaperPreference(preference: unknown): preference is string {
  return typeof preference === "string" &&
    (isThemeSlug(preference) || customWallpaperDigest(preference) !== null);
}

/** The Red wallpaper this machine should display for the current theme. */
export async function resolveWallpaperSlug(p: Platform, theme?: string): Promise<ThemeSlug> {
  const prefs = await readPreferences(p);
  return wallpaperSlugFor(prefs.wallpaper, theme ?? prefs.theme ?? "");
}

/**
 * The interface pinned for Redwall's address, or null for "let the
 * default route decide".
 *
 * Blank is not a pin. This is JSON a person opens, and emptying a value
 * is how someone clears one — reading "" as an interface name would
 * turn that into a pin that matches nothing, which looks identical to
 * an interface that has gone away. Trimmed for the same reason a name
 * copied off a screen deserves: the spaces around it are not the name.
 */
export async function resolveRedwallInterface(p: Platform): Promise<string | null> {
  const pinned = (await readPreferences(p)).redwallInterface;
  if (typeof pinned !== "string") return null;
  const trimmed = pinned.trim();
  return trimmed === "" ? null : trimmed;
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
