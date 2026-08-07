/**
 * Alacritty configuration.
 *
 * Alacritty is the one terminal with a real build on every target we
 * support, which makes it the only way to get a genuinely identical
 * terminal rather than two that have been tuned to look similar.
 * Windows Terminal support stays for people who prefer it, but this is
 * the path that keeps the promise.
 *
 * The config is split the way omakub splits it — a main file that
 * imports theme and font — so switching a theme rewrites one small file
 * instead of regenerating everything the user might have touched.
 *
 * Under WSL the Alacritty being configured runs on *Windows*: the
 * distro has no display. So the config path resolves to the Windows
 * %APPDATA%, the same boundary crossing the Nerd Font install makes.
 */

import { existsSync, mkdirSync } from "node:fs";
import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";
import { colorsToml } from "./terminal-palette.ts";
import { readWindowsOutput } from "./windows-output.ts";

async function capture(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new RedError(`${cmd[0]} failed`);
  return out.trim();
}

/**
 * Write a file on the Windows side, from inside WSL.
 *
 * Base64 through PowerShell rather than a here-string: the content is
 * TOML full of quotes, backslashes and box-drawing characters, and every
 * quoting scheme that tries to survive both shells eventually meets one
 * it cannot. Encoding sidesteps the question, and UTF-8 without a BOM is
 * what Alacritty expects.
 */
async function writeThroughHost(winPath: string, content: string): Promise<void> {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const script = [
    `$p = '${winPath.replace(/'/g, "''")}'`,
    `$d = Split-Path $p -Parent`,
    `New-Item -ItemType Directory -Force -Path $d | Out-Null`,
    `$b = [Convert]::FromBase64String('${b64}')`,
    `[IO.File]::WriteAllBytes($p, $b)`,
  ].join("; ");
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", script], {
    stdout: "ignore",
    stderr: "pipe",
    stdin: "ignore",
  });
  if ((await proc.exited) !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new RedError(`could not write ${winPath} through Windows: ${err.split("\n")[0] ?? ""}`);
  }
}

/**
 * Read a file from the Windows side, from inside WSL.
 *
 * The mirror of writeThroughHost, and needed for the same reason: under
 * WSL the two sides hold distinct NTFS records for the same path, so
 * reading through /mnt/c answers about a file the Windows Alacritty
 * never opens. Base64 back for the same quoting reasons.
 */
async function readThroughHost(winPath: string): Promise<string | null> {
  const script = [
    `$p = '${winPath.replace(/'/g, "''")}'`,
    `if (-not (Test-Path $p)) { exit 2 }`,
    `[Convert]::ToBase64String([IO.File]::ReadAllBytes($p))`,
  ].join("; ");
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) return null;
  return Buffer.from(out, "base64").toString("utf8");
}

/**
 * Does the host see this file?
 *
 * Asked of Windows rather than of /mnt/c, because on this machine those
 * two answer differently about the same path — which is the whole reason
 * the writes moved.
 */
async function hostFileExists(winPath: string): Promise<boolean> {
  const script = `if (Test-Path -LiteralPath '${winPath.replace(/'/g, "''")}') { 'yes' } else { 'no' }`;
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) return false;
  return out.includes("yes");
}

/** The Windows spelling of the Alacritty config directory. */
async function windowsConfigDir(): Promise<string> {
  const cmdExe = Bun.which("cmd.exe") ?? "/mnt/c/Windows/System32/cmd.exe";
  const raw = await capture([cmdExe, "/c", "echo %APPDATA%"]);
  const winPath = raw.split("\n").pop()?.trim().replace(/\r$/, "") ?? "";
  if (!/^[A-Za-z]:\\/.test(winPath)) {
    throw new RedError(`could not read %APPDATA% from Windows (got: ${raw})`);
  }
  return `${winPath}\\alacritty`;
}

/** Where Alacritty reads its config on the machine that will run it. */
export async function configDir(p: Platform): Promise<string> {
  if (p.os === "windows") {
    const appData = process.env["APPDATA"];
    if (!appData) throw new RedError("APPDATA is not set");
    return `${appData}\\alacritty`;
  }

  if (p.env === "wsl") {
    // The terminal lives on the host, so its config does too. Resolve
    // cmd.exe by absolute path when PATH has been stripped — `sudo -u`
    // does exactly that.
    const cmdExe = Bun.which("cmd.exe") ?? "/mnt/c/Windows/System32/cmd.exe";
    const raw = await capture([cmdExe, "/c", "echo %APPDATA%"]);
    const winPath = raw.split("\n").pop()?.trim().replace(/\r$/, "") ?? "";
    if (!/^[A-Za-z]:\\/.test(winPath)) {
      throw new RedError(`could not read %APPDATA% from Windows (got: ${raw})`);
    }
    return `${await capture(["wslpath", "-u", winPath])}/alacritty`;
  }

  const home = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!home) throw new RedError("neither HOME nor USERPROFILE is set");
  return `${home}/.config/alacritty`;
}

function fontToml(family: string, size: number): string {
  return `# Generated by red-dev.

[font]
size = ${size}

[font.normal]
family = '${family}'
style = 'Regular'

[font.bold]
family = '${family}'
style = 'Bold'

[font.italic]
family = '${family}'
style = 'Italic'
`;
}

/**
 * The shell Alacritty should launch.
 *
 * Never PowerShell: bash on all five targets is what makes the shipped
 * dotfiles apply, and that is the whole point of standardising. The
 * remaining question — WSL or Git Bash — is a recorded preference
 * rather than a side effect of where the last converge ran.
 */
async function shellToml(p: Platform): Promise<string> {
  // A Linux desktop just runs the login shell; there is no boundary to
  // pick a side of.
  if (p.os !== "windows" && p.env !== "wsl") {
    return "# Generated by red-dev. No shell override needed on this target.\n";
  }

  const header = `# Generated by red-dev -- which shell Alacritty launches.
#
# Alacritty has no profiles, so one config means one shell. Which one is
# a recorded choice, not an accident of where red-dev last ran:
# change it with \`red-dev shell\`.
`;
  return header + (await shellSectionFor(p));
}

/**
 * The distro WSL would open by default.
 *
 * `wsl -l -q` writes UTF-16LE when redirected, so decode the Windows
 * boundary before treating the result as normal text.
 */
async function defaultWslDistro(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["wsl.exe", "-l", "-q"], { stdout: "pipe", stderr: "ignore" });
    const out = await readWindowsOutput(proc.stdout);
    if ((await proc.exited) !== 0) return null;
    return out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

/**
 * Which shell to launch, from the recorded preference rather than from
 * whichever side of the WSL boundary happens to be running.
 */
async function shellSectionFor(p: Platform): Promise<string> {
  const { resolveTerminalShell, readPreferences } = await import("./preferences.ts");
  const choice = await resolveTerminalShell(p);

  if (choice === "wsl") {
    const prefs = await readPreferences(p);
    // WSL_DISTRO_NAME only exists inside a distro, so on native Windows
    // — where this choice is most likely to be made — both sources were
    // empty and the config silently fell back to Alacritty's default
    // shell after the user had explicitly asked for WSL. Ask WSL itself
    // as the last resort.
    let distro = prefs.distro ?? process.env["WSL_DISTRO_NAME"] ?? undefined;
    if (!distro) distro = (await defaultWslDistro()) ?? undefined;
    if (!distro) {
      log.warn("no WSL distro found; leaving Alacritty on its default shell");
      return "";
    }
    // Start in the distro's home rather than the Windows working
    // directory, which is the slow /mnt/c path.
    return `
[terminal.shell]
program = 'wsl.exe'
args = ['-d', '${distro}', '--cd', '~']
`;
  }

  return gitBashSection();
}

function gitBashSection(): string {
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    log.warn("Git Bash not found; leaving Alacritty on its default shell");
    return "";
  }
  return `
[terminal.shell]
program = '${found.replace(/\\/g, "\\\\")}'
args = ['--login', '-i']
`;
}


/**
 * The keys, in a file red-dev rewrites.
 *
 * Not in alacritty.toml, which is written once and left alone: a
 * binding added in a later version would never reach a machine that had
 * already installed one, which is how the deprecated `import` warning
 * survived two releases. Anything that may need correcting later has to
 * live somewhere regenerated.
 *
 * omakub binds exactly one key here — F11 for fullscreen — and takes
 * Alacritty's defaults for the rest. Those defaults are Ctrl+Shift+C
 * and Ctrl+Shift+V, which is the X11 convention and not what a Windows
 * machine's muscle memory does.
 */
function keysToml(): string {
  return `# Generated by red-dev -- terminal keys.
#
# Paste on both Ctrl+V and Ctrl+Shift+V. Ctrl+V is what every other
# Windows application uses; Ctrl+Shift+V is the terminal convention and
# what Alacritty ships. Binding both costs nothing and means neither
# habit is wrong.
#
# Ctrl+V is safe to take because a terminal's own Ctrl+V — readline's
# quoted-insert, which types the next key literally — is reachable in
# every shell red-dev configures through Ctrl+Q, which readline binds to
# the same command.

[[keyboard.bindings]]
key = 'V'
mods = 'Control'
action = 'Paste'

[[keyboard.bindings]]
key = 'V'
mods = 'Control|Shift'
action = 'Paste'

[[keyboard.bindings]]
key = 'C'
mods = 'Control|Shift'
action = 'Copy'

[[keyboard.bindings]]
key = 'F11'
action = 'ToggleFullscreen'
`;
}

/**
 * The parts that are the same on every machine, so they go in the share.
 *
 * Colours, a font family and a set of key bindings describe a preference
 * and name nothing local. One copy, read by the Alacritty on this
 * machine and by the one on the next.
 */
const SHARED_PARTS = ["theme.toml", "font.toml", "keys.toml"] as const;

/**
 * The part that cannot be shared, and the reason the split exists.
 *
 * shell.toml names `wsl.exe -d Ubuntu-24.04` or a path to bash.exe —
 * it *is* the WSL-or-native choice, written down. Sharing it would make
 * two machines fight over which one they both are.
 */
const LOCAL_PARTS = ["shell.toml"] as const;

/**
 * What alacritty.toml has to import, given where the share is.
 *
 * Absolute Windows paths for the shared parts, because alacritty.exe
 * resolves relative imports against the file's own directory and the
 * share is not there. Spelled in TOML literal strings — single quotes —
 * so the backslashes stay backslashes.
 *
 * A null share is a machine with no second environment to share with,
 * and everything stays beside alacritty.toml exactly as before.
 */
export function requiredImports(shareWinRoot: string | null): string[] {
  const local = [...LOCAL_PARTS];
  if (!shareWinRoot) return [...SHARED_PARTS, ...local];
  const dir = `${shareWinRoot.replace(/[\\/]+$/, "")}\\config\\alacritty`;
  return [...SHARED_PARTS.map((p) => `${dir}\\${p}`), ...local];
}

/** Whether an import entry is one red-dev owns, wherever it points. */
function isOurs(entry: string): boolean {
  const base = entry.split(/[\\/]/).pop() ?? entry;
  return ([...SHARED_PARTS, ...LOCAL_PARTS] as string[]).includes(base);
}

/** Same entries in any order. */
function sameEntries(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

function mainToml(opacity: number, required: string[]): string {
  return `# red-dev — Alacritty.
#
# This file is created once and never rewritten, so it is yours to edit.
# Theme and font live in the imported files, which red-dev regenerates.

[general]
# general.import, not a bare top-level import: Alacritty deprecated the
# latter, and every launch prints
#
#   [WARN] Config warning: import has been deprecated; use general.import
#
# over the terminal before the shell has drawn anything. It still works,
# which is why it went unnoticed — the file red-dev writes is created
# once and never rewritten, so an install from before the rename keeps
# warning until this file is replaced by hand.
import = [
${required.map((i) => `  '${i}',`).join("\n")}
]

[window]
opacity = ${(opacity / 100).toFixed(2)}
padding = { x = 8, y = 8 }
decorations = 'full'
dynamic_padding = true

[scrolling]
history = 50000

[selection]
save_to_clipboard = true

[cursor]
style = { shape = 'Block', blinking = 'Off' }

# Keybindings shared across every target, so the muscle memory is the
# same whichever machine you are on.
[[keyboard.bindings]]
key = 'N'
mods = 'Control|Shift'
action = 'SpawnNewInstance'

[[keyboard.bindings]]
key = 'Equals'
mods = 'Control'
action = 'IncreaseFontSize'

[[keyboard.bindings]]
key = 'Minus'
mods = 'Control'
action = 'DecreaseFontSize'

[[keyboard.bindings]]
key = 'Key0'
mods = 'Control'
action = 'ResetFontSize'
`;
}

/**
 * No `theme`. The colours are fixed now — `colorsToml()` takes no
 * argument — and a field nothing reads is an invitation to pass one.
 */
export interface AlacrittyOptions {
  platform: Platform;
  fontFamily: string;
  fontSize?: number;
  opacity: number;
}

export async function configureAlacritty(opts: AlacrittyOptions): Promise<void> {
  const dir = await configDir(opts.platform);
  // node:fs, not `mkdir -p`: there is no mkdir on native Windows, and
  // shelling out for something the standard library does is how a
  // cross-platform tool ends up only working on the author's machine.
  mkdirSync(dir, { recursive: true });

  const sep = opts.platform.os === "windows" ? "\\" : "/";
  const main = `${dir}${sep}alacritty.toml`;

  // Under WSL these files are written through Windows, not through
  // /mnt/c, and that is not caution — it is a bug this project can
  // otherwise not see.
  //
  // On this machine %APPDATA%\alacritty\alacritty.toml has two distinct
  // NTFS records: Windows FileId 0x1a00000007ebc6, WSL inode
  // 0x1100000007ebf3. Same directory, same name, per-directory case
  // sensitivity disabled, and a full `wsl --shutdown` does not merge
  // them — so it is not a cache, which is what I assumed for two days.
  // A marker appended from Windows was invisible to WSL a second later.
  //
  // Each side reads and writes its own. That means a theme applied from
  // the distro reached a file the Windows Alacritty never opens, and
  // reported success. Writing through the host puts the bytes where the
  // terminal actually looks.
  const viaHost = opts.platform.env === "wsl";

  const winDir = viaHost ? await windowsConfigDir() : null;
  const put = async (name: string, content: string): Promise<void> => {
    if (winDir) await writeThroughHost(`${winDir}\\${name}`, content);
    else await Bun.write(`${dir}${sep}${name}`, content);
  };

  // The share, when this machine has one.
  //
  // Written straight through the filesystem rather than through the
  // host, unlike %APPDATA%\alacritty above: the dual-NTFS-record problem
  // documented there is a property of that directory, not of /mnt/c, and
  // the shared zellij config has been read and written this way from
  // both sides since the share existed.
  const { recordedShareRoot, localPath } = await import("./shared-root.ts");
  const shareWin = recordedShareRoot();
  const shareLocal = shareWin ? localPath(shareWin, opts.platform.env) : null;
  const shared =
    shareWin && shareLocal && existsSync(shareLocal)
      ? { win: shareWin, dir: `${shareLocal}/config/alacritty` }
      : null;

  const putShared = async (name: string, content: string): Promise<void> => {
    if (!shared) return put(name, content);
    mkdirSync(shared.dir, { recursive: true });
    await Bun.write(`${shared.dir}/${name}`, content);
  };

  const required = requiredImports(shared?.win ?? null);

  // theme, font and keys are the same on every machine, so they go to
  // the share when there is one; the main file is written once so a user
  // who tunes padding or bindings does not lose it on every run.
  await putShared("theme.toml", colorsToml());
  await putShared("font.toml", fontToml(opts.fontFamily, opts.fontSize ?? 11));
  await putShared("keys.toml", keysToml());
  // Local and regenerated. Local because it encodes WSL-or-native, which
  // is this machine's answer; regenerated because which shell to launch
  // is red-dev's decision, not a user preference we would be clobbering.
  await put("shell.toml", await shellToml(opts.platform));

  // Existence is asked of the host too, for the same reason: from the
  // distro this file can look absent while Windows has one, or the
  // reverse.
  const mainExists = winDir ? await hostFileExists(`${winDir}\\alacritty.toml`) : existsSync(main);

  if (!mainExists) {
    await put("alacritty.toml", mainToml(opts.opacity, required));
    log.ok(`alacritty: config written to ${winDir ?? dir}`);
    if (shared) log.plain(`       theme, font and keys shared from ${shared.win}`);
    return;
  }

  // Read from whichever side owns the file, repair, write back the same
  // way. Guarding this on `!winDir` is what kept every WSL machine from
  // ever gaining an import added after its config was written.
  const current = winDir
    ? await readThroughHost(`${winDir}\\alacritty.toml`)
    : await Bun.file(main).text();
  const repaired = current === null ? null : repairedImports(current, required);

  if (repaired !== null) {
    await put("alacritty.toml", repaired);
    log.ok(`alacritty.toml: import block repaired — ${required.length} entries`);
    if (shared) log.plain(`       theme, font and keys now read from ${shared.win}`);
  } else {
    log.skip(`alacritty.toml exists — theme, font and keys updated, yours left alone`);
  }
}

/**
 * Move a top-level `import` under `[general]`.
 *
 * "Written once and never rewritten" is the right policy for a file the
 * user is invited to edit, and it has one cost: a key that upstream
 * renames stays wrong forever. Alacritty deprecated the bare `import`,
 * so every launch printed a warning over the terminal before the shell
 * had drawn anything — on a config red-dev itself had written.
 *
 * The narrowest possible edit: only the import block, only when there is
 * no [general] section already, and only when the block is the shape
 * this file writes. Anything else is the user's and is left alone.
 */
export async function migrateImportKey(path: string, required: string[]): Promise<boolean> {
  const repaired = repairedImports(await Bun.file(path).text(), required);
  if (repaired === null) return false;
  await Bun.write(path, repaired);
  return true;
}

/**
 * The repaired file, or null when there was nothing to repair.
 *
 * Pure, and that is the point: the same config has to be repaired from
 * inside WSL, where it is read and written through PowerShell rather
 * than through the filesystem. The first version did the IO itself and
 * was therefore guarded on `!winDir` at its only call site — so the
 * repair never ran on the one target whose config lives on the other
 * side of a boundary, which is the target that needs it most.
 */
export function repairedImports(text: string, required: string[]): string | null {
  const block = /(^\s*\[general\]\r?\n(?:[^[]*?))?^(\s*)import = \[\r?\n([^\]]*?)\r?\n\s*\]/m;
  const m = block.exec(text);
  if (!m) return null;

  const hasGeneral = m[1] !== undefined;
  const listed = (m[3] ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^['"]|['"],?$/g, ""))
    .filter(Boolean);

  // Ours are replaced; theirs are kept.
  //
  // Replaced rather than appended, which the previous version did. Once
  // theme.toml moved into the share, appending the absolute path left
  // the bare `theme.toml` beside it — two imports of the same file, the
  // stale local copy still on disk, and the answer depending on which
  // Alacritty merges last. Ownership is decided by the file name, so a
  // path that moved is still recognised as the entry it replaces.
  //
  // Anything the user added is not ours and survives untouched, which is
  // the property that makes rewriting safe at all here.
  const theirs = listed.filter((e) => !isOurs(e));
  const merged = [...required, ...theirs];

  // Compared as a set, not as a sequence. Our four files touch disjoint
  // keys — colours, font, bindings, shell — so their order decides
  // nothing, and comparing positionally would rewrite the block on every
  // converge just to reorder it.
  if (hasGeneral && sameEntries(merged, listed)) return null;

  const rebuilt = `[general]\nimport = [\n${merged.map((i) => `  '${i}',`).join("\n")}\n]`;
  return text.replace(block, rebuilt);
}
