/**
 * The WSL scope: runs inside the distro but acts on the Windows host.
 *
 * This scope exists because under WSL the terminal, the fonts and the
 * GUI belong to Windows, not to Ubuntu. Installing a Nerd Font into the
 * distro accomplishes nothing — the glyphs are drawn by the terminal
 * emulator on the other side of the boundary. Without this, `eza
 * --icons` and the prompt render as empty boxes and the
 * same-experience claim is simply false.
 *
 * Reaching the host depends on the /mnt/c entries WSL injects into
 * PATH. Upstream omakub replaces PATH wholesale and destroys them,
 * which is why config/bash/path.sh prepends instead.
 */

import { existsSync } from "node:fs";
import { log, RedError } from "./log.ts";
import { THEMES, type Theme } from "./themes.ts";

async function capture(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new RedError(`${cmd[0]} exited ${code}`);
  return out.trim();
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  const code = await proc.exited;
  if (code !== 0) throw new RedError(`${cmd[0]} exited ${code}`);
}

/**
 * Ask Windows for its own %LOCALAPPDATA% and translate it to a WSL
 * path. Guessing /mnt/c/Users/<name> breaks for redirected profiles,
 * non-C: installs and domain accounts.
 */
export async function windowsLocalAppData(): Promise<string> {
  // On native Windows the variable is simply ours; cmd.exe and wslpath
  // are WSL-crossing tools that do not exist there.
  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"];
    if (!local) throw new RedError("LOCALAPPDATA is not set");
    return local;
  }

  const raw = await capture(["cmd.exe", "/c", "echo %LOCALAPPDATA%"]);
  // cmd emits CRLF and may prefix a warning when cwd is a UNC path.
  const winPath = raw.split("\n").pop()?.trim().replace(/\r$/, "") ?? "";
  if (!/^[A-Za-z]:\\/.test(winPath)) {
    throw new RedError(`could not read %LOCALAPPDATA% from Windows (got: ${raw})`);
  }
  return await capture(["wslpath", "-u", winPath]);
}

// ---------------------------------------------------------- interop

/**
 * Keep Windows interop alive under systemd.
 *
 * Enabling systemd in /etc/wsl.conf has a side effect nobody warns you
 * about: systemd-binfmt clears binfmt_misc on boot and re-registers
 * only what /etc/binfmt.d/ declares. WSL's own WSLInterop entry is not
 * there, so it silently disappears and every .exe stops working with
 * "cannot execute binary file: Exec format error" — winget.exe,
 * explorer.exe, cmd.exe, all of it.
 *
 * That breaks the entire premise of the WSL scope, which exists to act
 * on the host. Declaring the entry makes it survive.
 */
export async function ensureWslInterop(): Promise<void> {
  if (existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")) {
    log.skip("WSL interop registered");
    return;
  }

  log.step("registering WSLInterop with binfmt_misc");
  const entry = ":WSLInterop:M::MZ::/init:PF";

  await run(["sudo", "mkdir", "-p", "/etc/binfmt.d"]);
  await run([
    "sudo",
    "sh",
    "-c",
    `printf '%s\\n' '${entry}' > /etc/binfmt.d/WSLInterop.conf`,
  ]);

  // Apply now rather than waiting for the next boot.
  const restart = Bun.spawn(["sudo", "systemctl", "restart", "systemd-binfmt"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await restart.exited;

  if (!existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")) {
    await run([
      "sudo",
      "sh",
      "-c",
      `printf '%s\\n' '${entry}' > /proc/sys/fs/binfmt_misc/register`,
    ]);
  }

  if (existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")) {
    log.ok("WSL interop restored");
  } else {
    throw new RedError("could not register WSLInterop; .exe calls will fail");
  }
}

// ------------------------------------------------------------ fonts

export interface NerdFontSpec {
  /** Release asset base name, e.g. "FiraCode". */
  asset: string;
  /** Font family as applications see it, e.g. "FiraCode Nerd Font Mono". */
  family: string;
}

export const NERD_FONTS: Record<string, NerdFontSpec> = {
  firacode: { asset: "FiraCode", family: "FiraCode Nerd Font Mono" },
  jetbrainsmono: { asset: "JetBrainsMono", family: "JetBrainsMono Nerd Font Mono" },
  hack: { asset: "Hack", family: "Hack Nerd Font Mono" },
  caskaydiacove: { asset: "CascadiaCode", family: "CaskaydiaCove Nerd Font Mono" },
};

async function ghAsset(repo: string, name: string): Promise<string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  const token = process.env["GITHUB_TOKEN"];
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers,
  });
  if (!res.ok) throw new RedError(`GitHub API ${res.status} for ${repo}`);

  const body = (await res.json()) as { assets?: { name: string; browser_download_url: string }[] };
  const hit = (body.assets ?? []).find((a) => a.name === name);
  if (!hit) {
    throw new RedError(
      `no asset named '${name}' in latest ${repo} release. Available:\n` +
        (body.assets ?? []).map((a) => `  ${a.name}`).join("\n"),
    );
  }
  return hit.browser_download_url;
}

/**
 * Install a Nerd Font into the Windows *user* font store. Per-user
 * install needs no administrator rights: copy the files under
 * %LOCALAPPDATA%\Microsoft\Windows\Fonts and register each face under
 * HKCU. Both halves are required — a file the registry does not know
 * about is invisible to applications.
 */
export async function installNerdFont(key: string): Promise<void> {
  const spec = NERD_FONTS[key];
  if (!spec) {
    throw new RedError(
      `unknown font '${key}' (known: ${Object.keys(NERD_FONTS).join(", ")})`,
    );
  }

  const localAppData = await windowsLocalAppData();
  const fontDir = `${localAppData}/Microsoft/Windows/Fonts`;

  // Only the Mono faces: proportional Nerd Font variants misalign
  // columns in a terminal grid.
  const wanted = /NerdFontMono-(Regular|Bold|Italic|BoldItalic)\.ttf$/;

  const installedProbe = `${fontDir}/${spec.asset}NerdFontMono-Regular.ttf`;
  if (existsSync(installedProbe)) {
    log.skip(`${spec.family} already installed`);
    return;
  }

  const url = await ghAsset("ryanoasis/nerd-fonts", `${spec.asset}.zip`);
  log.step(`nerd font: ${spec.asset} -> ${spec.family}`);

  const tmp = `/tmp/red-dev-font-${spec.asset}`;
  await run(["rm", "-rf", tmp]);
  await run(["mkdir", "-p", tmp]);

  const res = await fetch(url);
  if (!res.ok) throw new RedError(`font download failed ${res.status}`);
  await Bun.write(`${tmp}/font.zip`, res);
  await run(["unzip", "-qo", `${tmp}/font.zip`, "-d", tmp]);

  await run(["mkdir", "-p", fontDir]);

  const listing = await capture(["find", tmp, "-name", "*.ttf", "-type", "f"]);
  const faces = listing.split("\n").filter((f) => wanted.test(f));
  if (faces.length === 0) {
    throw new RedError(`no Mono faces found in ${spec.asset}.zip`);
  }

  for (const face of faces) {
    const base = face.split("/").pop() ?? "";
    await run(["cp", "-f", face, `${fontDir}/${base}`]);

    // The registry value must hold a Windows path, not a WSL one.
    const winFontPath = await capture(["wslpath", "-w", `${fontDir}/${base}`]);
    const faceName = base.replace(/\.ttf$/i, "");
    await run([
      "reg.exe",
      "add",
      "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
      "/v",
      `${faceName} (TrueType)`,
      "/t",
      "REG_SZ",
      "/d",
      winFontPath,
      "/f",
    ]);
  }

  await run(["rm", "-rf", tmp]);
  log.ok(`${spec.family} installed (${faces.length} faces)`);
}

// -------------------------------------------------- windows terminal

const WT_PACKAGE = "Microsoft.WindowsTerminal_8wekyb3d8bbwe";

export async function windowsTerminalSettingsPath(): Promise<string | null> {
  const localAppData = await windowsLocalAppData();
  const p = `${localAppData}/Packages/${WT_PACKAGE}/LocalState/settings.json`;
  return existsSync(p) ? p : null;
}

/**
 * settings.json is JSONC in practice: Windows Terminal itself writes
 * plain JSON, but anything a user has hand-edited may carry comments.
 * Strip them rather than refusing to parse a file we are about to
 * rewrite.
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
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { out += text[i + 1] ?? ""; i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && next === "/") { inLine = true; i++; continue; }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

interface WtProfile {
  guid?: string;
  name?: string;
  source?: string;
  hidden?: boolean;
  startingDirectory?: string;
  [k: string]: unknown;
}

interface WtSettings {
  defaultProfile?: string;
  profiles?: { defaults?: Record<string, unknown>; list?: WtProfile[] };
  schemes?: Record<string, unknown>[];
  [k: string]: unknown;
}

export interface TerminalOptions {
  fontFace: string;
  theme: Theme;
  /**
   * Background opacity, 0–100. Omakub gets this from Alacritty's
   * window.opacity; Windows Terminal spells it `opacity` and needs
   * `useAcrylic` for the blur behind it. 100 disables both rather than
   * writing a no-op transparency that still costs a compositor pass.
   */
  opacity?: number;
  /** WSL distro to make the default profile, e.g. "Ubuntu-24.04". */
  distro?: string;
  /** Home directory inside that distro, used as startingDirectory. */
  home?: string;
}

/**
 * Patch settings.json in place, preserving everything we do not own.
 * The user's keybindings, actions and extra profiles are theirs; we
 * only touch the colour scheme, the font, the default profile and the
 * starting directory. A backup is written first because a malformed
 * settings.json makes Windows Terminal silently fall back to defaults,
 * losing the user's configuration.
 */
export async function configureWindowsTerminal(opts: TerminalOptions): Promise<void> {
  const path = await windowsTerminalSettingsPath();
  if (!path) {
    log.warn("Windows Terminal settings.json not found — is it installed?");
    return;
  }

  const original = await Bun.file(path).text();
  await Bun.write(`${path}.red-dev-backup`, original);

  let settings: WtSettings;
  try {
    settings = JSON.parse(stripJsonComments(original)) as WtSettings;
  } catch (err) {
    throw new RedError(
      `settings.json is not parseable, refusing to overwrite: ${(err as Error).message}`,
    );
  }

  settings.profiles ??= {};
  settings.profiles.defaults ??= {};
  settings.profiles.defaults["colorScheme"] = opts.theme.name;
  settings.profiles.defaults["font"] = {
    ...(settings.profiles.defaults["font"] as Record<string, unknown> | undefined),
    face: opts.fontFace,
  };

  const opacity = opts.opacity ?? 100;
  if (opacity >= 100) {
    delete settings.profiles.defaults["opacity"];
    delete settings.profiles.defaults["useAcrylic"];
  } else {
    settings.profiles.defaults["opacity"] = opacity;
    settings.profiles.defaults["useAcrylic"] = true;
  }

  // Replace our scheme by name; leave any other scheme alone.
  settings.schemes ??= [];
  settings.schemes = settings.schemes.filter((s) => s["name"] !== opts.theme.name);
  settings.schemes.push({ name: opts.theme.name, ...opts.theme.terminal });

  if (opts.distro) {
    const list = settings.profiles.list ?? [];
    const profile = list.find((p) => p.name === opts.distro && p.hidden !== true);
    if (profile?.guid) {
      settings.defaultProfile = profile.guid;
      if (opts.home) {
        // Without this the profile opens in the Windows cwd, which lands
        // you in /mnt/c — the slow path across the 9p boundary.
        profile.startingDirectory = `\\\\wsl.localhost\\${opts.distro}\\${opts.home.replace(/^\//, "").replace(/\//g, "\\")}`;
      }
      log.ok(`default profile: ${opts.distro}`);
    } else {
      log.warn(`no Windows Terminal profile named '${opts.distro}' — default unchanged`);
    }
  }

  await Bun.write(path, JSON.stringify(settings, null, 4) + "\n");
  log.ok(`Windows Terminal configured (backup at ${path}.red-dev-backup)`);
}

// -------------------------------------------------------- entrypoint

export async function applyWslScope(themeKey: string, fontKey: string): Promise<void> {
  const theme = THEMES[themeKey];
  if (!theme) throw new RedError(`unknown theme '${themeKey}'`);
  const font = NERD_FONTS[fontKey];
  if (!font) throw new RedError(`unknown font '${fontKey}'`);

  await installNerdFont(fontKey);
  await configureWindowsTerminal({
    fontFace: font.family,
    theme,
    distro: process.env["WSL_DISTRO_NAME"] ?? undefined,
    home: process.env["HOME"] ?? undefined,
  });
}
