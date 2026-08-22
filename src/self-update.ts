/**
 * red-dev taking a red-dev.
 *
 * ADR 0017 gave this machine a trigger for RedSkills and stopped there,
 * so for a day the package set tracked the publisher within ten minutes
 * while red-dev itself moved only when somebody typed a command. Four
 * releases shipped on 2026-08-21 and not one reached either half until
 * it was asked to, twice, by hand — and one of those asks silently did
 * nothing, which is the second half of what this file is for.
 *
 * ## Two questions, two answers, and only one of them is mise's
 *
 * ADR 0008 settled that **mise owns red-dev's version**: it installs
 * every release, the shims sit ahead of boot.ps1's copy on PATH, and a
 * migration retires that copy. None of that changes here — the install
 * is still `mise upgrade`.
 *
 * What does change is who decides there is something to install.
 * `mise upgrade red-dev` answered "All tools are up to date" against a
 * cached version list that predated the release, so the upgrade was a
 * no-op, the machine stayed three versions back, and the run that
 * followed reproduced a bug that had already been fixed. Measured, and
 * then measured again on the other half the same day.
 *
 * So the question is asked of the publisher directly, by the same
 * mechanism `agents update` already uses for a GitHub-released host: a
 * HEAD against `releases/latest/download/<asset>` and the tag read off
 * the redirect. No API call, no token, no rate limit — and no cache
 * between the machine and the truth. mise is then told to install, with
 * its cache for this one tool cleared first so that it cannot answer
 * the question again and disagree.
 *
 * ## The version is what moved, not what mise said
 *
 * The verdict comes from asking the binary PATH now resolves, after the
 * fact. mise removes the previous install once the new one is in place,
 * and on Windows that removal fails while the previous one is the
 * running process — a non-zero exit for a cleanup, on an upgrade that
 * worked. Reading the exit code would call that a failure; reading the
 * version calls it what it is.
 */

import { log } from "./log.ts";
import type { Platform } from "./platform.ts";

/** The repository every red-dev release is published from. */
export const RED_DEV_REPO = "reddb-io/red-dev";

/**
 * The asset this machine's red-dev is published as, or null. PURE.
 *
 * Only the two targets a release actually carries. An architecture with
 * no asset is not a machine that should be told an update is available.
 */
export function redDevAsset(p: Platform): string | null {
  if (p.arch !== "x64") return null;
  return p.os === "windows" ? "red-dev-windows-x64.exe" : "red-dev-linux-x64";
}

/** Compare two dotted versions. Positive when `a` is newer. PURE. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

export type SelfUpdateOutcome =
  /** The publisher has nothing newer. */
  | "current"
  /** This machine now runs a newer red-dev than it did. */
  | "took"
  /** The publisher could not be asked. Not a failure. */
  | "unreachable"
  /** There is something newer and this machine cannot take it. */
  | "unavailable"
  /** It was asked for and the version did not move. */
  | "refused";

export interface SelfUpdate {
  outcome: SelfUpdateOutcome;
  reason: string;
  /** The version this process is. */
  from: string;
  /** The version the publisher offers, when it could be read. */
  latest: string | null;
}

export interface SelfUpdateOptions {
  /** The version this process is. */
  current: string;
  platform: Platform;
  /** The publisher's newest tag. Defaults to the redirect probe. */
  latest?: (repo: string, asset: string) => Promise<string | null>;
  /** Runs one argv, answering its exit code. Defaults to a bounded spawn. */
  run?: (argv: string[]) => Promise<number>;
  /** What `red-dev` on PATH answers now. Defaults to asking it. */
  installed?: () => Promise<string | null>;
  /** Whether mise holds red-dev at all. Defaults to looking. */
  owned?: () => Promise<boolean>;
}

/**
 * How long the upgrade gets.
 *
 * A red-dev release is a single ~90 MB binary and mise verifies it, so
 * a minute is slow and five is broken. This runs unattended beside the
 * RedSkills watch, and a spawn with no deadline there holds a lock that
 * silences every trigger behind it — the failure this repository spent
 * a day on.
 */
const UPGRADE_MS = 300_000;

/** Take a newer red-dev, if the publisher has one and mise can place it. */
export async function updateRedDev(opts: SelfUpdateOptions): Promise<SelfUpdate> {
  const { current, platform } = opts;
  const asset = redDevAsset(platform);
  if (asset === null) {
    return {
      outcome: "unavailable",
      reason: `no red-dev release is published for ${platform.os}/${platform.arch}`,
      from: current,
      latest: null,
    };
  }

  const tag = await (opts.latest ?? defaultLatest)(RED_DEV_REPO, asset);
  if (tag === null) {
    return {
      outcome: "unreachable",
      reason: "the publisher could not be asked",
      from: current,
      latest: null,
    };
  }

  const latest = tag.replace(/^v/, "");
  if (compareVersions(latest, current) <= 0) {
    return { outcome: "current", reason: `already on ${current}`, from: current, latest };
  }

  const owned = await (opts.owned ?? miseHoldsRedDev)();
  if (!owned) {
    // boot.ps1 and boot.sh place a copy mise knows nothing about, and
    // replacing a running binary in place is not something to do behind
    // somebody's back. ADR 0008 puts red-dev under mise for exactly
    // this; a machine that has not made that move is told, not moved.
    return {
      outcome: "unavailable",
      reason: `${latest} is published and mise does not hold red-dev here — \`red-dev install core\` puts it under mise`,
      from: current,
      latest,
    };
  }

  const run = opts.run ?? boundedRun;
  // The whole cache, not this tool's.
  //
  // `mise cache clear red-dev` is the obvious call and it does not do
  // this job: measured on the machine, it left `mise latest red-dev`
  // still answering 1.0.100 after 1.0.101 was published, and only the
  // unqualified `mise cache clear` moved it. The remote version list is
  // not filed under the tool whose versions it holds.
  //
  // Wiping every tool's list is heavier than it looks and cheaper than
  // it sounds: this line is only reached once the publisher has already
  // been asked and has already said there is something newer, so it
  // runs once per release rather than once per ten minutes.
  await run(["mise", "cache", "clear"]);
  await run(["mise", "upgrade", "red-dev"]);

  // The verdict is the version, not the exit code — see the note at the
  // top of this file about what mise's cleanup does on Windows.
  const now = await (opts.installed ?? installedVersion)();
  if (now !== null && compareVersions(now, current) > 0) {
    return { outcome: "took", reason: `${current} -> ${now}`, from: current, latest };
  }
  return {
    outcome: "refused",
    reason: `${latest} is published and this machine is still on ${now ?? current}`,
    from: current,
    latest,
  };
}

async function defaultLatest(repo: string, asset: string): Promise<string | null> {
  const { resolveReleaseTag } = await import("./agent-update.ts");
  return await resolveReleaseTag(repo, asset);
}

async function boundedRun(argv: string[]): Promise<number> {
  const { spawnLogged } = await import("./providers.ts");
  return await spawnLogged(argv, { timeoutMs: UPGRADE_MS });
}

/** Whether mise holds a red-dev of its own on this machine. */
async function miseHoldsRedDev(): Promise<boolean> {
  try {
    // Asked of the filesystem rather than of PATH: a shim answers for a
    // tool mise has never installed, which is the opposite of what this
    // needs to know. `miseToolBin` walks the install tree.
    const { miseToolBin } = await import("./mise-config.ts");
    return miseToolBin("red-dev") !== null;
  } catch {
    return false;
  }
}

/**
 * What mise's copy of red-dev answers now — not what PATH answers.
 *
 * This asked PATH first, and PATH is the wrong witness for the question
 * "did mise place a newer one". A machine that has run both installers
 * has boot's copy in `~/.local/bin`, mise never touches it, and on the
 * maintainer's workstation it came first: the upgrade genuinely placed
 * 1.0.106, this read `~/.local/bin/red-dev` and got 1.0.104, and the run
 * reported
 *
 *     warn red-dev: 1.0.106 is published and this machine is still on 1.0.104
 *
 * about an upgrade that had just succeeded. The next tick then ran the
 * new binary and went quiet — a false alarm, once, on the one event a
 * person would want to be able to trust.
 *
 * It is the same mistake `redwallBinary` was fixed for hours earlier,
 * in a second function, which is why it is now asked of the same
 * resolver rather than spelled again here.
 */
async function installedVersion(): Promise<string | null> {
  try {
    const { runBounded } = await import("./bounded-command.ts");
    const { redwallBinary } = await import("./redwall-hook.ts");
    const { detect } = await import("./platform.ts");
    const exe = await redwallBinary(detect());
    const result = await runBounded([exe, "--version"], { timeoutMs: 10_000 });
    return /(\d+\.\d+\.\d+[^\s]*)/.exec(result.stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** One line, and only when a person needs it. */
export function announceSelfUpdate(u: SelfUpdate): void {
  switch (u.outcome) {
    case "took":
      log.ok(`red-dev: ${u.reason} — the new one runs from your next command`);
      return;
    case "refused":
      log.warn(`red-dev: ${u.reason}`);
      return;
    case "unavailable":
      log.skip(`red-dev: ${u.reason}`);
      return;
    default:
      // current and unreachable: nothing happened and nothing is wrong.
      return;
  }
}
