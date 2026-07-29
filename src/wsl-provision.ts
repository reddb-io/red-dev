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

export interface WslState {
  /** The WSL feature is present and usable. */
  available: boolean;
  /** Distro names already installed. */
  distros: string[];
  detail: string;
}

async function capture(cmd: string[]): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { out, code };
}

/**
 * What WSL looks like right now.
 *
 * `wsl -l -q` writes UTF-16 on Windows, so the output arrives with NUL
 * bytes between characters — stripping them is not cosmetic, it is the
 * difference between parsing distro names and parsing nothing.
 */
export async function detectWsl(): Promise<WslState> {
  const wsl = process.platform === "win32" ? "wsl.exe" : "wsl.exe";
  const { out, code } = await capture([wsl, "-l", "-q"]);

  if (code !== 0) {
    return {
      available: false,
      distros: [],
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
    detail: distros.length > 0 ? `${distros.length} distro(s) installed` : "WSL is enabled but has no distro",
  };
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
    log.skip(`WSL already set up: ${state.distros.join(", ")}`);
    return false;
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
