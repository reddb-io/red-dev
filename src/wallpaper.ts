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
import { THEME_SLUGS, type Theme, type ThemeSlug } from "./themes.ts";

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
 * Where the image has to live for the machine that will display it.
 *
 * Under WSL this must be the Windows filesystem, not the distro's. A
 * wallpaper at \\wsl.localhost\... only renders while the distro is
 * running: shut WSL down and the desktop goes black, and every login
 * reads it across the 9p bridge. The host's own disk has neither
 * problem.
 */
export async function wallpaperDir(p: Platform): Promise<string> {
  if (p.env === "wsl") {
    const { windowsLocalAppData } = await import("./wsl.ts");
    return `${await windowsLocalAppData()}/red-dev/wallpapers`;
  }
  return `${home()}/.local/share/red-dev/wallpapers`;
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
  const source = EMBEDDED[key as ThemeSlug];
  if (!source) throw new Error(`no wallpaper for theme '${key}'`);

  const bytes = await Bun.file(source).bytes();
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 8);

  const dir = await wallpaperDir(p);
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${key}-${digest}.png`;
  if (!existsSync(path)) await Bun.write(path, bytes);
  return path;
}

/**
 * Every name this version of red-dev can produce.
 *
 * Used to tell a retired image from one somebody chose by hand: the
 * sweep below deletes the first and doctor reports it, while a wallpaper
 * outside red-dev's own directory is a decision and is left alone.
 */
export async function expectedWallpaperNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const slug of THEME_SLUGS) {
    const bytes = await Bun.file(EMBEDDED[slug]).bytes();
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 8);
    names.add(`${slug}-${digest}.png`);
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

async function setWindows(path: string, p: Platform): Promise<boolean> {
  let winPath = path;
  let shell = "powershell.exe";

  if (p.env === "wsl") {
    // The desktop belongs to the host, so the image has to live
    // somewhere the host can read and be named the way it expects.
    const toWin = Bun.spawn(["wslpath", "-w", path], { stdout: "pipe", stderr: "ignore" });
    winPath = (await new Response(toWin.stdout).text()).trim();
    if ((await toWin.exited) !== 0 || !winPath) return false;
    shell = Bun.which("powershell.exe") ?? "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  }

  return await run([shell, "-NoProfile", "-NonInteractive", "-Command", windowsScript(winPath)]);
}

export async function applyWallpaper(
  theme: Theme,
  key: string,
  p: Platform,
): Promise<boolean> {
  // A headless server has no desktop to put an image on.
  if (p.env === "server") return false;

  const path = await materialise(theme, key, p);

  if (p.env === "desktop") return await setGnome(path);
  if (p.os === "windows" || p.env === "wsl") return await setWindows(path, p);
  return false;
}

/**
 * Which image the desktop is currently pointed at, as the OS records it.
 * Read from the source of truth rather than from what red-dev last
 * wrote, so a wallpaper changed by hand — or one left pointing at a
 * deleted file — is visible to `doctor`.
 */
export async function wallpaperPathInUse(p: Platform): Promise<string | null> {
  if (p.os === "windows") {
    const proc = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-Command",
        "(Get-ItemProperty 'HKCU:\\Control Panel\\Desktop' -Name WallPaper).WallPaper",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out || null;
  }

  if (p.env === "wsl") {
    const shell =
      Bun.which("powershell.exe") ??
      "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    const proc = Bun.spawn(
      [
        shell,
        "-NoProfile",
        "-Command",
        "(Get-ItemProperty 'HKCU:\\Control Panel\\Desktop' -Name WallPaper).WallPaper",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const winPath = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) !== 0 || !winPath) return null;
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
