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
 * The shortcut has to live in the Start Menu for the key to fire, which
 * is why that is where these go.
 *
 * Two keys, both anchored on Alt, which nothing in a terminal workflow
 * competes for. Ctrl+Shift+T is deliberately not among them: it is
 * reopen-closed-tab in every browser, in VS Code and in Windows Terminal
 * itself, and a global hotkey wins over the focused application — so
 * claiming it took that away from the whole machine. It held the
 * elevated PowerShell once; that moved to Ctrl+Alt+Shift+T.
 *
 * Assigning an empty HotKey to an existing .lnk clears its binding,
 * verified on Windows — which is what lets a converge correct a machine
 * that still carries an old one.
 *
 * Which two keys they are is no longer decided here. This module is the
 * Windows adapter for two entries in the semantic action registry: it
 * owns how a chord is registered — a .lnk in the Start Menu, byte 21 for
 * elevation — and reads which chord it is from the registry, per ADR
 * 0006. The keys are the same ones it always wrote.
 */

import { actionById, chordText, parseChord } from "./actions/index.ts";
import type { DriftStatus } from "./drift.ts";
import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";

/**
 * The two, and what each one launches.
 *
 * Kept as data so the README and the tests can name them without
 * parsing PowerShell. The resolution — which terminal, which shell —
 * happens on the Windows side; this is the contract.
 */
export interface Hotkey {
  /** The semantic action this shortcut registers. */
  id: string;
  label: string;
  /** null for a Start Menu entry that deliberately has no key. */
  combo: string | null;
  note: string;
}

/**
 * The Windows half of two registry actions.
 *
 * What the entry is called belongs to Windows and stays here:
 * `PowerShell (Administrator)` is the name of a .lnk that already exists
 * on people's machines, not the name of the act — the registry calls
 * that one "Elevated shell". Which key it carries belongs to the
 * registry, and is read from it rather than repeated here. That is the
 * migration: the values are identical, the source of truth moved.
 */
const START_MENU: readonly { id: string; label: string; note: string }[] = [
  { id: "terminal.new", label: "Terminal", note: "bash inside WSL, through Alacritty when it is there" },
  { id: "terminal.elevated", label: "PowerShell (Administrator)", note: "elevated" },
];

/** An action's chord, spelled the way Windows has always been given it. */
function comboFromRegistry(id: string): string | null {
  const action = actionById(id);
  if (!action) return null;
  const chord = parseChord(action.chord);
  return chord ? chordText(chord) : null;
}

export const WINDOWS_HOTKEYS: Hotkey[] = START_MENU.flatMap((entry) => {
  const combo = comboFromRegistry(entry.id);
  // A Start Menu entry written with no key *clears* the binding on
  // every machine that already had one, so an action that went missing
  // from the registry drops its shortcut rather than unbinding it. The
  // registry test is what keeps that unreachable; this is what it would
  // cost if it ever were not.
  return combo === null ? [] : [{ id: entry.id, label: entry.label, combo, note: entry.note }];
});

/** The entry for an action, or a loud failure rather than a silent unbind. */
function hotkeyFor(id: string): Hotkey & { combo: string } {
  const found = WINDOWS_HOTKEYS.find((h) => h.id === id);
  if (!found || found.combo === null) {
    throw new RedError(`the action registry no longer carries ${id}, so its shortcut cannot be written`);
  }
  return { ...found, combo: found.combo };
}

export type HotkeyState = "held" | "free" | "unknown";

/**
 * Translate a combo into RegisterHotKey's arguments.
 *
 * MOD_ALT 1, MOD_CONTROL 2, MOD_SHIFT 4, MOD_WIN 8. Only the letter keys
 * this project claims are supported, because that is all it claims.
 */
export function hotkeyArgs(combo: string): { mods: number; vk: number } | null {
  const parts = combo.toUpperCase().split("+").map((s) => s.trim()).filter(Boolean);
  let mods = 0;
  let key: string | null = null;
  for (const part of parts) {
    if (part === "ALT") mods |= 1;
    else if (part === "CTRL" || part === "CONTROL") mods |= 2;
    else if (part === "SHIFT") mods |= 4;
    else if (part === "WIN") mods |= 8;
    else if (/^[A-Z]$/.test(part)) key = part;
    else return null;
  }
  if (!key || mods === 0) return null;
  return { mods, vk: key.charCodeAt(0) };
}

/**
 * What a probe result means for a shortcut we wrote.
 *
 * A .lnk carries its hotkey forever, but the *registration* belongs to
 * Explorer and happens at runtime — and RegisterHotKey is first come,
 * first served. An application that starts early and claims Ctrl+Alt+T
 * wins it, Explorer's own claim fails, and the shortcut stops working
 * with nothing anywhere reporting a fault. That is the failure this
 * exists to name.
 *
 * "held" is honestly ambiguous and says so. The API answers "somebody
 * has this", never who, so a working shortcut and a stolen one are
 * indistinguishable from here. "free" is the unambiguous one: our
 * shortcut declares the key, nothing holds it, so nothing will happen
 * when it is pressed.
 */
export function hotkeyVerdict(shortcutExists: boolean, state: HotkeyState): DriftStatus {
  if (!shortcutExists) return "drift";
  if (state === "free") return "drift";
  return "ok";
}

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
export function resolveScript(distro: string | null): string {
  const d = distro ? `-d ${distro} ` : "";
  const terminal = hotkeyFor("terminal.new");
  const elevated = hotkeyFor("terminal.elevated");
  // The post-write probe asks Windows about the terminal key itself, so
  // its modifiers and virtual key come from the same chord the shortcut
  // was written with rather than from a 0x54 nobody would think to
  // change if the chord ever did.
  const probe = hotkeyArgs(terminal.combo);
  if (!probe) throw new RedError(`${terminal.combo} is not a chord Windows can register`);
  return `
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\red-dev'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$sh = New-Object -ComObject WScript.Shell

$alacritty = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\\Alacritty\\alacritty.exe'),
  'C:\\Program Files\\Alacritty\\alacritty.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1

# A hotkey combo reduced to something two spellings can agree on.
#
# Windows re-spells the property on read-back: write CTRL+ALT+T, read
# Alt+Ctrl+T. Verified on this machine, in that order. So a literal
# comparison against what we assign is false on every converge — which
# silently revived the unconditional Save() the comparison was added to
# prevent, and the hotkey went on dying "at random" with the fix
# supposedly shipped. Order and case both have to go.
function Normal($combo) {
  if (-not $combo) { return '' }
  (($combo -split '\\+') | ForEach-Object { $_.Trim().ToUpper() } | Sort-Object) -join '+'
}

$script:wrote = $false

function New-Hot($name, $combo, $target, $argv, $admin) {
  $p = Join-Path $dir "$name.lnk"
  $s = $sh.CreateShortcut($p)

  # Save() only when something actually differs.
  #
  # Explorer registers a Start Menu shortcut's hotkey by scanning the
  # folder, and rewriting the .lnk makes it drop the registration and
  # re-scan. The re-registration is not reliable: often the key is simply
  # gone until the next logon. So an unnecessary write is not a wasted
  # write, it is a good chance of unbinding CTRL+ALT+T.
  $same = ($s.TargetPath -eq $target) -and ($s.Arguments -eq $argv) -and
          ((Normal $s.HotKey) -eq (Normal $combo))
  if ($same -and (Test-Path $p)) {
    if ($combo) { "= $combo -> $name" } else { "= (no hotkey) $name" }
    return
  }

  $s.TargetPath = $target
  $s.Arguments = $argv
  # Assigned including the empty string: only rewriting the property
  # clears a binding a previous version left behind.
  $s.HotKey = $combo
  $s.Save()
  $script:wrote = $true
  if ($admin) {
    # Elevation is a flag in the file format, not a property the COM
    # object exposes.
    $b = [IO.File]::ReadAllBytes($p)
    $b[21] = $b[21] -bor 0x20
    [IO.File]::WriteAllBytes($p, $b)
  }
  if ($combo) { "$combo -> $name" } else { "(no hotkey) $name" }
}

if ($alacritty) {
  New-Hot '${terminal.label}' '${terminal.combo}' $alacritty '' $false
} else {
  New-Hot '${terminal.label}' '${terminal.combo}' (Join-Path $env:SystemRoot 'System32\\wsl.exe') '${d}--cd ~' $false
}

New-Hot '${elevated.label}' '${elevated.combo}' (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') '-NoLogo' $true

# When something was rewritten, make sure the key came back.
#
# A write makes Explorer drop the registration, and waiting for the next
# logon is not an answer anyone accepts — the report that forced this
# was literally "I just lost my Ctrl+Alt+T again". Probe the key; if it
# is free, Explorer lost it, and restarting Explorer makes it re-scan
# the Start Menu now. Windows relaunches Explorer on its own.
#
# Only after a real write, so the steady-state converge — which the
# Normal() comparison above finally makes reachable — never touches
# Explorer at all.
if ($script:wrote) {
  $sig = 'using System; using System.Runtime.InteropServices; public class RedHK { [DllImport("user32.dll", SetLastError=true)] public static extern bool RegisterHotKey(IntPtr h, int id, uint fs, uint vk); [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h, int id); }'
  Add-Type -TypeDefinition $sig
  Start-Sleep -Milliseconds 500
  $free = [RedHK]::RegisterHotKey([IntPtr]::Zero, 9004, ${probe.mods}, 0x${probe.vk.toString(16).toUpperCase()})
  if ($free) {
    [RedHK]::UnregisterHotKey([IntPtr]::Zero, 9004) | Out-Null
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    "explorer restarted so the hotkeys register now rather than at next logon"
  }
}
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
  log.plain("       Ctrl+Alt+T fires from normal windows, not while an Administrator window has focus");
  log.ok(`${lines.length} hotkey(s) in the Start Menu`);
}

/**
 * Ask Windows whether each combo is spoken for.
 *
 * RegisterHotKey succeeding means nobody holds the key, so the probe
 * takes it for an instant and gives it straight back. Failing with 1409
 * — ERROR_HOTKEY_ALREADY_REGISTERED — means somebody does. The API
 * never says who, which is the whole reason a stolen hotkey is so quiet:
 * there is no list to look at and nothing logs the loss.
 *
 * Every other failure is reported as unknown rather than as held. A
 * probe that cannot run is not evidence about the machine, and calling
 * it "held" would turn a broken check into a clean bill of health.
 */
export async function probeHotkeys(p: Platform): Promise<Record<string, HotkeyState>> {
  const out: Record<string, HotkeyState> = {};
  if (p.os !== "windows" && p.env !== "wsl") return out;

  const probes = WINDOWS_HOTKEYS.map((h) => (h.combo ? hotkeyArgs(h.combo) : null));
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RedHK {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
}
"@
${WINDOWS_HOTKEYS.map((h, i) => {
  const a = probes[i];
  if (!h.combo || !a) return "";
  return `if ([RedHK]::RegisterHotKey([IntPtr]::Zero, ${9100 + i}, ${a.mods}, ${a.vk})) {
  [RedHK]::UnregisterHotKey([IntPtr]::Zero, ${9100 + i}) | Out-Null
  '${h.combo}=free'
} else { '${h.combo}=held' }`;
}).join("\n")}
`.trim();

  try {
    const exe = p.os === "windows" ? "powershell.exe" : (Bun.which("powershell.exe") ?? "powershell.exe");
    const proc = Bun.spawn([exe, "-NoProfile", "-Command", script], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const text = (await new Response(proc.stdout).text()).replace(/\r/g, "");
    if ((await proc.exited) !== 0) throw new Error("probe failed");
    for (const line of text.split("\n")) {
      const [combo, state] = line.trim().split("=");
      if (combo && (state === "free" || state === "held")) out[combo] = state;
    }
  } catch {
    // Left empty; the caller reads a missing entry as unknown.
  }

  for (const h of WINDOWS_HOTKEYS) {
    if (h.combo && !(h.combo in out)) out[h.combo] = "unknown";
  }
  return out;
}
