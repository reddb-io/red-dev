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

import { existsSync, readFileSync } from "node:fs";
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

export async function checkTheme(p: Platform): Promise<DriftCheck[]> {
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

  // Asked of the directory zellij will actually open.
  //
  // This read ~/.config/zellij unconditionally, and on a machine with a
  // shared root that is not where zellij looks: shared.sh exports
  // ZELLIJ_CONFIG_DIR at the share, install writes the config there, and
  // ~/.config/zellij keeps whatever was left behind when the share was
  // adopted. Here that was an 87-byte theme stub from July, so doctor
  // reported the theme resolved and the keybindings stale while the
  // 12 KB file zellij was reading was neither. Both verdicts were about
  // a file nothing opens, and the offered fix — delete it and converge —
  // could never clear the warning, because the converge writes to the
  // share and the check would read the stub again.
  const { configHome } = await import("./shared-root.ts");
  const zellijDir = `${configHome(p, "zellij")}/zellij`;
  const zellijConfig = `${zellijDir}/config.kdl`;
  if (existsSync(zellijConfig)) {
    checks.push(
      existsSync(`${zellijDir}/themes/red-dev.kdl`)
        ? { name: "zellij theme", status: "ok", detail: "resolved" }
        : {
            name: "zellij theme",
            status: "drift",
            detail: 'config.kdl references theme "red-dev" which is not there',
            fix: "red-dev theme <name>",
          },
    );

    // A config from before the always-on session leaves zellij holding
    // keys the shell needs, and the way that presents is Ctrl-p doing
    // the wrong thing rather than an error anyone can search for.
    const kdl = readFileSync(zellijConfig, "utf8");
    checks.push(
      /default_mode\s+"locked"/.test(kdl)
        ? { name: "zellij keys", status: "ok", detail: "locked by default" }
        : {
            name: "zellij keys",
            status: "drift",
            detail:
              "config.kdl predates the always-on session — zellij holds Ctrl-p, Ctrl-n, Ctrl-t, Ctrl-o, Ctrl-s",
            fix: `delete ${zellijConfig} and re-run \`red-dev install core\``,
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

/**
 * Whether the distro is running the same red-dev this machine is.
 *
 * Only from Windows, and only when there is a distro. The two halves of
 * a WSL machine drift apart silently — separate homes, separate
 * binaries — and the half you type in is usually the distro, so a
 * Windows converge that reported success can sit next to a terminal
 * three versions behind and nothing anywhere says so.
 */
async function checkWslDistro(p: Platform): Promise<DriftCheck> {
  if (p.os !== "windows") {
    return { name: "wsl distro", status: "n/a", detail: "not the Windows side" };
  }
  try {
    const { defaultDistro, distroVersion } = await import("./wsl-sync.ts");
    const distro = await defaultDistro();
    if (!distro) {
      return { name: "wsl distro", status: "n/a", detail: "no distro installed" };
    }
    const there = await distroVersion(distro);
    const { VERSION } = await import("./cli.ts");
    if (there === VERSION) {
      return { name: "wsl distro", status: "ok", detail: `${distro} on ${VERSION}` };
    }
    return {
      name: "wsl distro",
      status: "drift",
      detail: `${distro} has ${there ?? "no red-dev"}, this side has ${VERSION}`,
      fix: "red-dev install desktop",
    };
  } catch (err) {
    return { name: "wsl distro", status: "n/a", detail: (err as Error).message };
  }
}

/**
 * Whether red-skills can actually receive updates.
 *
 * A marketplace registered against a local directory is the worst kind
 * of wrong: Claude re-reads the snapshot, finds it unchanged, and writes
 * a fresh timestamp — so the machine reports itself current while
 * sitting on whatever version the installer captured. Seen at 3.3.0
 * against 3.3.7 upstream, reporting "Updated today".
 */
async function checkRedSkillsSource(): Promise<DriftCheck> {
  if (!Bun.which("claude")) {
    return { name: "red-skills", status: "n/a", detail: "claude not installed" };
  }
  try {
    const { claudeMarketplaceIsGithub } = await import("./agents.ts");
    const github = await claudeMarketplaceIsGithub();
    if (github === null) {
      return { name: "red-skills", status: "n/a", detail: "no marketplace registered" };
    }
    return github
      ? { name: "red-skills", status: "ok", detail: "tracking reddb-io/red-skills" }
      : {
          name: "red-skills",
          status: "drift",
          detail:
            "marketplace points at a local directory — it reports updates it cannot receive",
          fix: "red-dev install core",
        };
  } catch (err) {
    return { name: "red-skills", status: "n/a", detail: (err as Error).message };
  }
}

export async function collectDrift(p: Platform): Promise<DriftCheck[]> {
  const checks: DriftCheck[] = [];
  checks.push(await checkDotfiles());
  checks.push(await checkShellWiring());
  checks.push(...(await checkTheme(p)));
  checks.push(await checkWallpaper(p));
  checks.push(checkWslInterop(p));
  checks.push(await checkFont(p));
  checks.push(await checkWslDistro(p));
  checks.push(await checkRedSkillsSource());
  checks.push(await checkDelta());
  checks.push(await checkRuntimes());
  checks.push(await checkDocker(p));
  checks.push(await checkToolchainParity(p));
  checks.push(await checkBlesh());
  checks.push(await checkSharedRoot(p));
  return checks;
}

/**
 * Are both sides looking at the same directory?
 *
 * The question you ask when a setting applied on one side does not show
 * up on the other, and it has three distinct wrong answers: no root
 * recorded, a root recorded that is not there, and a root that is there
 * but empty. Reporting them as one "shared root: no" would send you
 * looking in the wrong place for two of the three.
 */
async function checkSharedRoot(p: Platform): Promise<DriftCheck> {
  const name = "shared root";

  if (p.env !== "wsl" && p.env !== "windows") {
    return { name, status: "n/a", detail: "spans WSL and Windows; this machine is neither" };
  }

  const { sharedRootFor, adoptableTools } = await import("./shared-root.ts");
  const root = sharedRootFor(p);
  if (!root) {
    return {
      name,
      status: "n/a",
      detail: "not set up — configuration stays local to each side",
      fix: "red-dev share",
    };
  }

  if (!existsSync(root.local)) {
    // Recorded but unreachable: a drive that did not mount, a profile
    // that moved. rc.sh drops RED_SHARE in this case, so every tool
    // quietly falls back to its own config and nothing says why.
    return {
      name,
      status: "drift",
      detail: `${root.windows} is recorded but not reachable at ${root.local}`,
      fix: "red-dev share <windows-path>",
    };
  }

  // Content, not existence.
  //
  // The first version counted a directory as adopted if it was there —
  // and the share is created with empty zellij/, yazi/ and atuin/
  // directories, so a brand new root reported "sharing starship, mise,
  // zellij, yazi, atuin" when two files had been put in it by hand. A
  // check that answers yes before anything has happened is worse than
  // no check.
  const { readdirSync, statSync } = await import("node:fs");
  const hasContent = (path: string): boolean => {
    if (!existsSync(path)) return false;
    try {
      return statSync(path).isDirectory() ? readdirSync(path).length > 0 : true;
    } catch {
      return false;
    }
  };

  const cfg = `${root.local}/config`;
  const shared = adoptableTools().filter(
    (t) =>
      hasContent(`${cfg}/${t}`) ||
      hasContent(`${cfg}/${t}.toml`) ||
      hasContent(`${cfg}/${t}.conf`) ||
      (t === "git" && hasContent(`${cfg}/gitconfig`)),
  );

  if (shared.length === 0) {
    return {
      name,
      status: "ok",
      detail: `${root.windows} — ready, nothing shared yet`,
      fix: "red-dev share adopt <tool>",
    };
  }

  return { name, status: "ok", detail: `${root.windows} — sharing ${shared.join(", ")}` };
}
