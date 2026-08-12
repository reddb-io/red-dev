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

import { removeTemp, tempDir } from "./temp.ts";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";
import { CURSOR } from "./terminal-cursor.ts";

/**
 * Scheme names red-dev used to write, and now removes.
 *
 * A .lnk keeps its hotkey and a settings.json keeps its schemes: neither
 * disappears because the code that wrote it did. These are the display
 * names of the ten omakub-derived themes, and a machine that passed
 * through several is carrying one entry per theme it ever wore.
 *
 * A literal list rather than a lookup into THEMES, because these are
 * history. The point of the list is to survive the themes being deleted.
 */
const LEGACY_WT_SCHEMES = new Set([
  "Tokyo Night",
  "Catppuccin Macchiato",
  "Gruvbox Dark",
  "Everforest",
  "Kanagawa",
  "Matte Black",
  "Nord",
  "Osaka Jade",
  "Ristretto",
  "Rose Pine",
  // The fixed palette that replaced the ten, and lasted one release.
  // red-dev does not colour a terminal at all now — see .red/adr/0003 —
  // so this joins the list it was written to clean up.
  "RedDB",
]);

/**
 * Resolve a Windows interop binary without trusting PATH.
 *
 * PATH is not dependable here: `sudo -u` resets the environment and
 * strips the /mnt/c entries WSL injects, and upstream omakub's config
 * discards them outright. WSL always mounts the Windows drive at the
 * same place, so fall back to the absolute path rather than failing on
 * a machine that plainly has the binary.
 */
function interopBin(name: string): string {
  if (Bun.which(name)) return name;
  const absolute = `/mnt/c/Windows/System32/${name}`;
  return existsSync(absolute) ? absolute : name;
}

/** Windows PowerShell, from either side of the boundary. */
function powershellBin(): string {
  if (process.platform === "win32") return "powershell.exe";
  return (
    Bun.which("powershell.exe") ??
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
  );
}

async function capture(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new RedError(`${cmd[0]} exited ${code}`);
  return out.trim();
}

async function run(cmd: string[]): Promise<void> {
  // Through spawnLogged rather than inheriting: this scope runs inside
  // the fullscreen converge, and a child writing to the terminal there
  // paints over the frame the renderer owns.
  const { spawnLogged } = await import("./providers.ts");
  const code = await spawnLogged(cmd);
  if (code !== 0) throw new RedError(`${cmd[0]} exited ${code}`);
}

/**
 * Ask Windows for its own %LOCALAPPDATA% and translate it to a WSL
 * path. Guessing /mnt/c/Users/<name> breaks for redirected profiles,
 * non-C: installs and domain accounts.
 */
export async function windowsLocalAppData(): Promise<string> {
  return await windowsDir("LOCALAPPDATA");
}

/**
 * The roaming half of the same question, for the config Windows programs
 * keep there.
 *
 * Here rather than in alacritty.ts, where two copies of it used to live:
 * the boundary crossing is this module's subject, and a cached crossing
 * spelled twice is a cache that is only warm for one of the callers.
 */
export async function windowsAppData(): Promise<string> {
  return await windowsDir("APPDATA");
}

/**
 * One of Windows' own directories, as this side spells it.
 *
 * Through the record in windows-env.ts, because the answer is a fact
 * about the machine rather than about the run and asking costs a console
 * program started through interop — which, from a process with no
 * console of its own, is a window on somebody's screen. The Redwall
 * timer is that process, every two minutes.
 */
async function windowsDir(name: "APPDATA" | "LOCALAPPDATA"): Promise<string> {
  // On native Windows the variable is simply ours; cmd.exe and wslpath
  // are WSL-crossing tools that do not exist there.
  if (process.platform === "win32") {
    const own = process.env[name];
    if (!own) throw new RedError(`${name} is not set`);
    return own;
  }

  const { rememberedWindowsDir } = await import("./windows-env.ts");
  return await rememberedWindowsDir(name, async () => {
    const raw = await capture([interopBin("cmd.exe"), "/c", `echo %${name}%`]);
    // cmd emits CRLF and may prefix a warning when cwd is a UNC path.
    const winPath = raw.split("\n").pop()?.trim().replace(/\r$/, "") ?? "";
    if (!/^[A-Za-z]:\\/.test(winPath)) {
      throw new RedError(`could not read %${name}% from Windows (got: ${raw})`);
    }
    return await capture(["wslpath", "-u", winPath]);
  });
}

/**
 * The Windows profile, spelled the way Windows spells it.
 *
 * Deliberately not translated to a unix path the way
 * windowsLocalAppData is: the shared root is stored in the one form both
 * environments can agree on, and each side translates for itself. Handing
 * a /mnt/c path to the thing whose whole job is to be OS-neutral would
 * bake one side's view into the record.
 */
export async function windowsUserProfile(): Promise<string> {
  if (process.platform === "win32") {
    const home = process.env["USERPROFILE"];
    if (!home) throw new RedError("USERPROFILE is not set");
    return home;
  }

  const raw = await capture([interopBin("cmd.exe"), "/c", "echo %USERPROFILE%"]);
  const winPath = raw.split("\n").pop()?.trim().replace(/\r$/, "") ?? "";
  if (!/^[A-Za-z]:\\/.test(winPath)) {
    throw new RedError(`could not read %USERPROFILE% from Windows (got: ${raw})`);
  }
  return winPath;
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

// ----------------------------------------------------- runtime dir

/**
 * What XDG_RUNTIME_DIR is actually doing on this machine.
 *
 * Split from the effectful half so the three cases can be tested without
 * a systemd, a uid or a real /run.
 */
export type RuntimeDirState = "unset" | "usable" | "unusable";

/**
 * `ownerUid` is the directory's owner, or null when it does not exist.
 *
 * Ownership rather than existence, because the failure this guards
 * against is a path that resolves to something we cannot write into. A
 * runtime dir belonging to another uid is as useless as an absent one.
 */
export function runtimeDirState(
  dir: string | undefined,
  ownerUid: number | null,
  selfUid: number,
): RuntimeDirState {
  if (!dir) return "unset";
  if (ownerUid === null) return "unusable";
  return ownerUid === selfUid ? "usable" : "unusable";
}

function ownerUid(dir: string): number | null {
  try {
    return statSync(dir).uid;
  } catch {
    return null;
  }
}

/**
 * Make XDG_RUNTIME_DIR real, because WSL exports it without creating it.
 *
 * With systemd enabled, WSL puts XDG_RUNTIME_DIR=/run/user/<uid> in the
 * environment of every shell. Nothing creates that directory:
 * systemd-logind makes it when a login session opens, and `wsl.exe`
 * starts the shell without going through PAM, so `loginctl
 * list-sessions` reports none and the path never appears.
 *
 * An exported variable pointing at nothing is worse than an unset one.
 * Programs that would have fallen back to /tmp instead trust the
 * variable and try to create the directory, whose parent /run/user is
 * root-owned — so they do not get ENOENT and a fallback, they get EACCES
 * and a crash. zellij is the one that shows up first here, since
 * config/bash/zellij.sh starts it for every interactive shell: it
 * panics, and because that script deliberately does not `exec`, the
 * terminal silently comes up as a plain shell with no multiplexer and no
 * explanation.
 *
 * enable-linger is the durable half: a lingering user gets user@<uid>.service,
 * and the runtime dir with it, at boot and without a session. The mkdir is
 * the fallback for a machine where logind will not do it, and repairs the
 * running boot either way.
 */
export async function ensureUserRuntimeDir(): Promise<void> {
  const dir = process.env["XDG_RUNTIME_DIR"];
  const uid = process.getuid?.() ?? -1;

  if (runtimeDirState(dir, dir ? ownerUid(dir) : null, uid) === "unset") {
    // Nothing points anywhere, so nothing is broken: callers fall back
    // to /tmp on their own.
    log.skip("XDG_RUNTIME_DIR not set — nothing to repair");
    return;
  }

  const path = dir as string;
  if (runtimeDirState(path, ownerUid(path), uid) === "usable") {
    log.skip(`user runtime dir present (${path})`);
    return;
  }

  log.step(`XDG_RUNTIME_DIR points at ${path}, which does not exist — repairing`);

  const user = process.env["USER"] ?? userInfo().username;
  const linger = Bun.spawn(["sudo", "loginctl", "enable-linger", user], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await linger.exited;

  if (runtimeDirState(path, ownerUid(path), uid) !== "usable") {
    await run(["sudo", "mkdir", "-p", path]);
    await run(["sudo", "chown", `${uid}:${process.getgid?.() ?? uid}`, path]);
    await run(["sudo", "chmod", "700", path]);
  }

  if (runtimeDirState(path, ownerUid(path), uid) === "usable") {
    log.ok(`user runtime dir ready (${path}) — zellij can start`);
  } else {
    throw new RedError(`could not create ${path}; zellij will not start`);
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
export async function installNerdFont(key: string, platform?: Platform): Promise<void> {
  if (platform?.os === "linux" && platform.env === "desktop") {
    await installLinuxNerdFont(key);
    return;
  }

  await installWindowsNerdFont(key);
}

async function installWindowsNerdFont(key: string): Promise<void> {
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

  // Files present is not the same as font usable: a mis-registered
  // install leaves twelve .ttf files that no application can see. Skip
  // the 26 MB download in that case, but always re-run registration,
  // which is idempotent and costs a second.
  const installedProbe = `${fontDir}/${spec.asset}NerdFontMono-Regular.ttf`;
  if (existsSync(installedProbe)) {
    log.skip(`${spec.family} files present — re-registering`);
    await registerFontsOnWindows(spec.asset);
    await ensureFontVisible(spec);
    return;
  }

  const url = await ghAsset("ryanoasis/nerd-fonts", `${spec.asset}.zip`);
  log.step(`nerd font: ${spec.asset} -> ${spec.family}`);

  // This was /tmp plus `rm` and `mkdir`, and native Windows has none of
  // the three. nerd-font failed there with
  // `Executable not found in $PATH: "rm"` — reported as the font's
  // failure rather than as red-dev's plumbing.
  const tmp = tempDir(`font-${spec.asset}`);

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
  }

  await registerFontsOnWindows(spec.asset);
  removeTemp(tmp);
  log.ok(`${spec.family} installed (${faces.length} faces)`);
  await ensureFontVisible(spec);
}

export function linuxFontProbeArgv(family: string): string[] {
  return ["fc-match", "--format", "%{family}\n", family];
}

async function fontVisibleToLinux(family: string): Promise<boolean> {
  try {
    const out = await capture(linuxFontProbeArgv(family));
    return out
      .split(",")
      .map((part) => part.trim())
      .includes(family);
  } catch {
    return false;
  }
}

async function installLinuxNerdFont(key: string): Promise<void> {
  const spec = NERD_FONTS[key];
  if (!spec) {
    throw new RedError(
      `unknown font '${key}' (known: ${Object.keys(NERD_FONTS).join(", ")})`,
    );
  }

  if (await fontVisibleToLinux(spec.family)) {
    log.skip(`${spec.family} visible to fontconfig`);
    return;
  }

  const url = await ghAsset("ryanoasis/nerd-fonts", `${spec.asset}.zip`);
  log.step(`nerd font: ${spec.asset} -> ${spec.family}`);

  // This was /tmp plus `rm` and `mkdir`, and native Windows has none of
  // the three. nerd-font failed there with
  // `Executable not found in $PATH: "rm"` — reported as the font's
  // failure rather than as red-dev's plumbing.
  const tmp = tempDir(`font-${spec.asset}`);

  const res = await fetch(url);
  if (!res.ok) throw new RedError(`font download failed ${res.status}`);
  await Bun.write(`${tmp}/font.zip`, res);
  await run(["unzip", "-qo", `${tmp}/font.zip`, "-d", tmp]);

  const fontDir = `${process.env["HOME"] ?? ""}/.local/share/fonts/red-dev/${spec.asset}`;
  rmSync(fontDir, { recursive: true, force: true });
  mkdirSync(fontDir, { recursive: true });

  const listing = await capture(["find", tmp, "-name", "*.ttf", "-type", "f"]);
  const wanted = /NerdFontMono-(Regular|Bold|Italic|BoldItalic)\.ttf$/;
  const faces = listing.split("\n").filter((f) => wanted.test(f));
  if (faces.length === 0) {
    throw new RedError(`no Mono faces found in ${spec.asset}.zip`);
  }

  for (const face of faces) {
    const base = face.split("/").pop() ?? "";
    copyFileSync(face, `${fontDir}/${base}`);
  }

  await run(["fc-cache", "-f", fontDir]);
  removeTemp(tmp);

  if (!(await fontVisibleToLinux(spec.family))) {
    throw new RedError(`${spec.family} installed but fontconfig cannot resolve it`);
  }
  log.ok(`${spec.family} installed (${faces.length} faces)`);
}

/**
 * Whether Windows applications can resolve a family by name.
 *
 * The only question that matters. Files on disk and registry entries are
 * both necessary and neither is sufficient, so ask the font stack itself
 * the same question Alacritty asks when it opens.
 */
async function fontVisibleToWindows(family: string): Promise<boolean> {
  try {
    const out = await capture(windowsFontProbeArgv(family));
    return /^[1-9]/.test(out.split("\n").pop()?.trim() ?? "");
  } catch {
    // A check that cannot run is not evidence the font is missing.
    return true;
  }
}

export function windowsFontProbeArgv(family: string): string[] {
  return [
    powershellBin(),
    "-NoProfile",
    "-Command",
    "Add-Type -AssemblyName System.Drawing; " +
      "(New-Object System.Drawing.Text.InstalledFontCollection).Families | " +
      `Where-Object { $_.Name -eq '${family.replace(/'/g, "''")}' } | ` +
      "Measure-Object | Select-Object -ExpandProperty Count",
  ];
}

/**
 * Make sure the font the terminal is about to be pointed at actually
 * resolves, and escalate when it does not.
 *
 * A per-user install is the polite one: no administrator, no UAC prompt,
 * and on most machines the font is live for applications started
 * afterwards. On some it never becomes visible — Entra-joined machines
 * have been seen ignoring HKCU font registrations across a full sign-out
 * — and the symptom is the terminal refusing to start with a missing
 * font. Files present, registry correct, nothing works.
 *
 * So the polite install is treated as an attempt rather than a result:
 * verify, and if Windows still cannot see the family, install for the
 * whole machine instead. That needs consent, which is why it is not the
 * first move.
 */
async function ensureFontVisible(spec: NerdFontSpec): Promise<void> {
  if (await fontVisibleToWindows(spec.family)) {
    log.ok(`${spec.family} visible to Windows applications`);
    return;
  }

  log.warn(
    `${spec.family} is registered for this user but no application can see it`,
  );
  log.step("installing for the whole machine — Windows will ask for consent");

  if (
    (await installFontsMachineWide(spec.asset)) &&
    (await fontVisibleToWindows(spec.family))
  ) {
    log.ok(`${spec.family} installed machine-wide`);
    return;
  }

  log.warn(
    `${spec.family} still invisible. Open %LOCALAPPDATA%\\Microsoft\\Windows\\Fonts, ` +
      `select the ${spec.asset}NerdFontMono-*.ttf files, right-click and choose ` +
      `"Install for all users", then restart the terminal.`,
  );
}

/**
 * Copy the already-downloaded faces into the system font store and
 * register them under HKLM. Requires elevation, so it runs through
 * Start-Process -Verb RunAs and reports back through a file: an elevated
 * child is a separate process tree whose stdout does not come home.
 *
 * The per-user font directory doubles as the staging area — the download
 * has already put the faces there. The per-user copies and their HKCU
 * entries are left alone: they are inert once the machine-wide install
 * takes over, and removing a font is not something a repair should do.
 */
async function installFontsMachineWide(assetPrefix: string): Promise<boolean> {
  const localAppData = await windowsLocalAppData();
  const scriptPath = `${localAppData}/Temp/red-dev-fonts-machine.ps1`;
  const resultPath = `${localAppData}/Temp/red-dev-fonts-machine.log`;
  removeTemp(resultPath);

  const script = machineWideFontScript(assetPrefix, await toWindowsPath(resultPath));
  await Bun.write(scriptPath, script);
  const winScript = await toWindowsPath(scriptPath);

  try {
    // -Wait so the check below runs after the elevated child, not
    // beside it. A declined UAC prompt throws here and leaves no
    // result file, which is the same answer either way.
    await run([
      powershellBin(),
      "-NoProfile",
      "-Command",
      "Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden " +
        `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${winScript}'`,
    ]);
  } catch {
    log.warn("elevation declined — the font stays per-user");
    return false;
  } finally {
    removeTemp(scriptPath);
  }

  if (!existsSync(resultPath)) return false;
  const outcome = (await Bun.file(resultPath).text()).trim();
  removeTemp(resultPath);
  if (!outcome.startsWith("installed")) {
    log.warn(`machine-wide font install ${outcome}`);
    return false;
  }
  return true;
}

/**
 * The elevated half, as text.
 *
 * Separated from running it because the running needs a UAC prompt and a
 * reboot's worth of state, and the text is the part that can be wrong in
 * a way no one notices: a doubled backslash or an escaped `$` produces a
 * script that parses, does nothing, and reports success.
 */
export function machineWideFontScript(assetPrefix: string, resultPath: string): string {
  return `
$ErrorActionPreference = 'Stop'
$result = '${resultPath.replace(/'/g, "''")}'
try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class RedDevFontMachine {
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)]
    public static extern int AddFontResourceW(string lpFileName);
    [DllImport("user32.dll", CharSet=CharSet.Auto)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam,
        IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
}
'@

    $src = "$env:LOCALAPPDATA\\Microsoft\\Windows\\Fonts"
    $dst = "$env:SystemRoot\\Fonts"
    $regPath = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"
    $count = 0

    foreach ($f in Get-ChildItem $src -Filter "${assetPrefix}NerdFontMono-*.ttf") {
        $pfc = New-Object System.Drawing.Text.PrivateFontCollection
        $pfc.AddFontFile($f.FullName)
        $family = $pfc.Families[0].Name
        $pfc.Dispose()

        $style = ''
        if ($f.BaseName -match '-(\\w+)$') { $style = $Matches[1] }
        if ($style -eq 'Regular') { $style = '' }
        if ($style -and $family -notmatch [regex]::Escape($style)) {
            $regName = "$family $style (TrueType)"
        } else {
            $regName = "$family (TrueType)"
        }

        $target = Join-Path $dst $f.Name
        Copy-Item $f.FullName $target -Force
        [RedDevFontMachine]::AddFontResourceW($target) | Out-Null
        # Machine-wide entries name the file, not the path: Windows
        # resolves them against the system font directory.
        New-ItemProperty -Path $regPath -Name $regName -Value $f.Name -PropertyType String -Force | Out-Null
        $count++
    }

    $r = [IntPtr]::Zero
    # 0xFFFF = HWND_BROADCAST, 0x001D = WM_FONTCHANGE
    [RedDevFontMachine]::SendMessageTimeout([IntPtr]0xFFFF, 0x001D, [IntPtr]::Zero, [IntPtr]::Zero, 2, 1000, [ref]$r) | Out-Null
    "installed $count" | Set-Content $result
} catch {
    "failed $($_.Exception.Message)" | Set-Content $result
}
`;
}

/** A path Windows can open, from either side of the boundary. */
async function toWindowsPath(p: string): Promise<string> {
  if (process.platform === "win32") return p;
  return await capture(["wslpath", "-w", p]);
}

/**
 * Register copied font files with Windows.
 *
 * Copying the .ttf into the per-user font directory is only half of an
 * install, and the other half has two requirements that are easy to get
 * wrong -- this got both wrong first, and the result was twelve files,
 * twelve registry entries, and a font no application could see:
 *
 *  - The registry value name must be the font's own *family* name plus
 *    style, read out of the file. Naming it after the filename produces
 *    an entry that resolves to nothing.
 *  - AddFontResourceW has to load it into the session, and WM_FONTCHANGE
 *    has to tell running applications. Without those, nothing sees the
 *    font until the next sign-in at best.
 *
 * The script goes to a file rather than a -Command string: it needs a
 * here-string for the P/Invoke definition, and quoting that through two
 * shells is how you get a syntax error that points at the wrong line.
 * ASCII only, for the reason boot.ps1 documents.
 */
async function registerFontsOnWindows(assetPrefix: string): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class RedDevFont {
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)]
    public static extern int AddFontResourceW(string lpFileName);
    [DllImport("user32.dll", CharSet=CharSet.Auto)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam,
        IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
}
'@

$fontDir = "$env:LOCALAPPDATA\\Microsoft\\Windows\\Fonts"
$regPath = "HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"
$count = 0

foreach ($f in Get-ChildItem $fontDir -Filter "${assetPrefix}*.ttf") {
    $pfc = New-Object System.Drawing.Text.PrivateFontCollection
    $pfc.AddFontFile($f.FullName)
    $family = $pfc.Families[0].Name
    $pfc.Dispose()

    $style = ''
    if ($f.BaseName -match '-(\\w+)$') { $style = $Matches[1] }
    if ($style -eq 'Regular') { $style = '' }
    # Several weights carry the weight in the family name already;
    # appending it again would register "Mono Light Light".
    if ($style -and $family -notmatch [regex]::Escape($style)) {
        $regName = "$family $style (TrueType)"
    } else {
        $regName = "$family (TrueType)"
    }

    [RedDevFont]::AddFontResourceW($f.FullName) | Out-Null
    New-ItemProperty -Path $regPath -Name $regName -Value $f.FullName -PropertyType String -Force | Out-Null
    $count++
}

$r = [IntPtr]::Zero
# 0xFFFF = HWND_BROADCAST, 0x001D = WM_FONTCHANGE
[RedDevFont]::SendMessageTimeout([IntPtr]0xFFFF, 0x001D, [IntPtr]::Zero, [IntPtr]::Zero, 2, 1000, [ref]$r) | Out-Null
Write-Output "registered $count"
`;

  const scriptPath = "/tmp/red-dev-fonts.ps1";
  await Bun.write(scriptPath, script);
  const winScript = await toWindowsPath(scriptPath);

  await run([
    powershellBin(),
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    winScript,
  ]);
  removeTemp(scriptPath);
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
  actions?: Record<string, unknown>[];
  [k: string]: unknown;
}

/**
 * Shift+Enter, sent as something a program can actually see.
 *
 * Windows Terminal, like every terminal, sends 0x0D for Enter and 0x0D
 * for Shift+Enter — the modifier never reaches the program. sendInput is
 * how WT is told to send something else, and ESC[13;2u is the same
 * kitty-protocol encoding src/alacritty.ts writes, so both emulators
 * deliver one sequence and config/bash/inputrc.conf binds it once.
 *
 * Written as \u001b so the source carries no control character;
 * JSON.stringify emits it as a real 0x1b byte in settings.json.
 */
const SHIFT_ENTER_ACTION = {
  command: { action: "sendInput", input: "\u001b[13;2u" },
  keys: "shift+enter",
};

/**
 * The image gesture shared with Alacritty and Claude Code on Windows/WSL.
 * Ctrl+Shift+V remains terminal text paste; this sends the raw Ctrl+V byte
 * through to whichever agent owns clipboard-image input.
 */
const ALT_V_ACTION = {
  command: { action: "sendInput", input: "\u0016" },
  keys: "alt+v",
};

function hasKey(a: Record<string, unknown>, wanted: string): boolean {
  const keys = a["keys"];
  return keys === wanted || (Array.isArray(keys) && keys.includes(wanted));
}

export interface WindowsTerminalAgentActions {
  readonly actions: Record<string, unknown>[];
  readonly added: string[];
  readonly conflicts: string[];
}

/** Merge the two cross-agent gestures while treating any occupied key as user-owned. */
export function mergeWindowsTerminalAgentActions(
  current: Record<string, unknown>[] = [],
): WindowsTerminalAgentActions {
  const actions = [...current];
  const added: string[] = [];
  const conflicts: string[] = [];
  for (const wanted of [SHIFT_ENTER_ACTION, ALT_V_ACTION] as const) {
    const existing = actions.find((action) => hasKey(action, wanted.keys));
    if (!existing) {
      actions.push(wanted);
      added.push(wanted.keys);
    } else if (JSON.stringify(existing) !== JSON.stringify(wanted)) {
      conflicts.push(wanted.keys);
    }
  }
  return { actions, added, conflicts };
}

export interface TerminalOptions {
  fontFace: string;
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
  // The cursor, and only the cursor. Set on the profile rather than in a
  // scheme, which is what makes "no scheme" possible at all: cursorColor
  // is a profile setting, so it survives the user picking Campbell, One
  // Half Dark or anything else in the dropdown.
  settings.profiles.defaults["cursorColor"] = CURSOR;
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

  // Retire every scheme red-dev ever wrote, and push nothing back.
  //
  // The filter used to match on the theme's display name, so it only
  // ever removed the scheme it was about to rewrite: every theme a
  // machine had passed through stayed in the list forever. Ten dead
  // schemes is not a functional problem, but it makes the picker a
  // museum of decisions the project has since reversed.
  //
  // Doing it here rather than in a migration also repairs a machine that
  // skipped a release, since it runs on every converge.
  settings.schemes ??= [];
  settings.schemes = settings.schemes.filter(
    (s) => !LEGACY_WT_SCHEMES.has(String(s["name"] ?? "")),
  );

  // And release the profile that was pointed at one of them.
  //
  // Deleting a scheme while profiles.defaults still names it leaves
  // Windows Terminal resolving a scheme that is not there — it falls
  // back, but silently, and the user is left with a colorScheme entry
  // referring to nothing. Only our own names are cleared: a user who has
  // since picked Campbell keeps Campbell.
  const named = String(settings.profiles.defaults["colorScheme"] ?? "");
  if (LEGACY_WT_SCHEMES.has(named)) {
    delete settings.profiles.defaults["colorScheme"];
    log.plain(`       dropped the '${named}' scheme — Windows Terminal's own colours are back`);
  }

  // Agent input gestures, each added only when its key is free.
  const input = mergeWindowsTerminalAgentActions(settings.actions);
  settings.actions = input.actions;
  if (input.added.includes("shift+enter")) {
    log.plain(`       shift+enter sends ESC[13;2u — a newline, not a submit`);
  }
  if (input.added.includes("alt+v")) {
    log.plain(`       alt+v reaches agent image paste; ctrl+shift+v remains text paste`);
  }
  for (const key of input.conflicts) {
    log.skip(`windows terminal: ${key} is already bound to something else — left alone`);
  }

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
