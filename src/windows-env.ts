/**
 * Where Windows keeps a user's directories, remembered rather than asked
 * again.
 *
 * %APPDATA% and %LOCALAPPDATA% cannot be guessed from inside WSL — a
 * redirected profile, a domain account or a second drive all put them
 * somewhere /mnt/c/Users/<name> is not — so red-dev asks the host, which
 * costs a `cmd.exe` through interop. That was fine while the answer was
 * wanted once per converge. It stopped being fine when the Redwall went
 * on a two-minute timer: a console program started through interop by a
 * process with no console of its own has a window allocated for it, and
 * one tick asked those two questions six times between them.
 *
 * The answer is a property of the machine and not of the run, so it is
 * recorded. Under the distro's own cache directory, because it is the
 * distro's view of the host that is being remembered and a second WSL
 * distro on the same host has its own /mnt to translate against.
 *
 * ## What makes it safe to trust
 *
 * The recorded path has to still be a directory. That is a weak check
 * and a sufficient one: the ways this can go stale — a profile moved, a
 * drive re-lettered, the file copied to another machine — all end with a
 * path that is not there, and the run that finds it missing asks the
 * host again and rewrites the record. A path that still resolves to a
 * directory is the answer the host would have given.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

const MANAGED = [
  "# Managed by red-dev — what Windows answered when it was last asked.",
  "# Deleting this file costs one cmd.exe and nothing else.",
].join("\n");

/**
 * Within one process too, and not only across runs. A converge asks for
 * the same directory from several unrelated places, and none of them
 * should have to know that another already paid for the answer.
 */
const held = new Map<string, string>();

function recordPath(): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? homedir();
  return `${home}/.cache/red-dev/windows-env`;
}

/** The exact bytes of the record, for a whole set of answers. PURE. */
export function windowsEnvRecord(dirs: Record<string, string>): string {
  const lines = Object.keys(dirs).sort().map((name) => `${name}=${dirs[name]}`);
  return [MANAGED, ...lines, ""].join("\n");
}

/** What a record says, ignoring anything it does not understand. PURE. */
export function parseWindowsEnvRecord(body: string): Record<string, string> {
  const dirs: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at <= 0) continue;
    dirs[trimmed.slice(0, at)] = trimmed.slice(at + 1);
  }
  return dirs;
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The directory Windows names `name`, from the record when the record
 * still describes this machine and from `ask` when it does not.
 *
 * `ask` is passed in rather than imported so this module knows nothing
 * about interop: the code that can talk to a Windows host lives in
 * wsl.ts, and a cache that reached back into it would be a cycle between
 * the two.
 */
export async function rememberedWindowsDir(
  name: string,
  ask: () => Promise<string>,
): Promise<string> {
  const memo = held.get(name);
  if (memo !== undefined && isDirectory(memo)) return memo;

  const path = recordPath();
  const recorded = existsSync(path)
    ? parseWindowsEnvRecord(await Bun.file(path).text().catch(() => ""))
    : {};
  const known = recorded[name];
  if (known !== undefined && isDirectory(known)) {
    held.set(name, known);
    return known;
  }

  const answer = await ask();
  held.set(name, answer);
  // Merged rather than overwritten: the two names are asked by different
  // callers at different times, and a run that only needed one of them
  // must not cost the other its record.
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, windowsEnvRecord({ ...recorded, [name]: answer }));
  return answer;
}

/** Forget everything remembered in this process. For tests. */
export function forgetWindowsDirs(): void {
  held.clear();
}
