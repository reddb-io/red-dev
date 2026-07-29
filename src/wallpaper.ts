/**
 * Theme-matched wallpapers, generated rather than shipped.
 *
 * Omakub puts a photograph in each theme directory. Copying those
 * raises a licensing question this project cannot answer, and fetching
 * images at apply time would make theming depend on the network and on
 * a published release. Deriving the image from the palette avoids both
 * and guarantees the desktop matches the terminal exactly.
 *
 * The generated files are also committed under assets/wallpapers so
 * they are versioned and reviewable rather than existing only at
 * runtime — see scripts/generate-wallpapers.ts.
 */

import { existsSync, mkdirSync } from "node:fs";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import { encodePng, hexToRgb, type Rgb } from "./png.ts";
import type { Theme } from "./themes.ts";

const WIDTH = 2560;
const HEIGHT = 1440;

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

/**
 * A diagonal gradient from the theme background toward a darkened
 * accent, with a subtle vignette.
 *
 * Deliberately low-contrast: a wallpaper competing with the terminal
 * for attention is worse than no wallpaper. The accent is mixed at low
 * weight so the theme is recognisable without being loud.
 */
export function renderWallpaper(theme: Theme): Uint8Array {
  const bg = hexToRgb(theme.terminal.background);
  const accent = hexToRgb(theme.terminal.blue);
  const deep = mix(bg, { r: 0, g: 0, b: 0 }, 0.35);
  const lift = mix(bg, accent, 0.18);

  const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const maxDist = Math.hypot(cx, cy);

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      // Diagonal position, 0 at top-left to 1 at bottom-right.
      const t = (x / WIDTH + y / HEIGHT) / 2;
      let c = mix(lift, deep, t);

      // Vignette: darken toward the corners so the centre reads calm.
      const d = Math.hypot(x - cx, y - cy) / maxDist;
      c = mix(c, deep, d * 0.25);

      const i = (y * WIDTH + x) * 3;
      pixels[i] = c.r;
      pixels[i + 1] = c.g;
      pixels[i + 2] = c.b;
    }
  }

  return encodePng(WIDTH, HEIGHT, pixels);
}

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
async function wallpaperDir(p: Platform): Promise<string> {
  if (p.env === "wsl") {
    const { windowsLocalAppData } = await import("./wsl.ts");
    return `${await windowsLocalAppData()}/red-dev/wallpapers`;
  }
  return `${home()}/.local/share/red-dev/wallpapers`;
}

/** Write the wallpaper for a theme and return its path on this machine. */
export async function materialise(
  theme: Theme,
  key: string,
  p: Platform,
): Promise<string> {
  const dir = await wallpaperDir(p);
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${key}.png`;
  if (!existsSync(path)) {
    await Bun.write(path, renderWallpaper(theme));
  }
  return path;
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

export async function applyWallpaperLogged(
  theme: Theme,
  key: string,
  p: Platform,
): Promise<void> {
  try {
    if (await applyWallpaper(theme, key, p)) {
      log.ok("wallpaper set");
    } else {
      log.skip("wallpaper: no desktop to set it on");
    }
  } catch (err) {
    log.warn(`wallpaper: ${(err as Error).message}`);
  }
}
