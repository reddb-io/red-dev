/**
 * The brand wallpapers, embedded.
 *
 * These used to be generated: a diagonal gradient derived from the
 * theme's own palette, because copying omakub's photographs raised a
 * licensing question this project could not answer and fetching images
 * at apply time would have made theming depend on the network.
 *
 * Both reasons are gone. The wallpapers are ours now — six sheets from
 * reddb-io/brand, vendored under assets/wallpapers and pinned in
 * vendor/brand/brand.lock.json — so there is no licence to wonder about
 * and nothing to fetch. And a generator cannot draw a mark: the point of
 * this change is that the desktop carries the identity, which a gradient
 * never could.
 *
 * The generator is not kept as a fallback, and the reason is worth
 * recording. It seeded itself from `theme.terminal.blue`, a field the
 * fixed terminal palette made constant — so every theme would have
 * produced the same image, and that failure is invisible. A silent
 * near-miss is worse than a missing file, and a missing file cannot
 * happen: the asset is in the binary or the build is broken, and
 * scripts/embed-smoke.ts fails the build first.
 *
 * `with { type: "file" }` yields a PATH rather than the bytes — see
 * src/shims.d.ts. Under --compile Bun also renames the embedded file, so
 * the basename differs between `bun run` and the binary and must never
 * be used to derive an output name.
 */

import { existsSync, mkdirSync } from "node:fs";
import type { Platform } from "./platform.ts";
import { decodePng } from "./png.ts";
import { customWallpaperDigest } from "./preferences.ts";
import {
  isThemeSlug,
  resolveThemeSlug,
  THEMES,
  THEME_SLUGS,
  type Theme,
  type ThemeSlug,
} from "./themes.ts";
import {
  hiddenCapture,
  HIDDEN_RUNNER,
  powershellCommand,
  runHidden,
  windowsPathFor,
} from "./windows-hidden.ts";

import darkPng from "../assets/wallpapers/dark.png" with { type: "file" };
import lightPng from "../assets/wallpapers/light.png" with { type: "file" };
import obsidianPng from "../assets/wallpapers/obsidian.png" with { type: "file" };
import marblePng from "../assets/wallpapers/marble.png" with { type: "file" };
import cobaltPng from "../assets/wallpapers/cobalt.png" with { type: "file" };
import flarePng from "../assets/wallpapers/flare.png" with { type: "file" };

/**
 * Named one by one rather than built from a loop: an import attribute is
 * resolved at build time, so the specifier has to be a literal. A
 * computed path would type-check and ship a binary with no wallpapers
 * in it.
 */
const EMBEDDED: Record<ThemeSlug, string> = {
  dark: darkPng,
  light: lightPng,
  obsidian: obsidianPng,
  marble: marblePng,
  cobalt: cobaltPng,
  flare: flarePng,
};

function home(): string {
  const h = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!h) throw new Error("neither HOME nor USERPROFILE is set");
  return h;
}

/**
 * Where images have to live for the machine that will display them.
 *
 * Under WSL this must be the Windows filesystem, not the distro's. A
 * wallpaper at \\wsl.localhost\... only renders while the distro is
 * running: shut WSL down and the desktop goes black, and every login
 * reads it across the 9p bridge. The host's own disk has neither
 * problem.
 *
 * The root rather than the wallpaper directory, because Redwall writes
 * beside it under the same rule and a second copy of this reasoning is a
 * second chance for one of them to be wrong about WSL.
 */
export async function imageRoot(p: Platform): Promise<string> {
  if (p.env === "wsl") {
    const { windowsLocalAppData } = await import("./wsl.ts");
    return `${await windowsLocalAppData()}/red-dev`;
  }
  return `${home()}/.local/share/red-dev`;
}

/** Where the theme's own art is copied to, and nothing else. */
export async function wallpaperDir(p: Platform): Promise<string> {
  return `${await imageRoot(p)}/wallpapers`;
}

/** Imported user art lives apart from the finite set of bundled sheets. */
export async function customWallpaperDir(p: Platform): Promise<string> {
  return `${await imageRoot(p)}/custom-wallpapers`;
}

const MAX_CUSTOM_WALLPAPER_BYTES = 32 * 1024 * 1024;

export interface CustomWallpaperImport {
  /** Safe to persist: it contains neither the source path nor URL. */
  readonly preference: string;
  /** The managed copy used by both the plain wallpaper and Redwall. */
  readonly path: string;
  readonly bytes: number;
}

export interface WallpaperImportSeams {
  readonly fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly windowsToUnix?: (path: string) => Promise<string | null>;
}

function windowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path);
}

export async function wallpaperSourcePath(
  source: string,
  p: Platform,
  convert?: (path: string) => Promise<string | null>,
): Promise<string> {
  if (windowsAbsolute(source)) {
    if (p.env === "wsl") {
      if (convert) {
        const translated = await convert(source);
        if (translated) return translated;
      } else {
        const proc = Bun.spawn(["wslpath", "-u", source], { stdout: "pipe", stderr: "ignore" });
        const translated = (await new Response(proc.stdout).text()).trim();
        if ((await proc.exited) === 0 && translated) return translated;
      }
      throw new Error("could not translate the Windows wallpaper path through WSL");
    }
    if (p.os === "windows") return source;
    throw new Error("a Windows wallpaper path is only valid on Windows or WSL");
  }
  if (source.startsWith("/")) return source;
  throw new Error("wallpaper path must be absolute (for example C:\\Users\\me\\wall.png or /home/me/wall.png)");
}

async function boundedResponse(response: Response): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`wallpaper download returned HTTP ${response.status}`);
  if (response.url && new URL(response.url).protocol !== "https:") {
    throw new Error("wallpaper download redirected outside HTTPS");
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CUSTOM_WALLPAPER_BYTES) {
    throw new Error("wallpaper is larger than the 32 MB import limit");
  }
  if (!response.body) throw new Error("wallpaper download returned no body");

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > MAX_CUSTOM_WALLPAPER_BYTES) {
      throw new Error("wallpaper is larger than the 32 MB import limit");
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function customWallpaperBytes(
  source: string,
  p: Platform,
  seams: WallpaperImportSeams,
): Promise<Uint8Array> {
  let parsed: URL | null = null;
  try {
    parsed = new URL(source);
  } catch {
    // It is a filesystem path; Windows drive letters also parse as URLs,
    // but their one-letter protocol is handled below as a path.
  }

  if (parsed && parsed.protocol.length > 2) {
    if (parsed.protocol !== "https:") throw new Error("remote wallpaper must use HTTPS");
    const get = seams.fetch ?? fetch;
    const response = await get(parsed, { signal: AbortSignal.timeout(30_000) });
    return await boundedResponse(response);
  }

  const path = await wallpaperSourcePath(source, p, seams.windowsToUnix);
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error("wallpaper file does not exist");
  if (file.size > MAX_CUSTOM_WALLPAPER_BYTES) {
    throw new Error("wallpaper is larger than the 32 MB import limit");
  }
  return await file.bytes();
}

/**
 * Import one PNG by absolute path or HTTPS URL.
 *
 * The source itself is intentionally forgotten. A content-addressed local
 * copy makes scheduled Redwall repaints deterministic, keeps URL query
 * strings out of preferences, and gives native Windows and WSL one shared
 * physical image without asking them to agree on path spelling.
 */
export async function importCustomWallpaper(
  source: string,
  p: Platform,
  seams: WallpaperImportSeams = {},
): Promise<CustomWallpaperImport> {
  const bytes = await customWallpaperBytes(source.trim(), p, seams);
  decodePng(bytes); // validates format, checksum, encoding and bounded dimensions
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const dir = await customWallpaperDir(p);
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${digest}.png`;
  if (!existsSync(path)) await Bun.write(path, bytes);
  return { preference: `custom:${digest}`, path, bytes: bytes.byteLength };
}

/** Resolve a managed custom reference without trusting an arbitrary edited path. */
export async function customWallpaperPath(preference: unknown, p: Platform): Promise<string | null> {
  const digest = customWallpaperDigest(preference);
  return digest === null ? null : `${await customWallpaperDir(p)}/${digest}.png`;
}

/**
 * Eight hex of a sha256, which is how red-dev names an image after its
 * contents.
 *
 * Shared with Redwall rather than spelled twice, because the two
 * directories name files for the same reason — new bytes must be a new
 * path, or a desktop that caches by path goes on showing the old image —
 * and a convention that is written down once cannot drift.
 */
export function shortDigest(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 8);
}

/**
 * The theme's sheet, as bytes, from the binary.
 *
 * Exported for Redwall, which composes over the same art the desktop
 * would otherwise carry. Reading it back out of the wallpapers directory
 * would make the overlay depend on a converge having run first; the
 * embedded bytes are the source and the file on disk is a copy of them.
 */
export async function wallpaperBytes(key: string): Promise<Uint8Array> {
  const source = EMBEDDED[key as ThemeSlug];
  if (!source) throw new Error(`no wallpaper for theme '${key}'`);
  return await Bun.file(source).bytes();
}

export interface WallpaperArt {
  readonly bytes: Uint8Array;
  /** Stable filename stem for a derived Redwall. */
  readonly key: string;
  /** Palette used for the Redwall card drawn over this art. */
  readonly theme: Theme;
  readonly path: string | null;
}

/** Resolve bundled or imported art while keeping the colour theme independent. */
export async function resolveWallpaperArt(
  p: Platform,
  colourTheme: string,
  preference: unknown,
): Promise<WallpaperArt> {
  const custom = await customWallpaperPath(preference, p);
  if (custom !== null) {
    if (!existsSync(custom)) throw new Error("the imported custom wallpaper is missing; choose it again");
    return {
      bytes: await Bun.file(custom).bytes(),
      key: `custom-${customWallpaperDigest(preference)}`,
      theme: THEMES[resolveThemeSlug(colourTheme)],
      path: custom,
    };
  }

  const slug = typeof preference === "string" && isThemeSlug(preference)
    ? preference
    : resolveThemeSlug(colourTheme);
  return { bytes: await wallpaperBytes(slug), key: slug, theme: THEMES[slug], path: null };
}

/**
 * Put the image where the machine that displays it can read it, and
 * return that path.
 *
 * The filename carries eight hex of the content's sha256, which turns
 * the `existsSync` short-circuit from a hazard into the right answer.
 * With a fixed name, a machine that already had `dark.png` kept it
 * forever — that is exactly how ten stale omakub gradients survived —
 * and new bytes under an old name are invisible. New bytes are now a new
 * path, so the cache cannot serve a stale image and nothing has to
 * remember to invalidate it.
 */
export async function materialise(theme: Theme, key: string, p: Platform): Promise<string> {
  void theme;
  const bytes = await wallpaperBytes(key);
  const digest = shortDigest(bytes);

  const dir = await wallpaperDir(p);
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${key}-${digest}.png`;
  if (!existsSync(path)) await Bun.write(path, bytes);
  return path;
}

/**
 * Delete the script red-dev uses to reach the host without a window, and
 * report whether there was one.
 *
 * Uninstall's business, and it has to be asked for by name for the same
 * reason the Redwall directory does: on WSL this lives on the Windows
 * disk, so none of the paths under the distro's home covers it, and a
 * machine uninstalled from inside WSL would keep a .vbs under a removed
 * tool's directory that nothing left on it could explain.
 */
export async function removeHiddenRunner(p: Platform): Promise<string | null> {
  const path = `${await imageRoot(p)}/${HIDDEN_RUNNER}`;
  if (!existsSync(path)) return null;
  const { rmSync } = await import("node:fs");
  rmSync(path, { force: true });
  return path;
}

/**
 * Every name this version of red-dev can produce.
 *
 * Used to tell a retired image from one somebody chose by hand: the
 * sweep below deletes the first and doctor reports it, while a wallpaper
 * outside red-dev's own directory is a decision and is left alone.
 *
 * The set is finite — six themes, six names — and that is the property
 * the whole scheme rests on. It is also why a Redwall is written
 * somewhere else: a generated image changes whenever the state it shows
 * changes, so admitting one here would make this set unbounded and
 * leave the sweep unable to tell either kind of image apart.
 */
export async function expectedWallpaperNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const slug of THEME_SLUGS) {
    names.add(`${slug}-${shortDigest(await wallpaperBytes(slug))}.png`);
  }
  return names;
}

/**
 * Delete the images red-dev used to write and no longer does.
 *
 * Only inside red-dev's own wallpaper directory, and only after the
 * desktop has been repointed — otherwise there is a moment where the OS
 * references a file that has just been removed.
 */
export async function sweepRetiredWallpapers(p: Platform): Promise<string[]> {
  const dir = await wallpaperDir(p);
  if (!existsSync(dir)) return [];

  const keep = await expectedWallpaperNames();
  const { readdirSync, rmSync } = await import("node:fs");
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".png") || keep.has(name)) continue;
    rmSync(`${dir}/${name}`, { force: true });
    removed.push(name);
  }
  return removed;
}

// ------------------------------------------------------------ apply

async function run(cmd: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function setGnome(path: string): Promise<boolean> {
  if (!Bun.which("gsettings")) return false;
  const uri = `file://${path}`;
  const ok1 = await run(["gsettings", "set", "org.gnome.desktop.background", "picture-uri", uri]);
  // picture-uri-dark exists from GNOME 42 on; failing it is not fatal
  // on older releases.
  await run(["gsettings", "set", "org.gnome.desktop.background", "picture-uri-dark", uri]);
  await run(["gsettings", "set", "org.gnome.desktop.background", "picture-options", "zoom"]);
  return ok1;
}

/**
 * GNOME's lock-screen background, which is a different schema from the
 * desktop's and not the same promise.
 *
 * `org.gnome.desktop.screensaver` is the key GNOME exposes for this, and
 * setting it is all red-dev does. GNOME Shell has ignored it since 3.36
 * and blurs the desktop wallpaper instead — which is a Redwall either
 * way, blurred, so the state is still on the screen the feature exists
 * for. Making it exact would mean shipping a shell extension: a component
 * with its own lifecycle, its own version compatibility, and its own
 * failure mode on every GNOME release. That is a decision belonging to
 * the program, and red-dev stops where such decisions do.
 *
 * So the key is written once and never read back. There is nothing to
 * verify — a shell that honours it and a shell that ignores it are
 * indistinguishable from here, and a check that could only ever be
 * inconclusive would turn into a retry loop against a setting that is
 * already correct.
 *
 * Failure is not fatal for the same reason `picture-uri-dark` is not next
 * door: on a target where the schema is absent `gsettings` exits non-zero
 * and that is a surface this machine does not have.
 */
async function setGnomeLockScreen(path: string): Promise<boolean> {
  if (!Bun.which("gsettings")) return false;
  const uri = `file://${path}`;
  const ok = await run(["gsettings", "set", "org.gnome.desktop.screensaver", "picture-uri", uri]);
  await run(["gsettings", "set", "org.gnome.desktop.screensaver", "picture-options", "zoom"]);
  return ok;
}

/**
 * Point the lock screen at an image, on the targets that have one red-dev
 * can write.
 *
 * GNOME only, and deliberately. Windows has a lock screen but it is not
 * reachable on Home editions, and the route that works everywhere —
 * registering a screensaver — would greet a new machine with a SmartScreen
 * warning for the sake of a cosmetic feature. False there is the honest
 * answer rather than a best effort that half-works on half the machines.
 */
export async function setLockScreenBackground(path: string, p: Platform): Promise<boolean> {
  if (p.env !== "desktop") return false;
  return await setGnomeLockScreen(path);
}

/**
 * SystemParametersInfo is the only call that repaints the desktop
 * immediately; writing the registry value alone leaves the old image on
 * screen until the next sign-in.
 */
function windowsScript(winPath: string): string {
  return [
    "Add-Type -TypeDefinition '",
    "using System.Runtime.InteropServices;",
    "public class RedDevWallpaper {",
    '  [DllImport("user32.dll", CharSet=CharSet.Auto)]',
    "  public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);",
    "}';",
    // 20 = SPI_SETDESKWALLPAPER, 3 = update profile + broadcast change
    `[RedDevWallpaper]::SystemParametersInfo(20, 0, '${winPath}', 3) | Out-Null`,
  ].join("");
}

/**
 * Repaint the Windows desktop without drawing a window to do it.
 *
 * Through `runHidden` rather than spawning PowerShell here, and that is
 * the whole point of the indirection: on WSL this runs from a systemd
 * timer, and a console program started through interop by a process with
 * no console of its own has one allocated for it — a black rectangle
 * flashing on the desktop every two minutes, over a wallpaper. The same
 * route is taken natively, because a scheduled task on Windows has the
 * same problem and a second way of doing this would be a second thing to
 * get wrong.
 *
 * The runner lives beside the images, under `imageRoot`. On WSL that is
 * the host's own disk rather than the distro's — which is what makes it
 * reachable by wscript at all, and it is the same rule that put the
 * images there.
 *
 * Nothing comes back but the exit code. A hidden child has no streams,
 * so "the desktop refused" is the whole of the detail available, and the
 * one caller that asks only ever needed that much.
 */
async function setWindows(path: string, p: Platform): Promise<boolean> {
  // The desktop belongs to the host, so the image has to be named the
  // way the host names it.
  const winPath = await windowsPathFor(path, p);
  if (winPath === null) return false;
  return await runHidden(await imageRoot(p), powershellCommand(windowsScript(winPath)), p);
}

/**
 * Point the desktop at an image, whoever wrote it.
 *
 * Split out of `applyWallpaper` because Redwall's last step is this one
 * and nothing else: it composes its own image and then needs the desktop
 * repainted exactly the way a theme's own art would be. A second copy of
 * "how a background is set on GNOME and on Windows" would be a second
 * place for the WSL path translation to be wrong, and only one of the
 * two would be the one anybody tested.
 */
export async function setDesktopBackground(path: string, p: Platform): Promise<boolean> {
  if (p.env === "desktop") return await setGnome(path);
  if (p.os === "windows" || p.env === "wsl") return await setWindows(path, p);
  return false;
}

export async function applyWallpaper(
  theme: Theme,
  key: string,
  p: Platform,
): Promise<boolean> {
  // A headless server has no desktop to put an image on.
  if (p.env === "server") return false;

  return await setDesktopBackground(await materialise(theme, key, p), p);
}

/** Apply the selected imported image, or the selected/following bundled sheet. */
export async function applyWallpaperPreference(
  colourTheme: Theme,
  colourThemeKey: string,
  preference: unknown,
  p: Platform,
): Promise<boolean> {
  const custom = await customWallpaperPath(preference, p);
  if (custom !== null) {
    if (!existsSync(custom)) throw new Error("the imported custom wallpaper is missing; choose it again");
    return await setDesktopBackground(custom, p);
  }
  const key = typeof preference === "string" && isThemeSlug(preference)
    ? preference
    : resolveThemeSlug(colourThemeKey);
  return await applyWallpaper(THEMES[key] ?? colourTheme, key, p);
}

/** Keep only the selected imported source; derived Redwalls live elsewhere. */
export async function sweepCustomWallpapers(p: Platform, preference: unknown): Promise<string[]> {
  const dir = await customWallpaperDir(p);
  if (!existsSync(dir)) return [];
  const keep = customWallpaperDigest(preference);
  const { readdirSync, rmSync } = await import("node:fs");
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".png") || name === `${keep}.png`) continue;
    rmSync(`${dir}/${name}`, { force: true });
    removed.push(name);
  }
  return removed;
}

/** Remove only red-dev's imported copies; the user's original is never touched. */
export async function removeCustomWallpapers(p: Platform): Promise<string | null> {
  const dir = await customWallpaperDir(p);
  if (!existsSync(dir)) return null;
  const { rmSync } = await import("node:fs");
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

/**
 * Which image the desktop is currently pointed at, as the OS records it.
 * Read from the source of truth rather than from what red-dev last
 * wrote, so a wallpaper changed by hand — or one left pointing at a
 * deleted file — is visible to `doctor`.
 */
export async function wallpaperPathInUse(p: Platform): Promise<string | null> {
  if (p.os === "windows" || p.env === "wsl") {
    // Hidden, like the repaint next door and for the same reason: the
    // sweep asks this question whenever it has an image to delete, which
    // on a busy machine is most ticks of a two-minute timer, and a
    // PowerShell started through interop by a process with no console is
    // a window on the screen. Nothing is lost by hiding it — the answer
    // comes back through a file either way.
    const { out, code } = await hiddenCapture(
      await imageRoot(p),
      powershellCommand("(Get-ItemProperty 'HKCU:\\Control Panel\\Desktop' -Name WallPaper).WallPaper"),
      p,
    );
    const winPath = out.trim();
    if (code !== 0 || !winPath) return null;
    if (p.env !== "wsl") return winPath;

    // Translate back so existsSync can check it from this side.
    const conv = Bun.spawn(["wslpath", "-u", winPath], { stdout: "pipe", stderr: "ignore" });
    const unix = (await new Response(conv.stdout).text()).trim();
    return (await conv.exited) === 0 && unix ? unix : null;
  }

  if (p.env === "desktop" && Bun.which("gsettings")) {
    const proc = Bun.spawn(
      ["gsettings", "get", "org.gnome.desktop.background", "picture-uri"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const raw = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    const uri = raw.replace(/^'|'$/g, "");
    return uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : null;
  }

  return null;
}

// applyWallpaperLogged lived here and is gone. It existed because the
// wallpaper was applied outside the theme registry and therefore needed
// its own try/catch and its own log line; the registry provides both,
// and two callers each remembering to invoke a wrapper is the shape of a
// thing one caller eventually forgets.
