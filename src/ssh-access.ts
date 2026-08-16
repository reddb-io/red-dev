/**
 * Who may reach the SSH server this machine now runs.
 *
 * ssh-server.ts opens the port. Until this file existed that was the
 * whole story: the package installed, the service started, the firewall
 * rule went in, and not one key was authorized — a machine listening on
 * 22 that refuses every connection, which is the worst of both. An open
 * port earns nothing and the person who ran the converge still cannot
 * get in.
 *
 * A GitHub account is the shortest honest answer to "whose keys". The
 * account already exists, its public keys are already published at
 * `https://github.com/<user>.keys`, and they are public by design — so
 * there is no secret to move, no key to generate on the wrong machine,
 * and nothing to paste. What arrives is fetched, shown, and only then
 * written.
 *
 * ## Three rules
 *
 *  - Fetch, then show, then write. The keys are on screen with their
 *    SHA256 fingerprints before anything touches the file, because
 *    "authorize whatever github.com just said" is not a decision anybody
 *    made. The fingerprints are the ones github.com/settings/keys prints
 *    and `ssh-keygen -lf` computes, so they can be checked against
 *    something rather than trusted.
 *  - Never during a converge. A converge runs in CI, in a pipe and over
 *    a non-interactive SSH; a question there is a hang. So the ask lives
 *    in the interview and in `red-dev ssh`, and both go through
 *    `interactive()` — which is also why the file this writes is the
 *    only part of the SSH story a plain `red-dev install` leaves alone.
 *  - What went in comes out together. Removal drops the keys, the
 *    firewall rule and the service in one act, because reverting two of
 *    the three is how a machine ends up still listening for a key that
 *    is no longer there, or still holding a key for a service that is
 *    gone.
 *
 * ## Written where red-dev is running
 *
 * `~/.ssh/authorized_keys` of the home this process has, and no attempt
 * to guess a second one. On WSL that is the distro's home while the
 * Windows host runs its own sshd against the Windows profile — a real
 * asymmetry, and it is reported rather than papered over, because a tool
 * that writes into two homes on a guess authorizes a key somewhere
 * nobody asked it to.
 *
 * The fullscreen menu hosts the interview too, and its answers are
 * applied inside a live frame where a blocking prompt would draw over
 * the interface. So the question is not asked there; `red-dev ssh` is,
 * and the converge names it.
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";
import { linuxUnit, windowsSshRevertScript } from "./ssh-server.ts";
import { unattendedEnvironment } from "./unattended.ts";
import type { Removal } from "./uninstall.ts";
import { confirm, interactive, text } from "./ui.ts";

/** One public key, as authorized_keys spells it. */
export interface PublicKey {
  /** The algorithm: ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256. */
  type: string;
  /** The base64 body — the key itself, and the only part worth comparing. */
  body: string;
  /** The trailing comment, which is where the provenance is written. */
  comment: string;
}

/**
 * GitHub's own rule for a username: alphanumerics and single hyphens,
 * never leading or trailing, up to 39 characters.
 *
 * Checked before the URL is built rather than after the request fails,
 * because this string is interpolated into one — and `../../` or a query
 * string in that slot would fetch something other than a key list and
 * report whatever it found as keys.
 */
const USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * The line shapes OpenSSH accepts, minus the options prefix.
 *
 * A line with `command="…"` in front of the key is somebody's deliberate
 * restriction, so it is not parsed and not rewritten — only read past.
 * See `alreadyAuthorized`, which compares bodies against the whole file
 * for exactly that reason.
 */
const KEY_LINE =
  /^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-[a-z0-9-]+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-[a-z0-9-]+@openssh\.com)\s+([A-Za-z0-9+/]+={0,3})(?:\s+(\S.*))?$/;

/** The delimiters that make this project's lines removable. PURE. */
export const BLOCK_BEGIN = "# begin red-dev — public keys from github.com";
export const BLOCK_END = "# end red-dev";

/** Where GitHub publishes an account's public keys. PURE. */
export function githubKeysUrl(user: string): string {
  if (!USERNAME.test(user)) throw new RedError(`'${user}' is not a GitHub username`);
  return `https://github.com/${user}.keys`;
}

/** Every key line in a blob of authorized_keys text. PURE. */
export function parsePublicKeys(body: string): PublicKey[] {
  const out: PublicKey[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = KEY_LINE.exec(line);
    if (!m) continue;
    out.push({ type: m[1]!, body: m[2]!, comment: m[3]?.trim() ?? "" });
  }
  return out;
}

/** One key as a line of authorized_keys. PURE. */
export function keyLine(key: PublicKey): string {
  return `${key.type} ${key.body}${key.comment ? ` ${key.comment}` : ""}`;
}

/**
 * The fingerprint OpenSSH prints, so a person can check rather than
 * trust. PURE.
 *
 * SHA256 over the decoded blob, base64 without padding — the same string
 * `ssh-keygen -lf` produces and github.com/settings/keys shows beside
 * each key. Printing the key body instead would be sixty-eight
 * characters nobody compares.
 */
export function fingerprint(key: PublicKey): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(Buffer.from(key.body, "base64"));
  return `SHA256:${hasher.digest("base64").replace(/=+$/, "")}`;
}

/** Where authorized keys live for a given home. PURE. */
export function authorizedKeysPath(home: string): string {
  return `${home}/.ssh/authorized_keys`;
}

/** The home this process has, under either platform's name for it. */
export function homeDirectory(): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!home) throw new RedError("neither HOME nor USERPROFILE is set");
  return home;
}

/**
 * Whether this key is already in the file, however it got there. PURE.
 *
 * Compared against the whole text rather than against the parsed lines:
 * a key someone restricted with `command="…"` is already authorized, and
 * adding an unrestricted second copy of it would quietly widen what that
 * key may do.
 */
function alreadyAuthorized(existing: string, key: PublicKey): boolean {
  return existing.includes(key.body);
}

/**
 * The file with these keys in it, and which ones that added. PURE.
 *
 * Kept between markers, the same shape the `.bashrc` hook uses and for
 * the same reason: removal has to be able to take out what this project
 * put in without rewriting a file it does not own. Anything above or
 * below the block is somebody else's and survives both directions.
 */
export function withAuthorizedKeys(
  existing: string,
  keys: readonly PublicKey[],
): { body: string; added: PublicKey[] } {
  const added = keys.filter((key) => !alreadyAuthorized(existing, key));
  if (added.length === 0) return { body: existing, added: [] };

  const lines = existing.trim() === "" ? [] : existing.replace(/\n+$/, "").split("\n");
  const begin = lines.indexOf(BLOCK_BEGIN);
  const end = lines.indexOf(BLOCK_END);
  const insertAt = begin >= 0 && end > begin ? end : -1;
  const block = added.map(keyLine);

  const next =
    insertAt >= 0
      ? [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)]
      : [...lines, BLOCK_BEGIN, ...block, BLOCK_END];
  return { body: `${next.join("\n")}\n`, added };
}

/**
 * The file without this project's block, and what came out of it. PURE.
 *
 * An unterminated block is treated as running to the end of the file:
 * the alternative is leaving keys behind because a marker was edited
 * away, and a removal that half-removes an authorization is worse than
 * one that takes a hand-added line with it.
 */
export function withoutAuthorizedKeys(existing: string): { body: string; removed: string[] } {
  const lines = existing.split("\n");
  const begin = lines.indexOf(BLOCK_BEGIN);
  if (begin < 0) return { body: existing, removed: [] };

  const offset = lines.slice(begin + 1).indexOf(BLOCK_END);
  const end = offset < 0 ? lines.length - 1 : begin + 1 + offset;
  const removed = lines.slice(begin + 1, end).filter((line) => line.trim() !== "");
  const kept = [...lines.slice(0, begin), ...lines.slice(end + 1)].join("\n");
  return { body: kept.trim() === "" ? "" : `${kept.replace(/\n+$/, "")}\n`, removed };
}

/** Just enough of `fetch` to be replaceable in a test. */
export type Fetcher = (
  url: string,
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * What github.com publishes for an account.
 *
 * Every failure here is named as itself. "No such account" and "an
 * account with no keys" send a person to two different places — one to
 * check the spelling, one to https://github.com/settings/keys — and a
 * single "could not fetch keys" sends them to neither.
 */
export async function fetchGithubKeys(user: string, fetcher?: Fetcher): Promise<PublicKey[]> {
  const url = githubKeysUrl(user);
  const get = fetcher ?? ((target: string) => fetch(target));

  let response: Awaited<ReturnType<Fetcher>>;
  try {
    response = await get(url);
  } catch (err) {
    throw new RedError(`could not reach github.com: ${(err as Error).message}`);
  }

  if (response.status === 404) throw new RedError(`github.com has no account named '${user}'`);
  if (!response.ok) throw new RedError(`github.com answered ${response.status} for ${user}.keys`);

  // The comment is ours, not GitHub's — that endpoint returns bare keys.
  // It is what makes a line in authorized_keys explain itself six months
  // later, and it is the only place the account name survives.
  const keys = parsePublicKeys(await response.text()).map((key) => ({
    ...key,
    comment: `${user}@github`,
  }));
  if (keys.length === 0) {
    throw new RedError(`${user} has published no public keys — add one at github.com/settings/keys`);
  }
  return keys;
}

export interface AuthorizeDeps {
  /** The home to write into. Defaults to this process's own. */
  home?: string;
  fetch?: Fetcher;
  /** Where the keys are shown. Defaults to the log. */
  show?: (line: string) => void;
  /** The answer that lets a write happen at all. */
  confirm?: (keys: readonly PublicKey[], user: string) => Promise<boolean>;
}

export interface Authorized {
  user: string;
  path: string;
  /** Everything the account publishes. */
  keys: PublicKey[];
  /** What this run added, which is empty in every case but one. */
  added: PublicKey[];
  status: "written" | "declined" | "unchanged";
}

/**
 * Fetch an account's keys, show them, and write them if told to.
 *
 * The order is the feature. Nothing on disk is touched until `confirm`
 * has returned true, so a declined answer leaves a machine byte for byte
 * as it was — including the case where there was no `~/.ssh` at all,
 * which is why the directory is created after the answer rather than
 * before the fetch.
 */
export async function authorizeGithubKeys(
  user: string,
  deps: AuthorizeDeps = {},
): Promise<Authorized> {
  const home = deps.home ?? homeDirectory();
  const path = authorizedKeysPath(home);
  const keys = await fetchGithubKeys(user, deps.fetch);

  const show = deps.show ?? ((line: string) => log.plain(line));
  show(`       github.com/${user} publishes ${keys.length} public key(s):`);
  for (const key of keys) show(`       ${key.type}  ${fingerprint(key)}`);

  const ask =
    deps.confirm ??
    ((found: readonly PublicKey[]) =>
      confirm(
        `Authorize ${found.length === 1 ? "this key" : `these ${found.length} keys`} for ssh into this machine?`,
        false,
      ));
  if (!(await ask(keys, user))) return { user, path, keys, added: [], status: "declined" };

  const existing = existsSync(path) ? await Bun.file(path).text() : "";
  const { body, added } = withAuthorizedKeys(existing, keys);
  if (added.length === 0) return { user, path, keys, added, status: "unchanged" };

  mkdirSync(`${home}/.ssh`, { recursive: true, mode: 0o700 });
  await Bun.write(path, body);
  // sshd refuses a group- or world-writable authorized_keys and says so
  // only in its own log, so a machine with the right key in the right
  // file can still refuse every connection. Best effort: Windows has no
  // mode bits to set, and failing the authorization over that would be
  // reporting a file system's shape as the user's mistake.
  try {
    chmodSync(`${home}/.ssh`, 0o700);
    chmodSync(path, 0o600);
  } catch {
    // Nothing to say: on a filesystem without modes there was never a
    // permission to get wrong.
  }
  return { user, path, keys, added, status: "written" };
}

/** Say what happened, including the half of a WSL machine this misses. */
export function reportAuthorization(p: Platform, result: Authorized): void {
  switch (result.status) {
    case "written":
      log.ok(`${result.added.length} key(s) from github.com/${result.user} → ${result.path}`);
      break;
    case "unchanged":
      log.skip(`every key github.com/${result.user} publishes was already authorized`);
      break;
    case "declined":
      log.skip("nothing authorized");
      return;
  }

  if (p.env === "wsl") {
    // Stated rather than guessed at. ssh-server.ts configures the
    // Windows host's sshd when it runs from Windows, and that server
    // reads the Windows profile — so a key written here authorizes the
    // distro's own sshd and nothing else.
    log.plain("       this authorized the distro's sshd; run the same command on Windows");
    log.plain("       to authorize the host's, which reads its own profile");
  }
}

/** The username, asked at the terminal. */
export async function askGithubUser(): Promise<string> {
  log.plain("");
  log.plain("     An SSH server is installed and listening, and authorizes nobody yet.");
  log.plain("     Naming a GitHub account fetches its published public keys, shows them,");
  log.plain("     and authorizes them here once you agree. Blank skips it.");
  return (await text("GitHub username to authorize?")).trim();
}

/**
 * The interview's question, and the one place that decides not to ask.
 *
 * `interactive()` is checked here rather than trusted to the prompt
 * primitives below it: they return their fallback without a TTY, which
 * would make this a silent no — correct, and indistinguishable from
 * nobody having wired the question up. Refusing here is a decision the
 * call site can see.
 */
export async function offerGithubKeys(
  p: Platform,
  deps: AuthorizeDeps & { ask?: () => Promise<string> } = {},
): Promise<Authorized | null> {
  if (!interactive()) return null;

  const user = await (deps.ask ?? askGithubUser)();
  if (user.trim() === "") {
    log.skip("no key authorized — `red-dev ssh <github-user>` when you want one");
    return null;
  }

  try {
    const result = await authorizeGithubKeys(user.trim(), deps);
    reportAuthorization(p, result);
    return result;
  } catch (err) {
    // Never fatal to a first run. The machine is converging; an account
    // typed with a missing letter is not a reason to stop it.
    log.warn(`ssh keys: ${(err as Error).message}`);
    return null;
  }
}

// ----------------------------------------------------------- removal

/** Ran, and what it printed — the same shape ssh-server.ts uses. */
export type Runner = (cmd: string[]) => Promise<{ ok: boolean; out: string }>;

async function spawn(cmd: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: unattendedEnvironment(),
  });
  const out = (
    (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())
  ).trim();
  return { ok: (await proc.exited) === 0, out };
}

export interface RevertDeps {
  home?: string;
  run?: Runner;
}

export interface Reverted {
  /** The key lines that came out of authorized_keys. */
  removedKeys: string[];
  /** What was executed, in order. */
  ran: string[][];
  /** What could not be undone, each as its own sentence. */
  notes: string[];
}

/**
 * Undo the whole of it: the service, the rule and the keys.
 *
 * In that order, and the order is the point. Closing the door before
 * taking the keys off the hook leaves no moment where the port is open
 * to an authorization nobody is watching any more; the reverse leaves
 * one. Neither half is optional, which is why a failure to stop the
 * service is recorded as a note and the keys still come out — a machine
 * half-reverted has to be able to say which half.
 *
 * Ubuntu's converge opens no firewall rule of its own: it installs the
 * package and enables the unit and stops. So there is none of ours to
 * remove there, and reaching for ufw would be reverting a rule somebody
 * else's hand wrote.
 */
export async function revertSshAccess(p: Platform, deps: RevertDeps = {}): Promise<Reverted> {
  const run = deps.run ?? spawn;
  const home = deps.home ?? homeDirectory();
  const ran: string[][] = [];
  const notes: string[] = [];

  if (p.os === "windows") {
    // One script, both halves: the service back to disabled and the rule
    // this project added deleted by the name it added it under.
    const cmd = ["powershell.exe", "-NoProfile", "-Command", windowsSshRevertScript];
    ran.push(cmd);
    const { ok, out } = await run(cmd);
    if (!ok) notes.push(`the sshd service and its firewall rule are unchanged: ${firstLine(out)}`);
  } else {
    const unit = await linuxUnit(run);
    if (!unit) {
      notes.push("no ssh unit on this machine, so nothing was stopped");
    } else {
      const cmd = ["sudo", "-n", "systemctl", "disable", "--now", unit];
      ran.push(cmd);
      const { ok, out } = await run(cmd);
      if (!ok) notes.push(`${unit}.service is still enabled: ${firstLine(out)}`);
    }
  }

  const path = authorizedKeysPath(home);
  const existing = existsSync(path) ? await Bun.file(path).text() : "";
  const { body, removed } = withoutAuthorizedKeys(existing);
  if (body !== existing) await Bun.write(path, body);

  return { removedKeys: removed, ran, notes };
}

function firstLine(out: string): string {
  return out.split("\n")[0]?.trim() || "no output";
}

/**
 * The revert as the uninstall command's own vocabulary.
 *
 * Shaped as a `Removal` so `red-dev uninstall` names what will go before
 * it goes, exactly as it does for every apt package — the SSH server is
 * the one item where that sentence has three clauses instead of one.
 */
export function sshAccessRemoval(p: Platform, deps: RevertDeps = {}): Removal {
  return {
    tool: "ssh-server",
    how:
      p.os === "windows"
        ? "stop and disable sshd, delete the TCP 22 rule, drop the authorized keys"
        : "systemctl disable --now ssh, drop the authorized keys",
    run: async () => {
      const reverted = await revertSshAccess(p, deps);
      for (const cmd of reverted.ran) log.plain(`       ${cmd.slice(0, 4).join(" ")}`);
      for (const line of reverted.removedKeys) {
        log.plain(`       removed ${line.split(" ").slice(2).join(" ") || line.slice(0, 24)}`);
      }
      for (const note of reverted.notes) log.warn(note);
    },
  };
}
