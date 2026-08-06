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

import { existsSync, mkdirSync, readFileSync } from "node:fs";
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

/**
 * The recorded root, from the environment or from the file.
 *
 * Reading only the environment variable was wrong twice over. env.sh is
 * sourced by rc.sh, so the variable exists in an interactive shell that
 * has loaded the dotfiles and nowhere else — which meant `red-dev theme`
 * wrote into the share from a terminal and wrote locally from a script,
 * from CI, and from the installer, reporting success either way. The
 * binary wrote the record; it can read it.
 */
export function recordedShareRoot(): string | null {
  const fromEnv = process.env["RED_SHARE_WIN"];
  if (fromEnv) return fromEnv;

  const home = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!home) return null;
  const path = `${home}/.config/red-dev/env.sh`;
  if (!existsSync(path)) return null;
  try {
    const m = /^export\s+RED_SHARE_WIN=(.*)$/m.exec(readFileSync(path, "utf8"));
    const raw = m?.[1]?.trim();
    if (!raw) return null;
    // Written quoted, because a Windows path is mostly backslashes.
    return raw.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
  } catch {
    return null;
  }
}

/** Where the shared root lives, when one has been chosen. */
export function sharedRootFor(p: Platform): SharedRoot | null {
  const windows = recordedShareRoot();
  if (!windows) return null;
  return { windows, local: localPath(windows, p.env) };
}

/**
 * The default, and the reason for it.
 *
 * Inside the profile rather than at C:\red: it disappears with the
 * profile when a machine is rebuilt, and it does not add a directory to
 * the root of the system drive.
 *
 * `.red\dev` and not `.reddev` because `.red` is a namespace the rest of
 * the toolchain already writes into — .red/adr, .red/CONTEXT.md — and
 * dev is one product inside it. A flat `.reddev` would be the only thing
 * sitting outside that namespace, which leaves the next tool to invent
 * its own spelling and the profile to collect one dotfile per product.
 * Machines that already have the old root are moved by
 * 2026-08-06-share-root-namespace rather than left behind.
 */
export function defaultRoot(windowsHome: string): string {
  return `${windowsHome.replace(/[\\/]$/, "")}\\.red\\dev`;
}

/** The pre-namespace spelling, still on every machine set up before it. */
export function legacyRoot(windowsHome: string): string {
  return `${windowsHome.replace(/[\\/]$/, "")}\\.reddev`;
}

/**
 * Whether a recorded root is the old default, and where it should go.
 *
 * Matched against the default this project itself wrote, not against any
 * path that happens to end in `.reddev`. A root the user pointed
 * somewhere else by hand is a deliberate choice, and relocating it
 * because the spelling looks familiar is the kind of helpfulness that
 * moves a directory out from under someone.
 *
 * Case-insensitive because Windows paths are, and a root recorded as
 * `C:\Users\Filip\.reddev` against a profile reported as
 * `C:\Users\filip` is the same directory.
 */
export function namespaceMove(
  recorded: string | null,
  profile: string,
): { from: string; to: string } | null {
  if (!recorded) return null;
  const norm = (s: string): string => s.replace(/[\\/]+$/, "").toLowerCase();
  if (norm(recorded) !== norm(legacyRoot(profile))) return null;
  return { from: recorded.replace(/[\\/]+$/, ""), to: defaultRoot(profile) };
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

  const current = recordedShareRoot();
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
export async function windowsHome(p: Platform): Promise<string> {
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
 * Where a tool's configuration should be written.
 *
 * The correction this function exists for: every writer had
 * `${home()}/.config/...` hardcoded, so configuration was always written
 * locally and the share was somewhere you migrated *into* afterwards.
 * That makes the shared root an accessory bolted onto the end, when it
 * is supposed to be the foundation — one directory both environments
 * read, established at install rather than adopted later.
 *
 * So this is the single place that decides, and it answers ~/.config
 * whenever there is no share, which is every machine that has not opted
 * in and every machine that cannot: bare-metal Ubuntu and servers have
 * no second environment, and sharing with a machine that is not there is
 * not a thing.
 *
 * `adopt` keeps its job for installs that predate this — the configs
 * already sitting in ~/.config do not move themselves.
 */
export function configHome(p: Platform, tool?: string): string {
  const win = recordedShareRoot();
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  if (!win) return `${home}/.config`;

  // Resolved here rather than read from RED_SHARE.
  //
  // RED_SHARE is exported by rc.sh, so trusting it made this work only
  // inside an interactive shell that had sourced the dotfiles — and
  // `red-dev theme` run any other way wrote locally while reporting
  // success. The binary has RED_SHARE_WIN and knows its own platform,
  // which is everything it needs to answer this itself.
  const share = localPath(win, p.env);
  if (!existsSync(share)) return `${home}/.config`;

  // Only the tools whose configuration is genuinely portable. The rest
  // stay local, and the reason is per-tool rather than general: btop's
  // config names /home/<user>/.config/btop/themes/... and a gitconfig on
  // this machine calls /usr/bin/gh, both of which exist on exactly one
  // of the two sides.
  if (tool && !(tool in ADOPTABLE)) return `${home}/.config`;
  return `${share}/config`;
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
