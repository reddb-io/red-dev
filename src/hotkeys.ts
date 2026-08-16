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
 * Every chord is anchored on Alt, which nothing in a terminal workflow
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
 * Which keys they are is not decided here. This module is the Windows
 * adapter for the semantic action registry: it owns how a chord is
 * registered — a .lnk in the Start Menu, byte 21 for elevation — and
 * reads which chord it is from the registry, per ADR 0006.
 *
 * It carries every action that applies to Windows. It started with the
 * two it was migrated with, and the other seven read as chords a person
 * could see in `red-dev keys` and press to no effect — which is worse
 * than no chord, because the viewer had already promised them one.
 */

import { actionById, chordText, parseChord } from "./actions/index.ts";
import type { DriftStatus } from "./drift.ts";
import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";

/**
 * One shortcut, and what it launches.
 *
 * Kept as data so the README and the tests can name them without
 * parsing PowerShell. The resolution — which terminal, which shell,
 * where red-dev itself lives — happens on the Windows side; this is the
 * contract.
 */
export interface Hotkey {
  /** The semantic action this shortcut registers. */
  id: string;
  label: string;
  /** null for a Start Menu entry that deliberately has no key. */
  combo: string | null;
  note: string;
  /**
   * The `red-dev` argv this shortcut runs, for the surfaces red-dev
   * draws itself. Null for the two whose target is a host program.
   */
  command: readonly string[] | null;
}

interface StartMenuEntry {
  id: string;
  /**
   * The .lnk name, when Windows already has one that is not the
   * registry's label. Left off for every shortcut this adapter is the
   * first to write.
   */
  name?: string;
  note: string;
  /** `red-dev <argv>`, for a surface red-dev draws itself. */
  command?: readonly string[];
}

/**
 * The Windows half of the registry — every action that applies here.
 *
 * What an entry is *called* belongs to Windows and stays here:
 * `PowerShell (Administrator)` is the name of a .lnk that already exists
 * on people's machines, not the name of the act — the registry calls
 * that one "Elevated shell", and renaming the file would strand the old
 * one, and its key, on every machine that has it. Nobody has the other
 * seven yet, so those take the registry's own label and name themselves
 * once, in the list that decided the chord.
 *
 * Which key an entry carries belongs to the registry either way, and is
 * read from it rather than repeated here.
 *
 * `agent.multiplex` is deliberately absent, and is the one action that
 * applies to a machine this adapter serves and gets no shortcut. herdr
 * has no stable Windows build — the registry says so by leaving
 * `windows` off its platforms — and it runs inside WSL, where the .lnk
 * this module writes cannot follow it: the same file is written on
 * native Windows hosts, which have no distro to reach into. A key that
 * opens nothing on half the machines it lands on is worse than the
 * viewer saying no shortcut was written, so none is.
 */
const START_MENU: readonly StartMenuEntry[] = [
  { id: "terminal.new", name: "Terminal", note: "bash inside WSL, through Alacritty when it is there" },
  { id: "terminal.elevated", name: "PowerShell (Administrator)", note: "elevated" },
  { id: "menu.open", note: "red-dev's own menu, in a console of its own", command: ["menu"] },
  { id: "keys.viewer", note: "this list, searchable — the remedy ADR 0006 promises", command: ["keys"] },
  { id: "emoji.pick", note: "the picker, which writes the clipboard", command: ["emoji"] },
  { id: "panel.network", note: "network and DNS", command: ["panel", "network"] },
  { id: "panel.audio", note: "what the machine plays and hears", command: ["panel", "audio"] },
  { id: "panel.power", note: "battery, and what drains it", command: ["panel", "power"] },
  { id: "agent.launch", note: "whichever host is the recorded Default agent", command: ["agents", "run"] },
];

/**
 * The actions this adapter carries an entry for, whether or not one came
 * back with a chord.
 *
 * Exported because the keys viewer has to tell two silences apart, and
 * WINDOWS_HOTKEYS cannot: an action that is missing from the list below
 * is one this adapter has never claimed, while an action that is in it
 * and produced no combo is the registry having lost something — the
 * failure `hotkeyFor` throws over. The first is news about a feature
 * that has not landed; the second is a bug. Merging them would report
 * either one as the other.
 */
export const START_MENU_ACTIONS: readonly string[] = START_MENU.map((entry) => entry.id);

export const WINDOWS_HOTKEYS: Hotkey[] = START_MENU.flatMap((entry) => {
  const action = actionById(entry.id);
  const chord = action ? parseChord(action.chord) : null;
  // A Start Menu entry written with no key *clears* the binding on
  // every machine that already had one, so an action that went missing
  // from the registry drops its shortcut rather than unbinding it. The
  // registry test is what keeps that unreachable; this is what it would
  // cost if it ever were not.
  if (!action || !chord) return [];
  return [{
    id: entry.id,
    label: entry.name ?? action.label,
    // Spelled the way Windows has always been given it.
    combo: chordText(chord),
    note: entry.note,
    command: entry.command ?? null,
  }];
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

  // One New-Hot per surface rather than a block each: they are one
  // program with a different subcommand behind it, which is the same
  // reading `firePlan` gives them, and nine hand-written copies is how
  // the tenth arrives pointing at the wrong executable.
  const surfaces = WINDOWS_HOTKEYS.filter((h) => h.command && h.combo)
    .map((h) => `  New-Hot '${h.label}' '${h.combo}' $surface ($surfaceArgs + '${h.command?.join(" ")}') $false`)
    .join("\n");

  // The distro is the only fallback there is, and it exists only when
  // this converge is running inside one. On a native Windows host with
  // no red-dev.exe to be found, `wsl.exe -- red-dev` would be a guess at
  // a distro nobody named, so the shortcuts are skipped — and said to be
  // skipped — rather than written to point at nothing.
  const throughWsl = distro
    ? `
if (-not $surface) {
  $surface = (Join-Path $env:SystemRoot 'System32\\wsl.exe')
  $surfaceArgs = '${d}-- red-dev '
}
`
    : "";

  return `
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\red-dev'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$sh = New-Object -ComObject WScript.Shell

$alacritty = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\\Alacritty\\alacritty.exe'),
  'C:\\Program Files\\Alacritty\\alacritty.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1

# Where red-dev's own surfaces are started from.
#
# boot.ps1 puts the binary in %LOCALAPPDATA%\\red-dev\\bin unless
# RED_DEV_BIN_DIR names somewhere else, and puts that directory on PATH
# — so the two answers between them cover a machine installed either
# way, including one whose PATH this PowerShell has not picked up yet.
$reddevDir = if ($env:RED_DEV_BIN_DIR) { $env:RED_DEV_BIN_DIR } else { (Join-Path $env:LOCALAPPDATA 'red-dev\\bin') }
$surface = @(
  (Join-Path $reddevDir 'red-dev.exe'),
  (Get-Command 'red-dev.exe' -ErrorAction SilentlyContinue).Source
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$surfaceArgs = ''
${throughWsl}
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

# The surfaces red-dev draws itself, all through the one binary.
#
# Skipped rather than pointed at nothing when there is no binary to
# name: a .lnk with an empty target is a Start Menu entry that fails
# silently on a key somebody was told works.
if ($surface) {
${surfaces}
} else {
  '(skipped) no red-dev.exe on this host, so the shortcuts for its own surfaces were not written'
}

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
  log.plain("       they fire from normal windows, not while an Administrator window has focus");
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
