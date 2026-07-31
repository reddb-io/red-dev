/**
 * One directory both environments can reach.
 *
 * The strategy in three lines, because getting the split wrong is what
 * makes this kind of setup rot:
 *
 *   configuration  shared      65 ms vs 22 ms to read twenty files
 *   binaries       co-located  ELF and PE are different formats
 *   source code    never       a build goes from 324 ms to 2726 ms
 *
 * So this creates the tree and records where it is. It deliberately does
 * not move anything into it: a converge that relocated a config the user
 * had edited, on a boundary this fiddly, would be the wrong kind of
 * helpful. `red-dev share adopt <tool>` is the deliberate act.
 */

import { existsSync, mkdirSync } from "node:fs";
import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";

/** The one spelling both sides can agree to store. */
export interface SharedRoot {
  /** As Windows writes it: C:\Users\me\.reddev */
  windows: string;
  /** As the current environment reaches it. */
  local: string;
}

/**
 * Translate the Windows spelling into the one *this binary* can open.
 *
 * There really are three forms, and the mistake worth recording is that
 * they do not all belong here. Git Bash mounts C: at /c, so the shell
 * config needs `/c/Users/...` — but red-dev on Windows is a native
 * process, not a Git Bash one, and handing it that path made it create
 * `C:\c\Users\filip\.reddev`: a whole phantom tree beside the real one,
 * reported as "7 new" on a share that already existed.
 *
 * So this function serves the binary and returns the native path on
 * Windows. The Git Bash spelling is computed in config/bash/rc.sh, in
 * shell, which is the only place that needs it.
 */
export function localPath(windowsPath: string, env: Platform["env"]): string {
  if (env !== "wsl") return windowsPath;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (!m?.[1]) return windowsPath;
  return `/mnt/${m[1].toLowerCase()}/${(m[2] ?? "").replace(/\\/g, "/")}`;
}

/** Where the shared root lives, when one has been chosen. */
export function sharedRootFor(p: Platform): SharedRoot | null {
  const windows = process.env["RED_SHARE_WIN"];
  if (!windows) return null;
  return { windows, local: localPath(windows, p.env) };
}

/**
 * The default, and the reason for it.
 *
 * Inside the profile rather than at C:\reddev: it disappears with the
 * profile when a machine is rebuilt, and it does not add a directory to
 * the root of the system drive.
 */
export function defaultRoot(windowsHome: string): string {
  return `${windowsHome.replace(/[\\/]$/, "")}\\.reddev`;
}

/**
 * Choose the shared root, and record it so a shell can find it.
 *
 * The switch this feature was missing. Everything else was reachable
 * only by exporting RED_SHARE_WIN by hand, which meant it worked in
 * testing and was invisible to anyone actually using it.
 */
export async function chooseSharedRoot(p: Platform, requested?: string): Promise<number> {
  if (p.env !== "wsl" && p.env !== "windows") {
    log.skip("a shared root spans WSL and Windows; this machine is neither");
    return 0;
  }

  const current = process.env["RED_SHARE_WIN"];
  if (!requested && current) {
    log.ok(`shared root is ${current}`);
    log.plain(`       here that is ${localPath(current, p.env)}`);
    log.plain(`       change it with: red-dev share <windows-path>`);
    return 0;
  }

  const root = requested ?? defaultRoot(await windowsHome(p));
  if (!/^[A-Za-z]:[\\/]/.test(root)) {
    throw new RedError(
      `the shared root is stored the way Windows spells it, so it needs a drive letter — got '${root}'`,
    );
  }

  const { recordShellEnv } = await import("./firstrun.ts");
  await recordShellEnv({ RED_SHARE_WIN: root });
  process.env["RED_SHARE_WIN"] = root;
  await ensureSharedRoot(p);

  if (p.os === "windows") await addWindowsBinToPath(root);

  log.ok(`recorded — open a new shell, or: export RED_SHARE_WIN='${root}'`);
  return 0;
}

/**
 * Put the shared Windows bin on the user PATH.
 *
 * The shell gets it from path.sh, which covers Git Bash and WSL. This
 * covers everything else on Windows — PowerShell, and anything launched
 * from Explorer — which read the environment from the registry and never
 * see a shell variable.
 *
 * Reads the stored user value rather than %PATH%, which is the merged
 * machine+user string: writing that back copies every machine entry into
 * the user scope, and boot.ps1 learned that the hard way.
 */
async function addWindowsBinToPath(root: string): Promise<void> {
  const dir = `${root}\\bin\\windows`;
  const script = [
    `$d = '${dir.replace(/'/g, "''")}'`,
    `$u = [Environment]::GetEnvironmentVariable('Path','User')`,
    `if ($u -notlike "*$d*") {`,
    `  $n = if ([string]::IsNullOrEmpty($u)) { $d } else { "$u;$d" }`,
    `  [Environment]::SetEnvironmentVariable('Path', $n, 'User')`,
    `  'added'`,
    `} else { 'present' }`,
  ].join("; ");

  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) {
    log.warn(`could not add ${dir} to your user PATH; add it by hand`);
    return;
  }
  if (out.includes("added")) log.ok(`${dir} added to your user PATH (new terminals only)`);
  else log.skip(`${dir} already on your user PATH`);
}

/** The Windows profile directory, whichever side we are asking from. */
async function windowsHome(p: Platform): Promise<string> {
  if (p.env === "windows") {
    const h = process.env["USERPROFILE"];
    if (h) return h;
    throw new RedError("USERPROFILE is not set");
  }
  const { windowsUserProfile } = await import("./wsl.ts");
  return await windowsUserProfile();
}

/**
 * The tools whose configuration can genuinely be shared.
 *
 * Membership was decided by testing, not by reading documentation: each
 * of these was verified by pointing the tool at a config file and
 * checking that it obeyed. `--help` failed to mention three of the four
 * that do support it, so it is not an oracle.
 *
 * `dir` marks the ones that want a directory rather than a file, which
 * changes both what gets copied and which variable shared.sh exports.
 */
const ADOPTABLE: Record<string, { from: string; to: string; dir?: boolean }> = {
  starship: { from: ".config/starship.toml", to: "starship.toml" },
  mise: { from: ".config/mise/config.toml", to: "mise.toml" },
  zellij: { from: ".config/zellij", to: "zellij", dir: true },
  yazi: { from: ".config/yazi", to: "yazi", dir: true },
  atuin: { from: ".config/atuin", to: "atuin", dir: true },
  bat: { from: ".config/bat/config", to: "bat.conf" },
  // git is an include rather than a replacement — see shared.sh. There
  // is nothing to copy: you write the shared half yourself, and the
  // per-platform half stays in ~/.gitconfig where it belongs.
  git: { from: "", to: "gitconfig" },
};

export function adoptableTools(): string[] {
  return Object.keys(ADOPTABLE);
}

/**
 * Copy a tool's configuration into the share.
 *
 * Copied and not moved, and the original is left where it is. On a
 * boundary this fiddly, a command that deletes the file you had been
 * editing — in the one place you would look for it — is the wrong kind
 * of tidy. It stops being read, and this says so rather than leaving you
 * to discover it.
 */
export async function adoptConfig(p: Platform, tool: string): Promise<number> {
  const spec = ADOPTABLE[tool];
  if (!spec) {
    throw new RedError(
      `cannot share ${tool}'s configuration — try one of: ${adoptableTools().join(", ")}`,
    );
  }

  const root = sharedRootFor(p);
  if (!root) {
    throw new RedError("no shared root chosen yet — run `red-dev share` first");
  }

  const dest = `${root.local}/config/${spec.to}`;
  if (!spec.from) {
    if (!existsSync(dest)) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(dest, `# Shared git settings, included from ~/.gitconfig by red-dev.\n`);
      log.ok(`created ${root.windows}\\config\\${spec.to} — put shared git settings in it`);
    } else {
      log.skip(`${tool} already shared`);
    }
    return 0;
  }

  const home = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!home) throw new RedError("HOME is not set");
  const src = `${home}/${spec.from}`;

  if (!existsSync(src)) {
    log.skip(`${tool} has no configuration here yet (${spec.from})`);
    return 0;
  }
  if (existsSync(dest)) {
    log.skip(`${tool} already shared — ${root.windows}\\config\\${spec.to}`);
    return 0;
  }

  const { cpSync } = await import("node:fs");
  cpSync(src, dest, { recursive: !!spec.dir });
  log.ok(`${tool} shared at ${root.windows}\\config\\${spec.to}`);
  log.plain(`       ~/${spec.from} is left in place and is no longer read`);
  return 0;
}

/**
 * Directories the share is made of.
 *
 * `bin` is split by format because it has to be. The per-tool config
 * directories are deliberately *not* here: creating them empty made
 * "does it exist" meaningless, so a brand new root reported five tools
 * as shared and `adopt zellij` refused with "already shared" over an
 * empty directory. A tool's directory now appears when its config does.
 */
const TREE = ["config", "bin", "bin/linux", "bin/windows"];

export async function ensureSharedRoot(p: Platform): Promise<void> {
  const root = sharedRootFor(p);
  if (!root) {
    log.skip("no shared root chosen — run `red-dev share` to pick one");
    return;
  }

  if (p.env !== "wsl" && p.env !== "windows") {
    throw new RedError(
      "a shared root spans WSL and Windows; this machine is neither, so there is nothing to share with",
    );
  }

  let created = 0;
  for (const part of TREE) {
    const dir = `${root.local}/${part}`;
    if (existsSync(dir)) continue;
    mkdirSync(dir, { recursive: true });
    created++;
  }

  if (created > 0) log.ok(`shared root ready at ${root.windows} (${created} new)`);
  else log.skip(`shared root already at ${root.windows}`);

  // Said once, here, because it is the one thing about this layout that
  // is not obvious from looking at it.
  log.plain(`       config/ is shared; bin/ is split by format, because a Linux`);
  log.plain(`       binary cannot run on Windows and the reverse is just as true`);
}
