/**
 * Platform detection.
 *
 * The support matrix is two axes, not five separate cases:
 *
 *                Ubuntu 24.04   Ubuntu 26.04
 *   desktop      target 1       target 2
 *   wsl          target 4       target 5
 *   windows      target 3 (no distro axis)
 *
 * Everything downstream branches on `env` (where we run) and `caps`
 * (what that place can actually do), never on a raw version string.
 * Adding Ubuntu 28 should mean touching this file and the manifest,
 * nothing else.
 */

import { existsSync, readFileSync } from "node:fs";

export type Os = "linux" | "windows" | "darwin" | "unknown";
export type Env = "desktop" | "wsl" | "server" | "windows";
export type Arch = "x64" | "arm64" | "unsupported";

export interface Capabilities {
  /** apt-get is available (any Ubuntu/Debian target). */
  apt: boolean;
  /** We own a local display, so .deb GUI apps make sense. */
  gui: boolean;
  /** systemd is PID 1 — decides whether we can enable services. */
  systemd: boolean;
  /** winget is reachable, natively or through WSL interop. */
  winget: boolean;
  flatpak: boolean;
}

export interface Platform {
  os: Os;
  distro: string | null;
  version: string | null;
  codename: string | null;
  env: Env;
  arch: Arch;
  caps: Capabilities;
}

function readOsRelease(): Record<string, string> {
  if (!existsSync("/etc/os-release")) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync("/etc/os-release", "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

function detectOs(): Os {
  switch (process.platform) {
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    default:
      return "unknown";
  }
}

function detectArch(): Arch {
  switch (process.arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    default:
      return "unsupported";
  }
}

/**
 * WSL_DISTRO_NAME is the cheap signal, but it is absent under sudo with
 * env_reset, so fall back to the kernel string, which always carries the
 * microsoft tag on both WSL1 and WSL2.
 */
export function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env["WSL_DISTRO_NAME"] || process.env["WSL_INTEROP"]) return true;
  try {
    const rel = readFileSync("/proc/sys/kernel/osrelease", "utf8");
    return /microsoft|wsl/i.test(rel);
  } catch {
    return false;
  }
}

/**
 * A desktop target owns a display and should receive .deb GUI apps.
 * Under WSL the GUI belongs to the Windows host even though WSLg sets
 * DISPLAY, so WSL is deliberately never a GUI target here.
 */
function hasGui(): boolean {
  if (process.platform !== "linux") return false;
  if (isWsl()) return false;
  if (process.env["DISPLAY"] || process.env["WAYLAND_DISPLAY"]) return true;
  return (
    existsSync("/usr/share/xsessions") || existsSync("/usr/share/wayland-sessions")
  );
}

/**
 * Resolve a command on PATH.
 *
 * Do not hand-roll this by stat-ing PATH entries. Commands installed
 * from the Microsoft Store — winget among them — live in WindowsApps as
 * app execution aliases: zero-byte APPEXECLINK reparse points rather
 * than real executables. stat() fails on those, so any existsSync-based
 * lookup reports winget as absent on a machine that plainly has it.
 * where.exe asks the OS resolver and gets the right answer.
 */
function which(cmd: string): boolean {
  if (Bun.which(cmd) !== null) return true;

  if (process.platform === "win32") {
    try {
      const p = Bun.spawnSync(["where.exe", cmd], { stdout: "ignore", stderr: "ignore" });
      return p.exitCode === 0;
    } catch {
      return false;
    }
  }
  return false;
}

/** Exported so the manifest's `cmd` alternatives can be probed the same way. */
export function commandExists(cmd: string): boolean {
  return which(cmd);
}

export function detect(): Platform {
  const os = detectOs();
  const osRelease = os === "linux" ? readOsRelease() : {};

  let env: Env;
  if (os === "windows") env = "windows";
  else if (isWsl()) env = "wsl";
  else if (hasGui()) env = "desktop";
  else env = "server";

  const caps: Capabilities = {
    apt: which("apt-get"),
    gui: env === "desktop",
    // systemd as PID 1. Under WSL this is false unless the user enabled
    // systemd=true in /etc/wsl.conf, which changes whether services can
    // be enabled at all.
    systemd: existsSync("/run/systemd/system"),
    winget: which("winget") || which("winget.exe"),
    flatpak: which("flatpak"),
  };

  return {
    os,
    distro: osRelease["ID"] ?? null,
    version: osRelease["VERSION_ID"] ?? null,
    codename: osRelease["VERSION_CODENAME"] ?? null,
    env,
    arch: detectArch(),
    caps,
  };
}

/** Numeric-aware version compare, so "26.04" > "24.04" and "9" < "10". */
export function versionAtLeast(have: string | null, want: string): boolean {
  if (!have) return false;
  const a = have.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const b = want.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export function summary(p: Platform): string {
  return [
    `os=${p.os} distro=${p.distro ?? "n/a"} version=${p.version ?? "n/a"} env=${p.env} arch=${p.arch}`,
    `caps: apt=${+p.caps.apt} gui=${+p.caps.gui} systemd=${+p.caps.systemd} winget=${+p.caps.winget} flatpak=${+p.caps.flatpak}`,
  ].join("\n");
}
