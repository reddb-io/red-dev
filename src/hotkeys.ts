/**
 * Global hotkeys, without a dependency to install first.
 *
 * Windows has no public API for "run this on Ctrl+Alt+T", and the usual
 * answers — AutoHotkey, PowerToys — are another program to install and
 * keep running. There is a native mechanism: a .lnk in the Start Menu
 * carries a HotKey property that the shell honours system-wide, and byte
 * 21 of the file format carries the "run as administrator" flag.
 *
 * Both were verified before this was written, because guessing at
 * Windows shell behaviour is how several earlier bugs here started.
 * Ctrl+Alt+T, Ctrl+Alt+Shift+T and Ctrl+Shift+T are all accepted and
 * stored; the shortcut has to live in the Start Menu for the key to
 * fire, which is why that is where these go.
 */

import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";

/**
 * The three, and what each one launches.
 *
 * Kept as data so the README and the tests can name them without
 * parsing PowerShell. The resolution — which terminal, which shell —
 * happens on the Windows side; this is the contract.
 */
export interface Hotkey {
  label: string;
  combo: string;
  note: string;
}

export const WINDOWS_HOTKEYS: Hotkey[] = [
  { label: "Terminal", combo: "CTRL+ALT+T", note: "Alacritty on the recorded shell, or wsl.exe" },
  { label: "Terminal (Git Bash)", combo: "CTRL+ALT+SHIFT+T", note: "bash on the Windows side" },
  { label: "PowerShell (Administrator)", combo: "CTRL+SHIFT+T", note: "elevated" },
];

/**
 * Everything is resolved on the Windows side, deliberately.
 *
 * The first version asked the running process for %APPDATA% and for
 * whether Alacritty existed. Under WSL that process is Linux: APPDATA is
 * unset and `C:\Program Files\...` is not a path it can stat, so the
 * step failed with "APPDATA is not set" on the one target this feature
 * most exists for. PowerShell is already the thing writing the
 * shortcuts; it can answer both questions itself.
 */
function resolveScript(distro: string | null): string {
  const d = distro ? `-d ${distro} ` : "";
  return `
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\red-dev'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$sh = New-Object -ComObject WScript.Shell

$alacritty = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\\Alacritty\\alacritty.exe'),
  'C:\\Program Files\\Alacritty\\alacritty.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$bash = @(
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1

function New-Hot($name, $combo, $target, $argv, $admin) {
  $p = Join-Path $dir "$name.lnk"
  $s = $sh.CreateShortcut($p)
  $s.TargetPath = $target
  $s.Arguments = $argv
  $s.HotKey = $combo
  $s.Save()
  if ($admin) {
    # Elevation is a flag in the file format, not a property the COM
    # object exposes.
    $b = [IO.File]::ReadAllBytes($p)
    $b[21] = $b[21] -bor 0x20
    [IO.File]::WriteAllBytes($p, $b)
  }
  "$combo -> $name"
}

if ($alacritty) {
  New-Hot 'Terminal' 'CTRL+ALT+T' $alacritty '' $false
} else {
  New-Hot 'Terminal' 'CTRL+ALT+T' (Join-Path $env:SystemRoot 'System32\\wsl.exe') '${d}--cd ~' $false
}

if ($bash) {
  if ($alacritty) {
    New-Hot 'Terminal (Git Bash)' 'CTRL+ALT+SHIFT+T' $alacritty ('-e "' + $bash + '" --login -i') $false
  } else {
    New-Hot 'Terminal (Git Bash)' 'CTRL+ALT+SHIFT+T' $bash '--login -i' $false
  }
}

New-Hot 'PowerShell (Administrator)' 'CTRL+SHIFT+T' (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') '-NoLogo' $true
`.trim();
}

/**
 * Write them, from whichever side of the WSL boundary we are on.
 *
 * The work is PowerShell either way: WScript.Shell creates the .lnk and
 * only Windows can. Under WSL that is reached through interop, the same
 * crossing the font and terminal installs already make.
 */
export async function installWindowsHotkeys(p: Platform): Promise<void> {
  if (p.os !== "windows" && p.env !== "wsl") {
    log.skip("global hotkeys need a Windows host");
    return;
  }

  const script = resolveScript(process.env["WSL_DISTRO_NAME"] ?? null);

  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new RedError(`could not write the shortcuts: ${err.split("\n")[0] ?? "unknown"}`);
  }

  // What PowerShell reports, because it is what actually resolved: the
  // targets depend on what is installed on the host, and only the host
  // can answer that.
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) log.plain(`       ${line}`);
  log.plain("       the elevated one prompts for consent when it opens");
  log.ok(`${lines.length} hotkey(s) in the Start Menu`);
}
