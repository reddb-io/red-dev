/**
 * Configuration drift.
 *
 * `doctor` used to answer one question: is the binary on PATH. That
 * misses every way a machine goes wrong after a successful install —
 * dotfiles left behind by an upgrade, a theme applied to the terminal
 * but not the multiplexer, a wallpaper pointing at a path that no longer
 * exists, WSL interop silently deregistered by a systemd boot.
 *
 * Each check answers a question a user would otherwise have to ask
 * themselves in the wrong order, and each says what to run when the
 * answer is no.
 */

import { existsSync } from "node:fs";
import type { Platform } from "./platform.ts";

export type DriftStatus = "ok" | "drift" | "n/a";

export interface DriftCheck {
  name: string;
  status: DriftStatus;
  detail: string;
  /** What the user should run. Omitted when there is nothing to do. */
  fix?: string;
}

function home(): string {
  return process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
}

async function readIfExists(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

/**
 * Deployed dotfiles versus the ones inside this binary. An upgraded
 * red-dev with stale files on disk is the drift users hit most, and it
 * is invisible: the shell keeps working, just not the way this version
 * intends.
 */
async function checkDotfiles(): Promise<DriftCheck> {
  const dir = `${home()}/.local/share/red-dev/config/bash`;
  if (!existsSync(dir)) {
    return {
      name: "dotfiles",
      status: "drift",
      detail: "not deployed",
      fix: "red-dev install core",
    };
  }

  const { FILES } = await import("./dotfiles.ts");
  const stale: string[] = [];
  for (const [name, content] of Object.entries(FILES)) {
    const onDisk = await readIfExists(`${dir}/${name}`);
    if (onDisk !== content) stale.push(name);
  }

  return stale.length === 0
    ? { name: "dotfiles", status: "ok", detail: "current" }
    : {
        name: "dotfiles",
        status: "drift",
        detail: `${stale.length} stale: ${stale.join(", ")}`,
        fix: "red-dev install core",
      };
}

async function checkShellWiring(): Promise<DriftCheck> {
  const bashrc = await readIfExists(`${home()}/.bashrc`);
  if (bashrc === null) {
    return { name: "shell wiring", status: "drift", detail: "no ~/.bashrc", fix: "red-dev install core" };
  }
  return bashrc.includes("red-dev/config/bash/rc.sh")
    ? { name: "shell wiring", status: "ok", detail: "~/.bashrc sources red-dev" }
    : {
        name: "shell wiring",
        status: "drift",
        detail: "~/.bashrc does not source red-dev",
        fix: "red-dev install core",
      };
}

async function checkTheme(p: Platform): Promise<DriftCheck[]> {
  const checks: DriftCheck[] = [];

  const { configDir } = await import("./alacritty.ts");
  try {
    const dir = await configDir(p);
    const sep = p.os === "windows" ? "\\" : "/";
    checks.push(
      existsSync(`${dir}${sep}theme.toml`)
        ? { name: "alacritty theme", status: "ok", detail: dir }
        : {
            name: "alacritty theme",
            status: "drift",
            detail: "no theme.toml",
            fix: "red-dev theme <name>",
          },
    );
  } catch (err) {
    checks.push({
      name: "alacritty theme",
      status: "n/a",
      detail: (err as Error).message,
    });
  }

  // zellij's config references theme "red-dev"; if that file is absent
  // the multiplexer starts with a theme it cannot resolve.
  const zellijConfig = `${home()}/.config/zellij/config.kdl`;
  if (existsSync(zellijConfig)) {
    checks.push(
      existsSync(`${home()}/.config/zellij/themes/red-dev.kdl`)
        ? { name: "zellij theme", status: "ok", detail: "resolved" }
        : {
            name: "zellij theme",
            status: "drift",
            detail: 'config.kdl references theme "red-dev" which is not there',
            fix: "red-dev theme <name>",
          },
    );
  }

  return checks;
}

/**
 * A wallpaper set to a path that no longer exists leaves the desktop
 * black with no error anywhere. Under WSL that used to happen whenever
 * the distro was shut down, because the image lived inside it.
 */
async function checkWallpaper(p: Platform): Promise<DriftCheck> {
  if (p.env === "server") {
    return { name: "wallpaper", status: "n/a", detail: "no desktop" };
  }
  try {
    const { wallpaperPathInUse } = await import("./wallpaper.ts");
    const path = await wallpaperPathInUse(p);
    if (!path) return { name: "wallpaper", status: "n/a", detail: "not set" };
    return existsSync(path)
      ? { name: "wallpaper", status: "ok", detail: path }
      : {
          name: "wallpaper",
          status: "drift",
          detail: `points at a missing file: ${path}`,
          fix: "red-dev theme <name>",
        };
  } catch (err) {
    return { name: "wallpaper", status: "n/a", detail: (err as Error).message };
  }
}

function checkWslInterop(p: Platform): DriftCheck {
  if (p.env !== "wsl") {
    return { name: "wsl interop", status: "n/a", detail: "not WSL" };
  }
  return existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")
    ? { name: "wsl interop", status: "ok", detail: "registered" }
    : {
        name: "wsl interop",
        status: "drift",
        detail: "binfmt entry gone — every .exe will fail with an exec format error",
        fix: "red-dev install wsl",
      };
}

async function checkDelta(): Promise<DriftCheck> {
  if (!Bun.which("delta")) {
    return { name: "git pager", status: "n/a", detail: "delta not installed" };
  }
  const proc = Bun.spawn(["git", "config", "--global", "--get", "core.pager"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const pager = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return pager.includes("delta")
    ? { name: "git pager", status: "ok", detail: "delta" }
    : {
        name: "git pager",
        status: "drift",
        detail: `delta is installed but git uses '${pager || "(unset)"}'`,
        fix: "red-dev install core",
      };
}

/**
 * Whether Windows can actually resolve the font the terminal is
 * configured to use. Checking that the .ttf files exist is not enough:
 * a font registered under the wrong name leaves the files in place and
 * every application blind to them, which surfaces only as a terminal
 * error box.
 */
async function checkFont(p: Platform): Promise<DriftCheck> {
  if (p.os !== "windows" && p.env !== "wsl") {
    return { name: "nerd font", status: "n/a", detail: "host font store not applicable" };
  }

  const shell =
    p.os === "windows"
      ? "powershell.exe"
      : (Bun.which("powershell.exe") ??
        "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");

  try {
    const proc = Bun.spawn(
      [
        shell,
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.Drawing; " +
          "(New-Object System.Drawing.Text.InstalledFontCollection).Families | " +
          "Where-Object { $_.Name -like '*Nerd Font Mono' } | " +
          "Select-Object -First 1 -ExpandProperty Name",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const found = (await new Response(proc.stdout).text()).trim();
    await proc.exited;

    return found
      ? { name: "nerd font", status: "ok", detail: found }
      : {
          name: "nerd font",
          status: "drift",
          detail: "no Nerd Font Mono visible to Windows applications",
          fix: "red-dev install wsl",
        };
  } catch (err) {
    return { name: "nerd font", status: "n/a", detail: (err as Error).message };
  }
}

/**
 * Does the toolchain resolve the same way in every shell on this
 * machine?
 *
 * The failure this catches: a tool present in PowerShell and absent in
 * Git Bash. It is invisible from inside either shell — each one is
 * self-consistent — and it surfaces as a script that worked yesterday
 * failing today with "command not found".
 */
async function checkToolchainParity(p: Platform): Promise<DriftCheck> {
  if (p.os !== "windows") {
    return { name: "toolchain parity", status: "n/a", detail: "single shell environment" };
  }
  const { toolchainParity } = await import("./runtimes.ts");
  const problem = await toolchainParity(p);
  return problem === null
    ? { name: "toolchain parity", status: "ok", detail: "Git Bash and PowerShell agree" }
    : {
        name: "toolchain parity",
        status: "drift",
        detail: problem,
        fix: "red-dev install core",
      };
}

async function checkRuntimes(): Promise<DriftCheck> {
  const mise = Bun.which("mise");
  if (!mise) {
    return { name: "runtimes", status: "drift", detail: "mise not on PATH", fix: "red-dev install core" };
  }
  const proc = Bun.spawn([mise, "ls", "--installed"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out
    ? { name: "runtimes", status: "ok", detail: out.split("\n").length + " managed by mise" }
    : {
        name: "runtimes",
        status: "drift",
        detail: "mise manages nothing — a version manager with no versions",
        fix: "red-dev install core",
      };
}

/**
 * Which Docker daemon answers here, and whether there are two.
 *
 * Two daemons on one machine is the case worth catching: every command
 * succeeds, `docker ps` works on both sides and shows different
 * things, and a database started from Windows is simply unreachable
 * from WSL with no error to explain it.
 */
async function checkDocker(p: Platform): Promise<DriftCheck> {
  const { dockerHealth } = await import("./docker.ts");
  const h = await dockerHealth(p);
  return h.ok
    ? { name: "docker", status: "ok", detail: h.detail }
    : { name: "docker", status: "drift", detail: h.detail, ...(h.fix ? { fix: h.fix } : {}) };
}

async function checkBlesh(): Promise<DriftCheck> {
  const { isInstalled } = await import("./blesh.ts");
  if (!isInstalled()) {
    return { name: "ble.sh", status: "n/a", detail: "not installed" };
  }
  return process.env["RED_BLE"] === "1"
    ? { name: "ble.sh", status: "ok", detail: "enabled" }
    : {
        name: "ble.sh",
        status: "n/a",
        detail: "installed but not enabled — export RED_BLE=1 to try it",
      };
}

export async function collectDrift(p: Platform): Promise<DriftCheck[]> {
  const checks: DriftCheck[] = [];
  checks.push(await checkDotfiles());
  checks.push(await checkShellWiring());
  checks.push(...(await checkTheme(p)));
  checks.push(await checkWallpaper(p));
  checks.push(checkWslInterop(p));
  checks.push(await checkFont(p));
  checks.push(await checkDelta());
  checks.push(await checkRuntimes());
  checks.push(await checkDocker(p));
  checks.push(await checkToolchainParity(p));
  checks.push(await checkBlesh());
  return checks;
}
