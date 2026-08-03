/**
 * Getting WSL onto a fresh Windows machine.
 *
 * Until now `boot.ps1` on a clean Windows produced the native target
 * and stopped: Git Bash, winget packages, no Linux. That is a defensible
 * setup and it is not what most people running this actually want —
 * the WSL target is the one this project exercises hardest, and a user
 * had to know to go and install WSL themselves before they could reach
 * it.
 *
 * The awkward part is real and cannot be engineered away: `wsl
 * --install` needs Administrator, usually needs a reboot, and the
 * distro's own first launch asks for a username and password that only
 * a human can answer. So this does not pretend to be one command. It
 * detects, explains exactly what will happen, asks, and then tells the
 * user precisely where they are in a multi-step process.
 */

import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import { readWindowsOutput } from "./windows-output.ts";

export interface WslState {
  /** The WSL feature is present and usable. */
  available: boolean;
  /** Distro names already installed. */
  distros: string[];
  /** Installed distros, including the WSL architecture when Windows reports it. */
  distributions: WslDistribution[];
  detail: string;
}

export interface WslDistribution {
  name: string;
  default: boolean;
  /** Null only on an old WSL build that cannot report verbose state. */
  version: 1 | 2 | null;
}

async function capture(cmd: string[]): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await readWindowsOutput(proc.stdout);
  const code = await proc.exited;
  return { out, code };
}

/** Parse decoded `wsl -l -v` output, tolerating the old NUL-separated form too. */
export function parseWslVerbose(out: string): WslDistribution[] {
  const lines = out
    .replace(/\0/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const distributions: WslDistribution[] = [];
  for (const line of lines) {
    const isDefault = line.startsWith("*");
    const columns = line.replace(/^\*\s*/, "").split(/\s{2,}/);
    const version = Number(columns.at(-1));
    if ((version !== 1 && version !== 2) || columns.length < 3) continue;
    distributions.push({
      name: columns.slice(0, -2).join("  ").trim(),
      default: isDefault,
      version,
    });
  }
  return distributions;
}

/**
 * What WSL looks like right now.
 *
 * `wsl -l -v` writes UTF-16LE when redirected. `capture` decodes that
 * Windows boundary before this function parses the architecture column.
 */
export async function detectWsl(): Promise<WslState> {
  const wsl = process.platform === "win32" ? "wsl.exe" : "wsl.exe";
  const verbose = await capture([wsl, "-l", "-v"]);

  if (verbose.code === 0) {
    const distributions = parseWslVerbose(verbose.out);
    return {
      available: true,
      distros: distributions.map((distro) => distro.name),
      distributions,
      detail:
        distributions.length > 0
          ? `${distributions.length} distro(s) installed`
          : "WSL is enabled but has no distro",
    };
  }

  // Old inbox WSL builds do not support `--verbose`. They can still be
  // detected, but the architecture stays unknown and red-dev will not
  // silently claim they are WSL 2.
  const { out, code } = await capture([wsl, "-l", "-q"]);

  if (code !== 0) {
    return {
      available: false,
      distros: [],
      distributions: [],
      detail: "the WSL feature is not enabled on this machine",
    };
  }

  const distros = out
    .replace(/\0/g, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  return {
    available: true,
    distros,
    distributions: distros.map((name, index) => ({
      name,
      default: index === 0,
      version: null,
    })),
    detail: distros.length > 0 ? `${distros.length} distro(s) installed` : "WSL is enabled but has no distro",
  };
}

/** Make every future distro choose the WSL 2 architecture. */
export async function setWsl2Default(): Promise<boolean> {
  log.step("WSL 2: setting the default architecture for new distros");
  const proc = Bun.spawn(["wsl.exe", "--set-default-version", "2"], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });
  const code = await proc.exited;
  if (code !== 0) {
    log.err(`wsl --set-default-version 2 exited ${code}`);
    return false;
  }
  log.ok("WSL 2 is the default for new distros");
  return true;
}

/** Convert one stopped distro after the user has accepted the migration cost. */
export async function convertDistroToWsl2(distro: string): Promise<boolean> {
  log.step(`WSL 2: converting ${distro}`);
  const proc = Bun.spawn(["wsl.exe", "--set-version", distro, "2"], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    log.err(`wsl --set-version ${distro} 2 exited ${code}`);
    return false;
  }

  const observed = (await detectWsl()).distributions.find((item) => item.name === distro);
  if (observed?.version !== 2) {
    log.err(`Windows did not report ${distro} as WSL 2 after conversion`);
    return false;
  }
  log.ok(`${distro} now uses WSL 2`);
  return true;
}

/** Is this process elevated? `wsl --install` will not work without it. */
export async function isElevated(): Promise<boolean> {
  const { out } = await capture([
    "powershell.exe",
    "-NoProfile",
    "-Command",
    "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())" +
      ".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
  ]);
  return out.trim().toLowerCase() === "true";
}

/**
 * Install WSL and a distro.
 *
 * Deliberately not silent. This is the one operation here that can
 * demand a reboot, and a user who does not know that will think it
 * hung or failed.
 */
export async function installWsl(distro = "Ubuntu-24.04"): Promise<boolean> {
  if (!(await isElevated())) {
    log.err("installing WSL needs Administrator");
    log.plain("     Open PowerShell as Administrator and run:");
    log.plain(`       wsl --install -d ${distro}`);
    log.plain("     Then re-run red-dev. It will pick up from there.");
    return false;
  }

  // `wsl --install` defaults to WSL 2 on current Windows releases, but
  // make the invariant explicit so an older machine or previous user
  // preference cannot silently create a WSL 1 distro.
  if (!(await setWsl2Default())) {
    log.err("refusing to install a distro without confirming WSL 2 as the default");
    return false;
  }

  log.step(`wsl --install -d ${distro}`);
  log.plain("     This enables the Windows feature, downloads the kernel and");
  log.plain("     the distro. Windows may require a reboot before it finishes.");

  const proc = Bun.spawn(["wsl.exe", "--install", "-d", distro], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const code = await proc.exited;

  if (code !== 0) {
    log.err(`wsl --install exited ${code}`);
    return false;
  }

  log.ok("WSL installed");
  return true;
}

/**
 * What the user has to do next, spelled out.
 *
 * The distro's first launch asks for a username and password, and
 * nothing can answer that for them. Saying so beats leaving them at a
 * prompt they did not expect.
 */
export function explainNextSteps(distro: string): void {
  log.plain("");
  log.step("Next, in order:");
  log.plain(`     1. Reboot if Windows asked for one.`);
  log.plain(`     2. Launch ${distro} once. It will ask you to choose a`);
  log.plain(`        username and password — that is the distro's own setup,`);
  log.plain(`        not red-dev's, and only you can answer it.`);
  log.plain(`     3. Inside that distro, run:`);
  log.plain(`          curl -fsSL https://raw.githubusercontent.com/reddb-io/red-dev/main/boot.sh | sh`);
  log.plain("");
  log.plain("     That second run is what installs the Linux side: the shell,");
  log.plain("     the tools, and the terminal configuration on this Windows host.");
}

/**
 * Offer WSL during a Windows first run.
 *
 * Returns whether anything was done, so the caller can decide what to
 * print afterwards.
 */
export async function offerWsl(p: Platform): Promise<boolean> {
  if (p.os !== "windows") return false;

  const { confirm, select } = await import("./ui.ts");
  const state = await detectWsl();

  if (state.distros.length > 0) {
    const preferred = state.distributions.find((distro) => distro.default) ?? state.distributions[0]!;
    await setWsl2Default();

    if (preferred.version === 2) {
      log.skip(`WSL 2 already set up: ${preferred.name}`);
      return false;
    }

    if (preferred.version === null) {
      log.warn(`cannot verify the WSL version for ${preferred.name}`);
      log.plain("     Update WSL, then run `red-dev wsl` again. red-dev will not assume WSL 2.");
      return false;
    }

    log.warn(`${preferred.name} is using WSL 1; red-dev targets WSL 2`);
    log.plain("     Conversion can take time. Back up important distro files first.");
    if (!(await confirm(`Convert ${preferred.name} to WSL 2 now?`, false))) return false;
    return await convertDistroToWsl2(preferred.name);
  }

  log.plain("");
  log.step("This machine has no WSL distro.");
  log.plain("     red-dev supports Windows natively — Git Bash, winget packages,");
  log.plain("     the same dotfiles. But the Linux side is a separate target, and");
  log.plain("     most people running this want both.");
  log.plain("");

  const choice = await select(
    "Set up WSL as well?",
    [
      "Yes — install Ubuntu-24.04 (needs Administrator, may reboot)",
      "No — native Windows only",
    ] as const,
    "No — native Windows only",
  );

  if (choice.startsWith("No")) {
    log.skip("staying native-only; run `red-dev` again later to change your mind");
    return false;
  }

  if (!state.available) {
    log.plain("");
    log.warn("The WSL feature itself is not enabled yet.");
    if (!(await confirm("Enable it and install Ubuntu-24.04?", false))) return false;
  }

  const ok = await installWsl("Ubuntu-24.04");
  if (ok) explainNextSteps("Ubuntu-24.04");
  return ok;
}
