/**
 * The copy that answers to the name, after red-dev installed another one.
 *
 * A publisher moving mechanism is ordinary — RedCode went from an npm
 * package to a GitHub release, Codex from npm to a standalone build —
 * and red-dev follows the move the moment its catalog does. What it did
 * not do was clear the field. The old copy stays where the old
 * mechanism put it, and on this machine that place wins:
 *
 *   position  7   ~/.local/share/mise/installs/node/24/bin/redcode   0.8.1
 *   position 27   ~/.local/share/mise/shims/redcode                  0.8.1
 *   position 28   ~/.local/bin/redcode                               0.11.0
 *
 * `mise activate` puts the active runtime's `bin` ahead of everything,
 * and that is where an npm global lands. So red-dev downloaded 0.11.0,
 * verified its checksum, reported `ok RedCode (github-release) v0.11.0`,
 * and the machine went on running 0.8.1 — three releases and two hours
 * of a person's afternoon, with every log line saying success.
 *
 * ## Why this is not the shadow report
 *
 * `src/shadowed.ts` exists and `doctor` runs it, and its own comment
 * describes this exact failure. It begins `if (pr.kind !== "mise")
 * continue` — it only examines tools mise provides, and an agent
 * installed from a GitHub release into `~/.local/bin` is not one. The
 * detector was there, the doctor called it, and the one class of tool it
 * skipped is the class that broke.
 *
 * This runs at the other end: not "is something shadowed" asked of a
 * catalog, but "is the thing I just installed the thing that runs"
 * asked of PATH, immediately after installing it. A question with one
 * right answer, asked where the answer is still cheap to act on.
 *
 * ## What it is willing to remove
 *
 * Only on three independent confirmations: red-dev installed this agent
 * by a mechanism that is not npm, the binary PATH resolves instead is
 * inside a node `lib/node_modules` tree, and npm's global list holds
 * that package. Anything else is reported with the command that would
 * fix it and left alone — a tool that removes software on a guess is
 * worse than the shadow.
 */

import { realpathSync } from "node:fs";

import { log } from "./log.ts";

/** What answers to a name, and whether it is what red-dev put there. PURE-ish. */
export interface ShadowCheck {
  /** What PATH resolves, fully resolved through links. */
  running: string | null;
  /** What red-dev installed, fully resolved through links. */
  installed: string | null;
  /** They are different files, and the one that runs is not ours. */
  shadowed: boolean;
}

/** Resolve through links, or answer null rather than throw. */
function real(path: string | null): string | null {
  if (path === null) return null;
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Whether the copy that runs is the copy red-dev installed. */
export function checkShadow(runningPath: string | null, installedPath: string | null): ShadowCheck {
  const running = real(runningPath);
  const installed = real(installedPath);
  return {
    running,
    installed,
    shadowed: running !== null && installed !== null && running !== installed,
  };
}

/**
 * The npm package a path belongs to, or null. PURE.
 *
 * `lib/node_modules/<name>` or `lib/node_modules/@scope/<name>`, which
 * is where every global install lands whatever prefix npm was given.
 * Read off the path rather than asked of npm, because the question here
 * is which package *this file* came from and npm can only answer which
 * packages exist.
 */
export function npmPackageOf(path: string): string | null {
  const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path.replace(/\\/g, "/"));
  return m?.[1] ?? null;
}

export interface ShadowRepair {
  outcome: "clear" | "repaired" | "reported";
  reason: string;
}

export interface ShadowRepairOptions {
  /** The command name, e.g. `redcode`. */
  cmd: string;
  /** What red-dev just installed, before link resolution. */
  installedPath: string | null;
  /** What PATH resolves for `cmd`. */
  runningPath: string | null;
  /** npm's executable, or null when there is none to ask. */
  npm: string | null;
  /** The packages npm's global tree holds. */
  npmGlobals: ReadonlySet<string>;
  /** Runs one argv, answering its exit code. */
  run: (argv: string[]) => Promise<number>;
  /** Whether mise is here to have its shims rebuilt. */
  mise?: string | null;
}

/**
 * Make the copy red-dev installed the copy that runs, or say why not.
 */
export async function repairShadow(opts: ShadowRepairOptions): Promise<ShadowRepair> {
  const check = checkShadow(opts.runningPath, opts.installedPath);
  if (!check.shadowed || check.running === null) {
    return { outcome: "clear", reason: `${opts.cmd} runs the copy red-dev installed` };
  }

  const pkg = npmPackageOf(check.running);
  const owned = pkg !== null && opts.npmGlobals.has(pkg);
  if (!owned || opts.npm === null) {
    // Reported with the path, because a person can act on a path and
    // cannot act on "something else is first".
    return {
      outcome: "reported",
      reason: `${opts.cmd} on PATH is ${check.running}, not ${check.installed} — remove the first one and this takes effect`,
    };
  }

  log.warn(`${opts.cmd}: ${pkg} shadows the copy red-dev installed — removing it`);
  await opts.run([opts.npm, "uninstall", "-g", pkg]);
  // The shim outlives the package it was generated for, and a stale one
  // answers ahead of ~/.local/bin exactly as the package did.
  if (opts.mise) await opts.run([opts.mise, "reshim"]);

  return {
    outcome: "repaired",
    reason: `removed ${pkg}, which shadowed ${opts.cmd} with an older copy`,
  };
}
