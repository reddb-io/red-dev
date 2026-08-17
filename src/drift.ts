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
import { missingRights } from "./rights.ts";

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

  // Both directions, because this check inverted.
  //
  // It used to report a missing theme.toml as drift. theme.toml is the
  // twenty-value ANSI palette red-dev no longer writes, so its *presence*
  // is now what needs reporting: a machine that converged before 0.22.0
  // has one, and Alacritty keeps applying it until something removes it.
  const { configDir } = await import("./alacritty.ts");
  try {
    const { configHome: sharedConfigHome } = await import("./shared-root.ts");
    const dir = await configDir(p);
    const sep = p.os === "windows" ? "\\" : "/";
    const shared = `${sharedConfigHome(p, "alacritty")}/alacritty`;
    const stale = [`${dir}${sep}theme.toml`, `${shared}/theme.toml`].find((f) => existsSync(f));

    checks.push(
      stale
        ? {
            name: "alacritty colours",
            status: "drift",
            detail: `theme.toml still sets all sixteen ANSI colours: ${stale}`,
            fix: "red-dev theme <name>",
          }
        : { name: "alacritty colours", status: "ok", detail: "yours" },
    );
  } catch (err) {
    checks.push({
      name: "alacritty colours",
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
    // Inverted for the same reason as alacritty above, with one extra
    // hazard: zellij refuses to start on a theme name it cannot resolve.
    // So a half-swept machine — theme file gone, `theme "red-dev"` still
    // in config.kdl — is not a cosmetic problem, it is a multiplexer that
    // will not open. Report either half being present.
    const themeFile = existsSync(`${zellijDir}/themes/red-dev.kdl`);
    const referenced = /^\s*theme\s+"red-dev"\s*$/m.test(readFileSync(zellijConfig, "utf8"));
    checks.push(
      !themeFile && !referenced
        ? { name: "zellij colours", status: "ok", detail: "yours" }
        : {
            name: "zellij colours",
            status: "drift",
            detail: referenced
              ? 'config.kdl still selects theme "red-dev"'
              : "a red-dev theme file is still in themes/",
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

    // The user layer, which zellij cannot include and red-dev therefore
    // composes into the file above. Only asked when the layer says
    // something: a machine that never touched it composes to red-dev's
    // base byte for byte, and reporting on a file of comments would be
    // reporting on nothing.
    const { ZELLIJ_LAYER_FILE, composeZellijConfig, isComposedZellijConfig } = await import(
      "./zellij-layer.ts"
    );
    const { zellijConfigFor } = await import("./dotfiles.ts");
    const layerPath = `${zellijDir}/${ZELLIJ_LAYER_FILE}`;
    const base = zellijConfigFor(p);
    const composed = composeZellijConfig(base, await readIfExists(layerPath));
    if (composed !== base) {
      // Not "config.kdl differs from what red-dev ships" — after a layer
      // it always does, and that is the point. What is worth reporting
      // is a config.kdl the layer has not reached: either it predates
      // the last edit to the layer, which a converge fixes, or it is a
      // file the person wrote themselves, which a converge deliberately
      // will not touch.
      const regenerable = kdl === base || isComposedZellijConfig(kdl);
      checks.push(
        kdl === composed
          ? { name: "zellij layer", status: "ok", detail: `composed from ${ZELLIJ_LAYER_FILE}` }
          : {
              name: "zellij layer",
              status: "drift",
              detail: regenerable
                ? `config.kdl was written before ${ZELLIJ_LAYER_FILE} last changed`
                : `config.kdl is yours, so ${ZELLIJ_LAYER_FILE} is not composed into it`,
              fix: regenerable
                ? "red-dev install core"
                : `move your edits into ${layerPath}, delete ${zellijConfig}, then re-run \`red-dev install core\``,
            },
      );
    }
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
    const { wallpaperPathInUse, expectedWallpaperNames, wallpaperDir } = await import(
      "./wallpaper.ts"
    );
    const path = await wallpaperPathInUse(p);
    if (!path) return { name: "wallpaper", status: "n/a", detail: "not set" };

    if (!existsSync(path)) {
      return {
        name: "wallpaper",
        status: "drift",
        detail: `points at a missing file: ${path}`,
        fix: "red-dev theme <name>",
      };
    }

    // An image that exists but that red-dev no longer produces.
    //
    // Reported only inside red-dev's own wallpaper directory. A path
    // anywhere else is somebody's own photograph, and calling a
    // deliberate choice "drift" is how a doctor becomes noise. Names are
    // content-addressed, so this also catches an image whose bytes
    // changed under a slug that did not.
    const dir = await wallpaperDir(p);
    const ours = path.replace(/\\/g, "/").startsWith(dir.replace(/\\/g, "/"));
    if (ours) {
      const expected = await expectedWallpaperNames();
      const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
      if (!expected.has(name)) {
        return {
          name: "wallpaper",
          status: "drift",
          detail: `points at a retired image: ${name}`,
          fix: "red-dev theme <name>",
        };
      }
    }

    return { name: "wallpaper", status: "ok", detail: path };
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

/** WSL is a product name; this check makes the required architecture explicit. */
async function checkWslArchitecture(p: Platform): Promise<DriftCheck> {
  if (p.env !== "wsl" && p.os !== "windows") {
    return { name: "wsl architecture", status: "n/a", detail: "not WSL or Windows" };
  }

  try {
    const { detectWsl } = await import("./wsl-provision.ts");
    const state = await detectWsl();
    const currentName = p.env === "wsl" ? process.env["WSL_DISTRO_NAME"] : undefined;
    const distro =
      state.distributions.find((item) => item.name === currentName) ??
      state.distributions.find((item) => item.default) ??
      state.distributions[0];

    if (!distro) {
      return { name: "wsl architecture", status: "n/a", detail: "no distro installed" };
    }
    if (distro.version === 2) {
      return { name: "wsl architecture", status: "ok", detail: `${distro.name} uses WSL 2` };
    }
    if (distro.version === 1) {
      return {
        name: "wsl architecture",
        status: "drift",
        detail: `${distro.name} uses WSL 1; red-dev requires WSL 2`,
        fix:
          p.os === "windows"
            ? "red-dev wsl"
            : `from PowerShell: wsl --set-version ${distro.name} 2`,
      };
    }
    return {
      name: "wsl architecture",
      status: "drift",
      detail: `cannot verify whether ${distro.name} uses WSL 2`,
      fix: "wsl --update, then red-dev doctor",
    };
  } catch (err) {
    return { name: "wsl architecture", status: "n/a", detail: (err as Error).message };
  }
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
  // Absent means enabled: rc.sh defaults RED_BLE to 1, so only an
  // explicit 0 is an opt-out.
  return process.env["RED_BLE"] !== "0"
    ? { name: "ble.sh", status: "ok", detail: "enabled" }
    : {
        name: "ble.sh",
        status: "n/a",
        detail: "installed but disabled by RED_BLE=0",
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
 * Whether the marketplace reads the version this machine resolved.
 *
 * This check used to read the other way round, and was right to: a
 * directory registration meant a host frozen at its install-day
 * snapshot, re-reading an unchanged tree and writing a fresh timestamp
 * over it. Seen at 3.3.0 against 3.3.7 upstream, reporting "Updated
 * today".
 *
 * mise moves the directory now. Where red-dev has a checkout it is the
 * declared owner of the registration, so a host still pointed at GitHub
 * is one the standalone installer got to last — it will keep resolving
 * whatever is published rather than the version this machine pinned.
 *
 * With no checkout there is nothing red-dev owns here, and the
 * standalone registration is the only one on the machine. That is not
 * drift; it is the supported install mode, and saying otherwise would
 * send an operator to fix a machine that is working.
 */
async function checkRedSkillsSource(): Promise<DriftCheck> {
  if (!Bun.which("claude")) {
    return { name: "red-skills", status: "n/a", detail: "claude not installed" };
  }
  try {
    const { sourceRoot } = await import("./red-skills-ext.ts");
    const source = sourceRoot();
    if (source === null) {
      return { name: "red-skills", status: "n/a", detail: "no managed checkout to register" };
    }

    const { claudeRegistration, registrationIsOurs } = await import(
      "./red-skills-registration.ts"
    );
    const home = (process.env["HOME"] ?? process.env["USERPROFILE"] ?? "").replace(/\\/g, "/");
    const registration = await claudeRegistration(home);
    if (registration === null) {
      return { name: "red-skills", status: "n/a", detail: "no marketplace registered" };
    }
    if (registrationIsOurs(registration, source)) {
      return { name: "red-skills", status: "ok", detail: `registered from ${source}` };
    }
    return {
      name: "red-skills",
      status: "drift",
      detail:
        registration.kind === "github"
          ? "marketplace tracks GitHub — this machine resolves red-skills through mise, and red-dev owns the registration"
          : `marketplace is registered from ${registration.source}, which nothing advances`,
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
  checks.push(await checkWslArchitecture(p));
  checks.push(checkWslInterop(p));
  checks.push(await checkFont(p));
  checks.push(await checkWslDistro(p));
  checks.push(await checkRedSkillsSource());
  // The Default agent is deliberately not here. It is one of three
  // things doctor says about this machine's agent posture, and the other
  // two — host freshness, per-provider usage — have no home in
  // configuration drift; reporting the choice twice under two headings
  // is how a reader ends up wondering which line is the real one. See
  // src/agent-posture.ts.
  checks.push(await checkDelta());
  checks.push(await checkRuntimes());
  checks.push(await checkDocker(p));
  checks.push(await checkToolchainParity(p));
  checks.push(await checkBlesh());
  checks.push(await checkSharedRoot(p));
  checks.push(await checkHotkeys(p));
  checks.push(await checkPrivilegedWork(p));
  return checks;
}

/**
 * The shortcut exists — but does the key still reach it?
 *
 * Writing the .lnk was treated as the whole job, and it is only half.
 * The file keeps its HotKey property forever; the *registration* is
 * Explorer's and happens at runtime, first come first served. Anything
 * that starts earlier and claims Ctrl+Alt+T takes it, Explorer's claim
 * fails, and the shortcut goes dead with no error anywhere — converge
 * still reports it written, because it is.
 *
 * The probe can prove the dead case and not the stolen one: Windows
 * answers "somebody holds this" and never says who. So a free key is
 * reported as drift, and a held key is reported as ok with the caveat
 * stated rather than implied.
 */
async function checkHotkeys(p: Platform): Promise<DriftCheck> {
  const name = "windows hotkeys";

  if (p.env !== "wsl" && p.env !== "windows") {
    return { name, status: "n/a", detail: "a Windows host claims these" };
  }

  const { WINDOWS_HOTKEYS, probeHotkeys, hotkeyVerdict } = await import("./hotkeys.ts");
  const states = await probeHotkeys(p);
  const claimed = WINDOWS_HOTKEYS.filter((h) => h.combo);

  const dead: string[] = [];
  let unknown = 0;
  for (const h of claimed) {
    const state = states[h.combo as string] ?? "unknown";
    if (state === "unknown") unknown++;
    // Shortcut presence is not re-checked here: installWindowsHotkeys
    // writes them and its own step reports failure. What it cannot see
    // is whether the key was accepted afterwards.
    else if (hotkeyVerdict(true, state) === "drift") dead.push(h.combo as string);
  }

  if (unknown === claimed.length) {
    return { name, status: "n/a", detail: "could not ask Windows which keys are taken" };
  }
  if (dead.length > 0) {
    return {
      name,
      status: "drift",
      detail: `${dead.join(", ")} registered by nothing — the shortcut will not fire`,
      fix: "restart Explorer, then: red-dev install desktop",
    };
  }
  return {
    name,
    status: "ok",
    // The caveat earns its place in a health report: a held key that
    // "does not work" is, more often than not, being pressed while an
    // elevated window has focus. Explorer registers these hotkeys at
    // medium integrity, and Windows does not deliver input across an
    // integrity boundary (UIPI) — so from Administrator: PowerShell,
    // which is exactly where people test right after installing, the
    // key does nothing and everything is working as registered.
    detail:
      `${claimed.length} claimed and held (Windows does not say by whom) — ` +
      `note: they do not fire while an elevated window has focus`,
  };
}

/**
 * Whether a privileged item's work is actually on the machine.
 *
 * Three values because two would have to lie. "unknown" is the answer
 * whenever the question could not be put — no host to ask, a probe that
 * failed, an item this build has no way to verify — and collapsing it
 * into either of the others turns a doctor into a guess: fold it into
 * "unfinished" and every machine that cannot be asked grows a permanent
 * warning, fold it into "finished" and the one failure this exists to
 * catch is the one it reports as fine.
 */
export type PrivilegedState = "finished" | "unfinished" | "unknown";

/** What each privileged item reports, by tool name. */
export type PrivilegedStates = Record<string, PrivilegedState>;

const PRIVILEGED = "administrator work";

/**
 * The verdict on privileged work, from names and states alone. PURE.
 *
 * Separated from the asking so the reporting can be pinned without a
 * Windows host, and because the two halves fail differently: a probe
 * breaks when a machine changes, this breaks when the wording does.
 *
 * Every outstanding item is named. The converge already reported a
 * count — "1 warning" — and the whole cost of that is the reader going
 * back through a transcript to learn which of thirty-six items it was.
 */
export function privilegedDrift(items: string[], states: PrivilegedStates): DriftCheck {
  if (items.length === 0) {
    // Every Ubuntu target lands here, and it is not an absence of
    // information: apt goes through sudo, which is its own path with its
    // own outcome, so there is genuinely nothing on this machine waiting
    // on administrator.
    return { name: PRIVILEGED, status: "n/a", detail: "nothing here needs administrator" };
  }

  const inState = (state: PrivilegedState): string[] =>
    items.filter((item) => (states[item] ?? "unknown") === state);
  const unfinished = inState("unfinished");
  const finished = inState("finished");
  const unknown = inState("unknown");

  if (unfinished.length > 0) {
    return {
      name: PRIVILEGED,
      status: "drift",
      detail: `${unfinished.join(", ")} — administrator work a converge left unfinished`,
      // Asked for, not written. The operator read this sentence once
      // already, in the converge that stopped at the item; wording it
      // differently here would read as a second, unrelated problem.
      fix: missingRights("administrator").remedy,
    };
  }

  if (finished.length === 0) {
    return {
      name: PRIVILEGED,
      status: "n/a",
      detail: `could not ask this machine about ${unknown.join(", ")}`,
    };
  }

  return {
    name: PRIVILEGED,
    status: "ok",
    detail:
      unknown.length === 0
        ? `${finished.join(", ")} — done`
        : `${finished.join(", ")} done; could not ask about ${unknown.join(", ")}`,
  };
}

/**
 * How each privileged item answers for itself, by tool name.
 *
 * A registry rather than a branch, and loaded per item rather than up
 * front, because the module behind each entry is a platform adapter that
 * a machine without that platform must never import to find out it has
 * nothing to do. An item with no entry answers "unknown" — the honest
 * result for a build that cannot verify it, and one that shows up in the
 * report as unasked rather than as either verdict.
 */
const PRIVILEGED_PROBES: Record<string, () => Promise<(p: Platform) => Promise<PrivilegedState>>> =
  {
    "ssh-server": async () => (await import("./ssh-server.ts")).probeSshServer,
  };

/**
 * Exported for the converge's privileged batch, which asks the same
 * question for a different reason: the doctor reports what is
 * outstanding, the batch decides what to ask consent for. Asking it
 * twice would be two registries, and the one that only runs on Windows
 * is the copy that would quietly stop matching.
 */
export async function probePrivileged(
  items: string[],
  p: Platform,
): Promise<PrivilegedStates> {
  const states: PrivilegedStates = {};
  for (const item of items) {
    const load = PRIVILEGED_PROBES[item];
    if (!load) {
      states[item] = "unknown";
      continue;
    }
    try {
      states[item] = await (await load())(p);
    } catch {
      // A probe that threw answered nothing, which is a state we have.
      states[item] = "unknown";
    }
  }
  return states;
}

/**
 * What this target needs administrator for, and how much of it is done.
 *
 * The item list comes from the manifest's declarations, so it is the
 * same set `plan` announces before a converge starts — a machine cannot
 * be told one thing beforehand and reported against another afterwards.
 *
 * `states` is injectable for tests only; nothing in the product passes
 * it. An empty plan short-circuits before any probe runs, which is what
 * keeps this free on the majority of machines.
 */
export async function checkPrivilegedWork(
  p: Platform,
  states?: PrivilegedStates,
): Promise<DriftCheck> {
  const { itemsNeedingAdmin } = await import("./manifest.ts");
  const items = itemsNeedingAdmin(p).map((t) => t.name);
  if (items.length === 0) return privilegedDrift([], {});
  return privilegedDrift(items, states ?? (await probePrivileged(items, p)));
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

  const { sharedRootFor, sharedTools } = await import("./shared-root.ts");
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

  // sharedTools, not adoptableTools: alacritty's config is written
  // straight into the share and has no ~/.config original to adopt, so
  // listing only the adoptable ones reported "sharing zellij, atuin,
  // bat" over a directory that also held the theme, font and keys the
  // terminal was reading at that moment.
  const cfg = `${root.local}/config`;
  const shared = sharedTools().filter(
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
