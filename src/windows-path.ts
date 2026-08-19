/**
 * mise's shims, on the Windows PATH, ahead of red-dev's own bootstrap copy.
 *
 * On Linux `config/bash/path.sh` puts `<mise data>/shims` on PATH and
 * everything mise installs is reachable by name. Windows had no
 * equivalent, and the consequences were invisible because each one
 * looked like a different bug:
 *
 *   - `cosign` was installed by a converge and then reported
 *     `Executable not found in $PATH: "cosign"` by the next item. It
 *     genuinely was not on PATH, and no number of re-runs would put it
 *     there.
 *   - `mise upgrade red-dev` moved a copy nothing executed. `red-dev`
 *     resolved to `%LOCALAPPDATA%\red-dev\bin\red-dev.exe` — what
 *     boot.ps1 writes and appends to PATH — so a machine sat on the
 *     bootstrap version while mise reported it up to date. Measured on
 *     the machine that found it: boot copy 1.0.64, mise copy 1.0.52,
 *     three releases published in between.
 *
 * ## Order is the whole point
 *
 * Appending is not enough. boot.ps1 already appended its own directory,
 * so a shims entry after it leaves the bootstrap copy winning every
 * lookup — and the migration that retires that copy skips it while it
 * is the running process, which it always is while it wins. Ahead of
 * it, the shim answers, the next run executes mise's copy, and
 * `2026-08-15-release-binaries-to-mise` sweeps the leftover on its own.
 *
 * The two entries are moved relative to each other and nothing else is
 * touched: the rest of the person's PATH keeps its order, and an entry
 * they put there themselves stays where they put it.
 *
 * ## One machine, two sides
 *
 * This runs from Windows and from inside WSL, because the PATH it
 * fixes is the same PATH either way: one Windows user environment,
 * whichever side of the boundary the converge happened to start on.
 * From the distro that means powershell.exe through interop — the
 * crossing shared-root.ts already makes for the same reason. A plain
 * Linux machine is skipped: `config/bash/path.sh` prepends the shims
 * there and has since the move to mise.
 *
 * Every value comes back from the Windows side rather than being
 * derived here. %LOCALAPPDATA% cannot be guessed from inside WSL — a
 * redirected profile, a non-C: install and a domain account each break
 * a guess — and MISE_DATA_DIR and RED_DEV_BIN_DIR are the operator's to
 * set, on that side, where this must honour them.
 */

import { log } from "./log.ts";
import type { Platform } from "./platform.ts";

/** What the user's PATH should be, or null when it already reads correctly. PURE. */
export function pathWithShimsFirst(
  current: string,
  shims: string,
  bootBin: string,
): string | null {
  const entries = current.split(";").filter((e) => e.length > 0);
  const norm = (v: string) => v.replace(/[\\/]+$/, "").toLowerCase();
  const at = (dir: string) => entries.findIndex((e) => norm(e) === norm(dir));

  const boot = at(bootBin);
  const shim = at(shims);

  // Nothing to be ahead of: append, so the shims are reachable at all.
  if (boot === -1) {
    if (shim !== -1) return null;
    return [...entries, shims].join(";");
  }

  if (shim !== -1 && shim < boot) return null;

  // Remove the shims entry wherever it was and put it back immediately
  // before the bootstrap directory, which keeps every other entry —
  // including anything the person placed ahead of both — untouched.
  const without = entries.filter((_, i) => i !== shim);
  const target = without.findIndex((e) => norm(e) === norm(bootBin));
  without.splice(target, 0, shims);
  return without.join(";");
}

/**
 * The one script that reads everything this needs from Windows.
 *
 * Read and write are two calls rather than one script that decides,
 * because the deciding is `pathWithShimsFirst` and it is worth having
 * where it can be tested. What crosses the boundary is facts.
 */
export const MARKER = "---";

export const READ_SCRIPT = [
  `"$([Environment]::GetEnvironmentVariable('Path','User'))"`,
  `'${MARKER}'`,
  '"$env:LOCALAPPDATA"',
  `'${MARKER}'`,
  '"$env:MISE_DATA_DIR"',
  `'${MARKER}'`,
  '"$env:RED_DEV_BIN_DIR"',
  // A terminator, so the last value is delimited on both sides. Without
  // it an unset RED_DEV_BIN_DIR left a trailing blank that trimming ate,
  // and the reading came back one section short.
  `'${MARKER}'`,
].join("; ");

export interface WindowsPathFacts {
  userPath: string;
  /** `<MISE_DATA_DIR or %LOCALAPPDATA%\\mise>\\shims`. */
  shims: string;
  /** `%RED_DEV_BIN_DIR%` or `%LOCALAPPDATA%\\red-dev\\bin`, as boot.ps1 spells it. */
  bootBin: string;
}

/**
 * What READ_SCRIPT printed, as the three paths this needs. PURE.
 *
 * Read line by line against an explicit marker rather than by splitting
 * the whole string on a separator, because two things about PowerShell
 * defeat the simpler reading and both did, on a real machine:
 *
 *   - a bare `$env:X` that is unset prints *no line at all*, so two
 *     sections collapse into one. Every value is interpolated into a
 *     double-quoted string now, which always prints a line.
 *   - the last value being empty leaves a trailing blank that trimming
 *     removes, taking the final section with it. Hence the terminator.
 *
 * The first version of this function was handed the marker itself as
 * the mise data directory, turned it into `---\\shims`, and the caller
 * wrote that to a live user PATH. So the shape is checked rather than
 * assumed: four delimited sections, no value that looks like a marker,
 * and anything else answers null — on which the caller writes nothing.
 */
export function parseWindowsPathFacts(out: string): WindowsPathFacts | null {
  const lines = out.split(/\r?\n/).map((line) => line.replace(/\r$/, ""));

  const sections: string[] = [];
  let current: string[] = [];
  let terminated = false;
  for (const line of lines) {
    if (line.trim() === MARKER) {
      sections.push(current.join("").trim());
      current = [];
      if (sections.length === 4) {
        terminated = true;
        break;
      }
      continue;
    }
    current.push(line);
  }
  if (!terminated || sections.length !== 4) return null;

  const [userPath = "", localAppData = "", miseDataDir = "", redDevBinDir = ""] = sections;
  const local = localAppData.replace(/\\+$/, "");
  const miseRoot = miseDataDir.replace(/\\+$/, "") || (local ? `${local}\\mise` : "");
  const bootBin = redDevBinDir.replace(/\\+$/, "") || (local ? `${local}\\red-dev\\bin` : "");
  if (!miseRoot || !bootBin) return null;
  return { userPath, shims: `${miseRoot}\\shims`, bootBin };
}

/** The PowerShell that writes the ordered value back. */
export function writeUserPathScript(next: string): string {
  // The stored user value, never %PATH%: that one is machine+user
  // merged, and writing it back copies every machine entry into the
  // user scope. boot.ps1 carries the same warning for the same reason.
  return `[Environment]::SetEnvironmentVariable('Path', '${next.replace(/'/g, "''")}', 'User')`;
}

async function run(bin: string, script: string): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn([bin, "-NoProfile", "-NonInteractive", "-Command", script], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  return { out, code: await proc.exited };
}

/**
 * Put mise's shims ahead of the bootstrap bin directory on this machine.
 *
 * Quiet on a machine that already reads correctly. A PATH that cannot
 * be read or written is a warning rather than a failure: everything
 * red-dev does itself resolves mise by path (`miseToolBin`), so this is
 * what makes the machine pleasant to use by hand rather than what makes
 * the converge work.
 */
export async function ensureMiseShimsOnPath(p: Platform): Promise<void> {
  if (p.os !== "windows" && p.env !== "wsl") {
    log.skip("mise shims: config/bash/path.sh puts them on PATH here");
    return;
  }

  // wsl.ts owns "how do I reach PowerShell from here", and answers it
  // for both sides. A second copy of that fallback chain here would be
  // one more place to be wrong about a machine with no /mnt/c.
  const { powershellBin } = await import("./wsl.ts");
  const bin = powershellBin();

  const read = await run(bin, READ_SCRIPT);
  const facts = read.code === 0 ? parseWindowsPathFacts(read.out) : null;
  if (!facts) {
    log.warn("could not read the Windows user PATH; mise's shims may not be on it");
    return;
  }

  const next = pathWithShimsFirst(facts.userPath, facts.shims, facts.bootBin);
  if (next === null) {
    log.skip(`mise shims: ${facts.shims} already resolves before ${facts.bootBin}`);
    return;
  }

  const write = await run(bin, writeUserPathScript(next));
  if (write.code !== 0) {
    log.warn(`could not write your user PATH; put ${facts.shims} before ${facts.bootBin} by hand`);
    return;
  }
  log.ok(`${facts.shims} now resolves before ${facts.bootBin} (new terminals only)`);
}
