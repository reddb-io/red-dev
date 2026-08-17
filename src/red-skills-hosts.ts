/**
 * Refreshing the agent hosts, gated on the version actually having moved.
 *
 * Once mise owns the RedSkills version, a converge has a fact it never
 * had before: the resolved checkout under `~/.red-skills/current`, which
 * changes exactly when a new package set landed and never otherwise. That
 * fact is what this module spends.
 *
 * Refreshing a host is a marketplace update plus one plugin update per
 * declared plugin — several CLI invocations and a network round trip
 * each, per host, and the plan is for five hosts. A converge runs often
 * and the overwhelming majority of them resolve the version they resolved
 * last time, so running the walk unconditionally is a cost paid on every
 * converge for a result identical to doing nothing.
 *
 * ## The stamp is per host, not per machine
 *
 * A single "last refreshed at" would be wrong in both directions. A host
 * installed after the last refresh would be recorded as current on a tree
 * it never read, and a host that refused the call would mark the whole
 * machine as done. So each host records the checkout it was last
 * refreshed against, exactly the way red-skills-ext.ts records the
 * checkout each artifact was last built from — and for the same reason:
 * asking the host what version it has answers a question about the
 * marketplace cache rather than about the tree behind it.
 *
 * Only a host that succeeded is stamped. Absence, refusal and a crash all
 * leave the entry as it was, so the next converge asks again. The cost of
 * being wrong that way is one extra refresh; the cost of the other way is
 * a host frozen on an old tree with nothing anywhere saying so.
 *
 * ## One failure does not end the walk
 *
 * A machine with several agents on it usually has one of them broken for
 * its own reasons — a half-written config, a login that expired. That is
 * a fact about that host, so it is reported against that host and the
 * rest of the walk continues.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";

import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import type { Tool } from "./manifest.ts";

/**
 * One host red-dev refreshes, and the commands that refresh it.
 *
 * `argv` is a function of the plugin set rather than a fixed list: which
 * plugins this machine carries is the manifest's answer, and a table that
 * wrote them down would be a second place for that to be declared.
 */
export interface SkillHostRefresh {
  /** Key in the stamp, and the name that appears in a log line. */
  name: string;
  /** The command that has to be on PATH for this host to exist. */
  cmd: string;
  /** The refresh, as argv, in the order it has to be issued. */
  argv: (plugins: readonly string[]) => string[][];
}

/**
 * The hosts red-dev drives itself.
 *
 * Claude and Codex are CLI calls, and each answers in its own currency —
 * both spellings were read off the installed CLIs rather than assumed:
 *
 *   claude  `plugin marketplace update <name>`  then `plugin update <p>`
 *   codex   `plugin marketplace upgrade <name>` then `plugin add <p>`
 *
 * Codex has no `plugin update`. Its `add` reinstalls from the refreshed
 * marketplace snapshot, which is the same fallback the marketplace
 * repair in agents.ts already relies on.
 *
 * OpenCode, RedCode and pi are refreshed by the generators inside the
 * installed tree rather than by commands red-dev spells out, so they join
 * this table with the slice that invokes them.
 */
export const REFRESH_HOSTS: readonly SkillHostRefresh[] = [
  {
    name: "claude",
    cmd: "claude",
    argv: (plugins) => [
      ["claude", "plugin", "marketplace", "update", "red-skills"],
      ...plugins.map((p) => ["claude", "plugin", "update", `${p}@red-skills`]),
    ],
  },
  {
    name: "codex",
    cmd: "codex",
    argv: (plugins) => [
      ["codex", "plugin", "marketplace", "upgrade", "red-skills"],
      ...plugins.map((p) => ["codex", "plugin", "add", `${p}@red-skills`]),
    ],
  },
];

/** Which checkout each host was last refreshed against. */
export type HostStamp = Record<string, string>;

/** What one host did, or the reason it did nothing. */
export interface HostRefreshOutcome {
  /** The host's name in REFRESH_HOSTS. */
  host: string;
  /** True only when every command for this host succeeded. */
  refreshed: boolean;
  /** Why not, present exactly when `refreshed` is false. */
  reason?: string;
}

/**
 * Everything the walk needs from outside itself.
 *
 * All of it has a real default and exists for the tests: a refresh is a
 * sequence of commands issued to CLIs that may not be installed, against
 * a checkout that may not exist, and the thing worth pinning is which
 * commands ran and which did not.
 */
export interface HostRefreshOptions {
  /** Defaults to this user's home. The stamp lives under it. */
  home?: string;
  /** The resolved checkout. Defaults to `resolvedSource()`. */
  source?: string | null;
  /** The plugin set. Defaults to whatever the manifest declares. */
  plugins?: readonly string[];
  /** The manifest to derive the plugin set from. Defaults to TOOLS. */
  tools?: readonly Tool[];
  /** The hosts to walk. Defaults to REFRESH_HOSTS. */
  hosts?: readonly SkillHostRefresh[];
  /** Is this host's command on PATH? Defaults to `commandPath`. */
  present?: (cmd: string) => boolean;
  /** Runs one argv and answers its exit code. Defaults to spawnLogged. */
  run?: (cmd: string[]) => Promise<number>;
}

function homeOf(): string {
  const h = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  return h.replace(/\\/g, "/");
}

/** Computed rather than a constant: the tests move home between cases. */
export function hostStampPath(home: string): string {
  return `${home}/.local/share/red-dev/red-skills-hosts.json`;
}

export function readHostStamp(home: string): HostStamp {
  const path = hostStampPath(home);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as HostStamp;
  } catch {
    // A stamp we cannot read means refresh, which is the safe way to be
    // wrong: the cost is one extra walk, not a permanently stale host.
    return {};
  }
}

async function writeHostStamp(home: string, stamp: HostStamp): Promise<void> {
  const path = hostStampPath(home);
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Bun.write(path, `${JSON.stringify(stamp, null, 2)}\n`);
}

/** `v3.4.0` out of the resolved path, for a log line a person reads. */
function versionOf(source: string): string {
  return source.split("/").pop() ?? source;
}

/**
 * Refresh every host whose recorded checkout is not the one resolved now.
 *
 * Answers one outcome per host in table order, including the hosts it
 * left alone — "absent", "already current" and "refused" are three
 * different facts and a caller that wants to report them needs to be able
 * to tell them apart.
 *
 * With no checkout at all there is nothing to refresh against, and that
 * is not a failure: it is the ordinary state of a machine before the mise
 * entry has installed the core. It answers with no outcomes at all.
 */
export async function refreshSkillHosts(
  p: Platform,
  opts: HostRefreshOptions = {},
): Promise<HostRefreshOutcome[]> {
  const home = opts.home ?? homeOf();
  const hosts = opts.hosts ?? REFRESH_HOSTS;

  const source = opts.source !== undefined ? opts.source : await currentSource();
  if (source === null) {
    log.skip("red-skills: not installed, no host to refresh");
    return [];
  }

  const plugins = opts.plugins ?? (await declaredPlugins(p, opts.tools));
  const present = opts.present ?? (await presenceProbe());
  const run = opts.run ?? (await defaultRunner());

  const version = versionOf(source);
  const stamp = readHostStamp(home);
  const out: HostRefreshOutcome[] = [];

  for (const host of hosts) {
    if (!present(host.cmd)) {
      // Deliberately not stamped: a host that arrives next week has to be
      // refreshed then, and recording it now would say it already was.
      out.push({ host: host.name, refreshed: false, reason: `${host.cmd} is not installed` });
      continue;
    }

    if (stamp[host.name] === source) {
      log.skip(`${host.name}: red-skills already refreshed at ${version}`);
      out.push({ host: host.name, refreshed: false, reason: `already refreshed at ${version}` });
      continue;
    }

    log.step(`${host.name}: refreshing red-skills against ${version}`);
    const failure = await refreshOne(host, plugins, run);
    if (failure !== null) {
      // Reported and survived. The stamp keeps whatever it held, so the
      // next converge asks this host again.
      log.warn(`${host.name}: ${failure}`);
      out.push({ host: host.name, refreshed: false, reason: failure });
      continue;
    }

    stamp[host.name] = source;
    await writeHostStamp(home, stamp);
    log.ok(`${host.name}: red-skills refreshed to ${version}`);
    out.push({ host: host.name, refreshed: true });
  }

  return out;
}

/** Runs one host's commands, and answers the first failure or null. */
async function refreshOne(
  host: SkillHostRefresh,
  plugins: readonly string[],
  run: (cmd: string[]) => Promise<number>,
): Promise<string | null> {
  for (const cmd of host.argv(plugins)) {
    let code: number;
    try {
      code = await run(cmd);
    } catch (error) {
      return `${cmd.join(" ")} could not be run: ${(error as Error).message}`;
    }
    if (code !== 0) return `${cmd.join(" ")} exited ${code}`;
  }
  return null;
}

async function currentSource(): Promise<string | null> {
  const { resolvedSource } = await import("./red-skills-ext.ts");
  return resolvedSource();
}

async function declaredPlugins(p: Platform, tools?: readonly Tool[]): Promise<string[]> {
  const { redSkillsPluginNames } = await import("./red-skills-plugins.ts");
  return redSkillsPluginNames(p, tools);
}

async function presenceProbe(): Promise<(cmd: string) => boolean> {
  const { commandPath } = await import("./agents.ts");
  return (cmd: string) => commandPath(cmd) !== null;
}

async function defaultRunner(): Promise<(cmd: string[]) => Promise<number>> {
  const { spawnLogged } = await import("./providers.ts");
  return (cmd: string[]) => spawnLogged(cmd);
}
