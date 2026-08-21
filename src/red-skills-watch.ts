/**
 * Taking a new RedSkills release as soon as the machine sees one.
 *
 * ADR 0017. The parts that do the work already existed and are cheap:
 * `acquireRedSkills` resolves a channel with one `git ls-remote` and
 * answers `current` before it clones anything, and `runStagedUpdate`
 * acquires, verifies and holds a revision back while a Worker is
 * running. What was missing was somebody to start them — so a
 * workstation sat on 3.22.0 for a day with 4.0.1 published, and the
 * only signal was a command nobody had a reason to type.
 *
 * ## Three things, in this order, and each one can stop the run
 *
 *   1. **Debounce.** A stamp records when the network was last asked.
 *      Inside the interval this returns without a syscall beyond one
 *      `stat`, which is what lets the triggers be things that happen
 *      often — a shell starting, a Worker being born — instead of a
 *      timer that fires on an idle machine to learn nothing moved
 *      (ADR 0009, which this follows rather than re-argues).
 *   2. **Lock.** One run per machine. Two terminals opened together are
 *      one acquisition and one no-op, not a race; the second returns
 *      immediately rather than queueing, because the first is already
 *      doing the only work there is to do.
 *   3. **Ask, then take.** The cheap question first. Only a machine that
 *      is actually behind pays for a clone, a verification and a host
 *      reconciliation.
 *
 * ## What "aggressive" does not mean
 *
 * It does not mean swapping the tree under a running Worker. A run that
 * meets one stages the complete verified revision and leaves activation
 * to the run that finds none — ADR 0010's rule, unchanged. The
 * aggression is in how soon we look and how little we wait afterwards.
 *
 * And it does not mean trusting anything new. The signature is verified
 * exactly as it is for a typed `red-dev red-skills install`; this file
 * decides *when* an acquisition starts and nothing about what one is
 * willing to accept.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import { redSkillsRoot } from "./red-skills-root.ts";

/** How long an answer stands before the network is asked again. */
export const WATCH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How long a *half-published* release stands before asking again.
 *
 * A GitHub release exists before its assets do: the tag appears, and the
 * publishing job then uploads for minutes. Measured on this project —
 * v4.0.12 was created at 16:40:53 and had 2 of its 39 assets a full
 * minute later, and somebody who asked in that window was told the
 * release "publishes no package-set.manifest.json" and then waited a
 * quarter of an hour for the machine to look again.
 *
 * That answer is not "nothing new"; it is "not yet". Waiting the full
 * interval on it means an aggressive watch systematically catches
 * releases mid-upload and then sleeps through the moment they finish.
 */
export const WATCH_NOT_READY_MS = 60 * 1000;

/**
 * How long a lock is believed.
 *
 * An acquisition is a clone and a download, so this is minutes rather
 * than the seconds a rate-limit lock uses. A process killed mid-run
 * leaves the file behind; past this, the next run takes it rather than
 * a machine being locked out of its own updates by a crash.
 */
export const WATCH_LOCK_MS = 10 * 60 * 1000;

/** `~/.red/skills/watch.json` — when the publisher was last asked. */
export function watchStampPath(home: string): string {
  return `${redSkillsRoot(home)}/watch.json`;
}

interface WatchStamp {
  schema: 1;
  /** Epoch milliseconds of the last completed ask. */
  askedAtMs: number;
  /** What it found, for a person reading the file. */
  found?: string;
}

/** When the network was last asked, or null if it never was. PURE-ish: one read. */
export function lastAskedAt(path: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WatchStamp>;
    return typeof parsed.askedAtMs === "number" ? parsed.askedAtMs : null;
  } catch {
    return null;
  }
}

/** Whether the interval has elapsed. PURE. */
export function isDue(lastMs: number | null, nowMs: number, intervalMs = WATCH_INTERVAL_MS): boolean {
  if (lastMs === null) return true;
  // A stamp from the future is a clock that moved, not a fresh answer.
  if (lastMs > nowMs) return true;
  return nowMs - lastMs >= intervalMs;
}

function recordAsk(path: string, nowMs: number, found: string | null): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const stamp: WatchStamp = { schema: 1, askedAtMs: nowMs, ...(found ? { found } : {}) };
    writeFileSync(path, `${JSON.stringify(stamp, null, 2)}\n`);
  } catch {
    // A stamp that cannot be written costs one extra question next time,
    // which is cheaper than failing an update over bookkeeping.
  }
}

/**
 * Take the lock, or answer null because somebody else holds it.
 *
 * `wx` is the whole mechanism: creating a file exclusively is atomic on
 * every filesystem this runs on, which a read-then-write is not. The
 * same shape guards the GitHub rate-limit record in src/github-rate.ts.
 */
export function takeWatchLock(
  path: string,
  /**
   * Real wall-clock milliseconds, not an injected one: this is compared
   * against the lock file's mtime, which the filesystem stamps with the
   * real clock whatever the caller believes the time is.
   */
  nowMs: number,
  staleMs = WATCH_LOCK_MS,
): number | null {
  const lock = `${path}.lock`;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    return null;
  }
  const open = (): number | null => {
    try {
      return openSync(lock, "wx", 0o600);
    } catch {
      return null;
    }
  };

  const first = open();
  if (first !== null) return first;
  try {
    if (nowMs - statSync(lock).mtimeMs <= staleMs) return null;
    unlinkSync(lock);
  } catch {
    return null;
  }
  return open();
}

export function releaseWatchLock(path: string, fd: number): void {
  try {
    closeSync(fd);
  } finally {
    try {
      unlinkSync(`${path}.lock`);
    } catch {
      // Gone already is the outcome this wanted.
    }
  }
}

/** How a watch run ended, in the words the log and the exit code use. */
export type WatchOutcome =
  | "current"
  | "took"
  | "staged"
  | "not-due"
  | "busy"
  | "unreachable"
  | "refused";

export interface WatchResult {
  outcome: WatchOutcome;
  reason: string;
}

export interface WatchOptions {
  home?: string;
  nowMs?: number;
  /** Ask even inside the interval. What a person typing the command means. */
  force?: boolean;
  intervalMs?: number;
  manifestPlatform?: Platform;
  /** The take, injected for the tests. Defaults to the staged update. */
  take?: () => Promise<WatchResult>;
  /** The crossing, injected for the tests. Defaults to crossToWindows. */
  cross?: (p: Platform) => Promise<Crossing>;
}

/**
 * Ask, and take what is there.
 *
 * Quiet by construction: the common answer is "current", and a machine
 * that says so on every shell start would be a machine nobody reads the
 * output of. Only a run that changed something speaks.
 */
export async function watchRedSkills(opts: WatchOptions = {}): Promise<WatchResult> {
  const home = opts.home ?? (process.env["HOME"] ?? process.env["USERPROFILE"] ?? "").replace(/\\/g, "/");
  const nowMs = opts.nowMs ?? Date.now();
  const stamp = watchStampPath(home);

  if (!opts.force && !isDue(lastAskedAt(stamp), nowMs, opts.intervalMs)) {
    return { outcome: "not-due", reason: "asked recently enough" };
  }

  // Real time for the lock (see takeWatchLock); `nowMs` is the run's
  // own clock and may be injected.
  const fd = takeWatchLock(stamp, Date.now());
  if (fd === null) return { outcome: "busy", reason: "another run holds the watch lock" };

  try {
    const result = await (opts.take ?? (() => defaultTake(opts)))();

    // The other half of a WSL machine, whatever this half found: the
    // Windows side keeps its own stamp, so asking it costs nothing when
    // it asked recently and is the only trigger it has when it did not.
    if (opts.manifestPlatform) {
      const crossing = await (opts.cross ?? crossToWindows)(opts.manifestPlatform);
      // Said out loud only to a person who typed the command. A skip is
      // the ordinary answer on a machine with one half, and the first
      // version of this could not explain itself at all.
      if (opts.force && opts.manifestPlatform.env === "wsl") {
        log.plain(`       windows: ${crossing.reason}`);
      }
    }

    // Stamped after the ask, not before: a run that could not reach the
    // publisher has not had its answer, and must not silence the next
    // trigger for a quarter of an hour on the strength of a failure.
    //
    // And a release still uploading is stamped short rather than not at
    // all: not stamping would let every trigger through, which on a
    // ten-minute timer beside a shell hook is a machine asking the
    // publisher continuously while a release finishes. A minute is long
    // enough to be polite and short enough to catch it.
    if (result.outcome !== "unreachable") {
      const short = notReady(result) ? nowMs - WATCH_INTERVAL_MS + WATCH_NOT_READY_MS : nowMs;
      recordAsk(stamp, short, result.outcome === "current" ? null : result.reason);
    }
    return result;
  } finally {
    releaseWatchLock(stamp, fd);
  }
}

/** The real take: the staged update, which is ADR 0012's one acquisition. */
async function defaultTake(opts: WatchOptions): Promise<WatchResult> {
  const { runStagedUpdate } = await import("./staged-update.ts");
  const staged = await runStagedUpdate({
    ...(opts.manifestPlatform ? { manifestPlatform: opts.manifestPlatform } : {}),
  });

  const acquisition = staged.surfaces.find((s) => s.surface === "acquisition");
  const reason = acquisition?.reason ?? staged.outcome;

  // The acquisition's own verdict decides `current` and `unreachable`:
  // the update's outcome is about every surface, and those two are
  // facts about the publisher. Read off the surface rather than out of
  // its prose, so a reworded sentence cannot change what this does.
  if (acquisition?.acquisition === "current") return { outcome: "current", reason };
  if (acquisition?.acquisition === "unreachable") return { outcome: "unreachable", reason };
  if (acquisition?.acquisition === "refused") return { outcome: "refused", reason };
  if (staged.outcome === "staged") return { outcome: "staged", reason };
  if (staged.outcome === "failed") return { outcome: "refused", reason };
  return { outcome: "took", reason };
}

/**
 * Ask the Windows side to look too, from inside a distro.
 *
 * A WSL machine is two machines: two roots, two package sets, two
 * red-devs. The distro's watch moves the distro and nothing else, and
 * the Windows half has no trigger of its own — a shell profile is bash's
 * and PowerShell reads none of it, and the daemon's host hook execs
 * inside the distro and cannot reach across (see reportBoundary in
 * src/redwall-hook.ts, which says the same thing about Worker events).
 *
 * So the crossing is the remedy the Redwall already ships: the distro's
 * red-dev reaches the Windows side through interop. Through the hidden
 * runner, because red-dev.exe is a console program and a console
 * program started from a process without one gets a black rectangle
 * drawn on somebody's desktop — the whole reason windows-hidden.ts
 * exists.
 *
 * Detached and never awaited: a shell starting must not wait for a
 * Windows process, and the far side keeps its own stamp and its own
 * lock, so this is free whenever that side asked recently.
 */
/**
 * The red-devs a Windows side can be asked through, newest first.
 *
 * **Not the mise shim.** A shim is a small program that re-enters mise
 * to find the real one, and mise cannot do that when it is started from
 * inside a distro: it answers `mise ERROR Version:` and exits, which is
 * exactly what the first version of this crossing asked it to do — the
 * kick was sent, wscript started, and nothing on the far side ever
 * moved. So the crossing names real executables: mise's installed
 * copies, newest version first, then boot.ps1's.
 *
 * A directory read rather than a glob, so this stays one function with
 * one failure mode. A Windows side mise has never touched has no
 * installs tree and answers with the bootstrap copy alone.
 */
export function windowsRedDevCandidates(
  localAppData: string,
  readdir: (dir: string) => string[] = defaultReaddir,
): string[] {
  const root = localAppData.replace(/[\\/]+$/, "");
  const installs = `${root}/mise/installs/red-dev`;
  const versions = readdir(installs)
    // Selector links (`1`, `1.0`, `latest`) sit beside the real versions
    // and point at one of them. Taking a link is taking the same binary
    // under a name that moves, so only full versions count.
    .filter((name) => /^\d+\.\d+\.\d+/.test(name))
    .sort(byVersionDesc)
    .map((name) => `${installs}/${name}/red-dev.exe`);

  return [...versions, `${root}/red-dev/bin/red-dev.exe`];
}

function defaultReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Newest first, numerically, so 1.0.10 sorts above 1.0.9. PURE. */
function byVersionDesc(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? -1) !== (y[i] ?? -1)) return (y[i] ?? -1) - (x[i] ?? -1);
  }
  return 0;
}

/** Why a crossing did not happen, or that it did. */
export type Crossing = { outcome: "kicked" | "skipped"; reason: string };

/**
 * Ask the Windows side to look too, from inside a distro.
 *
 * A WSL machine is two machines: two roots, two package sets, two
 * red-devs. The distro's watch moves the distro and nothing else, and
 * the Windows half has no trigger of its own — a shell profile is
 * bash's and PowerShell reads none of it, and the daemon's host hook
 * execs inside the distro and cannot reach across (see reportBoundary
 * in src/redwall-hook.ts, which says the same about Worker events).
 *
 * So the crossing is the remedy the Redwall already ships: the distro's
 * red-dev reaches the Windows side through interop. Through the hidden
 * runner, because red-dev.exe is a console program and a console
 * program started from a process without one draws a black rectangle on
 * somebody's desktop — the whole reason windows-hidden.ts exists.
 *
 * Every path is asked of Windows rather than assembled here.
 * `LOCALAPPDATA` does not exist inside a distro, and the first version
 * of this function called `windowsBinDir()` anyway, threw, caught its
 * own exception and reported "skipped" — so the crossing never once
 * happened and nothing said so. Hence both the lookup below and the
 * reason strings: a skip that cannot explain itself is how this stayed
 * broken for exactly as long as nobody checked.
 *
 * Detached and never awaited: a shell starting must not wait for a
 * Windows process, and the far side keeps its own stamp and its own
 * lock, so this costs nothing whenever that side asked recently.
 */
export async function crossToWindows(p: Platform): Promise<Crossing> {
  if (p.env !== "wsl") return { outcome: "skipped", reason: "not a distro; nothing to cross to" };

  const { existsSync } = await import("node:fs");
  const { windowsLocalAppData } = await import("./wsl.ts");
  const { windowsPathFor } = await import("./windows-hidden.ts");
  const { hiddenRunnerPath } = await import("./redwall-hook.ts");

  let local: string;
  try {
    // The WSL spelling, asked of Windows and cached: a redirected
    // profile or a second drive defeats every guess about /mnt/c.
    local = await windowsLocalAppData();
  } catch (err) {
    return { outcome: "skipped", reason: `could not read %LOCALAPPDATA%: ${(err as Error).message}` };
  }

  const here = windowsRedDevCandidates(local).find((path) => existsSync(path));
  if (here === undefined) {
    return { outcome: "skipped", reason: `no red-dev.exe under ${local}` };
  }

  const binary = await windowsPathFor(here, p);
  if (binary === null) return { outcome: "skipped", reason: `wslpath could not spell ${here}` };

  const runner = await hiddenRunnerPath(p);
  if (runner === null) {
    return { outcome: "skipped", reason: "the hidden runner could not be installed" };
  }

  // Through a .cmd file rather than a command line, and this is the
  // whole reason the crossing never worked. The argument used to be
  //
  //     "C:\...\red-dev.exe" red-skills watch due
  //
  // one string carrying quotes, and quotes do not survive the trip from
  // Bun through WSL interop into wscript: what arrived was a literal
  // \"C:\...\red-dev.exe\", which the shell then reported as a command
  // it did not recognise. The kick was sent, wscript started, and
  // nothing ever ran — three times, each time looking like a different
  // bug. An argument with *no* quotes in it crosses intact, so the
  // quoting moves into a file where nothing can mangle it.
  const wrapper = `${local}/red-dev/red-skills-watch.cmd`;
  try {
    mkdirSync(dirname(wrapper), { recursive: true });
    // CRLF because it is a Windows batch file, and `@echo off` so the
    // hidden console it never gets is not asked to print anything.
    writeFileSync(wrapper, `@echo off\r\n"${binary}" red-skills watch due\r\n`);
  } catch (err) {
    return { outcome: "skipped", reason: `could not write ${wrapper}: ${(err as Error).message}` };
  }

  const wrapperOnWindows = await windowsPathFor(wrapper, p);
  if (wrapperOnWindows === null) {
    return { outcome: "skipped", reason: `wslpath could not spell ${wrapper}` };
  }

  try {
    const proc = Bun.spawn(["wscript.exe", "//B", "//Nologo", runner, wrapperOnWindows], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    proc.unref();
    return { outcome: "kicked", reason: `asked ${binary}` };
  } catch (err) {
    return { outcome: "skipped", reason: `wscript could not start: ${(err as Error).message}` };
  }
}

/**
 * Whether the publisher answered "not yet" rather than "nothing new".
 *
 * Read from the refusal the acquisition already words for a person —
 * the release exists and carries no package set — because that is the
 * one refusal that is a matter of timing rather than of trust.
 */
function notReady(result: WatchResult): boolean {
  return result.outcome === "refused" && /publishes no package-set/.test(result.reason);
}

/** One line, and only when something happened. */
export function announceWatch(result: WatchResult): void {
  switch (result.outcome) {
    case "took":
      log.ok(`red-skills: ${result.reason}`);
      return;
    case "staged":
      log.ok(`red-skills: ${result.reason}`);
      return;
    case "refused":
      log.warn(`red-skills: ${result.reason}`);
      return;
    default:
      // current, not-due, busy, unreachable: nothing a person needs.
      return;
  }
}
