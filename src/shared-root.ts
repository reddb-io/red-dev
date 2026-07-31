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

/** Directories the share is made of. `bin` is split by format on purpose. */
const TREE = ["config", "config/zellij", "config/yazi", "config/atuin", "bin", "bin/linux", "bin/windows"];

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
