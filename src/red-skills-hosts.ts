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
 * each, per host, across five hosts — and for three of them a generator
 * run that walks the whole skill tree. A converge runs often
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
 *
 * ## Two kinds of host, and why they are not symmetrical
 *
 * Claude and Codex are CLI calls red-dev makes itself: both expose a
 * marketplace and a plugin cache, and refreshing them is a handful of
 * arguments spelled out here.
 *
 * OpenCode, RedCode and pi have no marketplace. Their surface is
 * generated — plugin modules, skill trees, MCP and TUI config — by
 * scripts that ship inside the RedSkills tree, beside the skills they
 * render. So this file invokes those scripts and never reimplements
 * them: a generator ported into this repo would be separated from the
 * tree it renders, and a skill added to RedSkills would have to wait for
 * a red-dev release before it could appear on anyone's machine.
 *
 * The scripts are addressed by path inside the resolved checkout, which
 * is also how each one finds the tree it renders — it resolves its own
 * repo root from `dirname $0/..`. Invoking `<source>/scripts/...` is
 * therefore the whole of "with the tree as their source".
 *
 * ## Unwiring goes back through the same scripts
 *
 * The generators write an uninstall manifest recording every path they
 * created, and their `--uninstall` removes what that manifest names and
 * nothing else. That conservatism is the point: a config directory holds
 * files nobody here put there. So unwiring is the same script with one
 * more flag, exactly as the standalone installer calls it, rather than a
 * second opinion in this repo about what RedSkills left behind.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";

import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import type { Tool } from "./manifest.ts";

/**
 * One command in a host's wiring.
 *
 * `optional` is what `try_run … || true` is in the shared installer, and
 * it is load-bearing rather than decorative: removing a plugin that was
 * never installed exits non-zero, and treating that as a failed host
 * would leave a machine permanently unstamped and permanently rewalked.
 */
export interface HostStep {
  /** The command, as argv. */
  argv: string[];
  /** A non-zero exit here is reported, and the host carries on. */
  optional?: boolean;
}

/**
 * What a host's commands are a function of.
 *
 * The plugin set because which plugins this machine carries is the
 * manifest's answer, and a table that wrote them down would be a second
 * place for that to be declared. The checkout because three of the five
 * hosts are wired by scripts that live inside it.
 */
export interface HostContext {
  /** The plugin set this machine declares. */
  plugins: readonly string[];
  /** The resolved checkout — `~/.red-skills/versions/v<x>`, resolved. */
  source: string;
}

/** One host red-dev wires RedSkills into, and how. */
export interface SkillHostRefresh {
  /** Key in the stamp, and the name that appears in a log line. */
  name: string;
  /** The command that has to be on PATH for this host to exist. */
  cmd: string;
  /** The refresh, in the order it has to be issued. */
  wire: (ctx: HostContext) => HostStep[];
  /** The removal, in the order it has to be issued. */
  unwire: (ctx: HostContext) => HostStep[];
}

/** A command whose failure fails the host. */
function must(...argv: string[]): HostStep {
  return { argv };
}

/** A command whose failure is reported and stepped over. */
function may(...argv: string[]): HostStep {
  return { argv, optional: true };
}

/**
 * A generator inside the installed tree, addressed by path.
 *
 * The path is the whole contract. Each script resolves its own repo root
 * from where it sits, so naming it under `source` is what hands it the
 * tree — there is no second flag saying which checkout to render, and
 * inventing one here would be a place for the two to disagree.
 */
function generator(source: string, script: string): string {
  return `${source}/scripts/${script}`;
}

/**
 * OpenCode and RedCode, which are the same generator with a `--host`.
 *
 * RedCode is an OpenCode-compatible host: same generated surface, a
 * different config directory. The shared installer expresses that as one
 * function called twice, and so does this — a second table row spelling
 * the same three flags out again is a place for them to drift.
 */
function opencodeCompatible(host: string): SkillHostRefresh {
  const script = (source: string) => generator(source, "install-opencode.sh");
  return {
    name: host,
    cmd: host,
    wire: ({ source }) => [must(script(source), "--global", "--host", host)],
    unwire: ({ source }) => [must(script(source), "--uninstall", "--global", "--host", host)],
  };
}

/**
 * The five hosts, and what each one is asked.
 *
 * Claude and Codex answer in their own currency, and both spellings were
 * read off the installed CLIs rather than assumed:
 *
 *   claude  `plugin marketplace update <name>`  then `plugin update <p>`
 *   codex   `plugin marketplace upgrade <name>` then `plugin add <p>`
 *
 * Codex has no `plugin update` at all, so a refresh there is a remove
 * followed by an add: the add reinstalls from the marketplace snapshot
 * the line above it just upgraded. The remove is optional because a
 * plugin that is not installed yet — the first converge on this machine,
 * or a plugin the operator only just opted in to — makes it exit
 * non-zero, and that is not a broken host.
 *
 * OpenCode, RedCode and pi are the tree's own generators, invoked with
 * the tree as their source. pi takes `--source-dir` as well as the path,
 * because it can install its packages from npm instead and the local
 * checkout is what pins every host on this machine to one version.
 */
export const REFRESH_HOSTS: readonly SkillHostRefresh[] = [
  {
    name: "claude",
    cmd: "claude",
    wire: ({ plugins }) => [
      must("claude", "plugin", "marketplace", "update", "red-skills"),
      ...plugins.map((p) => must("claude", "plugin", "update", `${p}@red-skills`)),
    ],
    unwire: ({ plugins }) => [
      // `--keep-data`, matching the shared installer: unwiring a host is
      // not a request to delete whatever the plugin stored for you.
      ...plugins.map((p) => may("claude", "plugin", "remove", "--keep-data", p)),
      may("claude", "plugin", "marketplace", "remove", "red-skills"),
    ],
  },
  {
    name: "codex",
    cmd: "codex",
    wire: ({ plugins }) => [
      must("codex", "plugin", "marketplace", "upgrade", "red-skills"),
      ...plugins.flatMap((p) => [
        may("codex", "plugin", "remove", `${p}@red-skills`),
        must("codex", "plugin", "add", `${p}@red-skills`),
      ]),
    ],
    unwire: ({ plugins }) => [
      ...plugins.map((p) => may("codex", "plugin", "remove", `${p}@red-skills`)),
      may("codex", "plugin", "marketplace", "remove", "red-skills"),
    ],
  },
  opencodeCompatible("opencode"),
  opencodeCompatible("redcode"),
  {
    name: "pi",
    cmd: "pi",
    wire: ({ source }) => [
      must(generator(source, "install-pi.sh"), "--source-dir", source, "--user"),
    ],
    unwire: ({ source }) => [must(generator(source, "install-pi.sh"), "--uninstall", "--user")],
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
  const ctx: HostContext = { plugins, source };
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
    const failure = await runSteps(host.wire(ctx), run);
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

/** Runs one host's commands, and answers the first hard failure or null. */
async function runSteps(
  steps: readonly HostStep[],
  run: (cmd: string[]) => Promise<number>,
): Promise<string | null> {
  for (const step of steps) {
    const what = step.argv.join(" ");
    let code: number;
    try {
      code = await run(step.argv);
    } catch (error) {
      if (step.optional) {
        log.warn(`${what} could not be run: ${(error as Error).message}`);
        continue;
      }
      return `${what} could not be run: ${(error as Error).message}`;
    }
    if (code === 0) continue;
    if (step.optional) {
      log.skip(`${what} exited ${code}, which this step is allowed to do`);
      continue;
    }
    return `${what} exited ${code}`;
  }
  return null;
}

/** What one host did on the way out, or the reason it did nothing. */
export interface HostUnwireOutcome {
  /** The host's name in REFRESH_HOSTS. */
  host: string;
  /** True only when every required command for this host succeeded. */
  unwired: boolean;
  /** Why not, present exactly when `unwired` is false. */
  reason?: string;
}

/**
 * Take RedSkills back out of every host on the machine.
 *
 * The generator hosts route through the same scripts that wired them,
 * which remove what their own manifest recorded and leave everything
 * else alone — see the header. Claude and Codex are the CLI calls that
 * undo the CLI calls above.
 *
 * With no checkout there is nothing to unwire *through*: the scripts
 * live in the tree, and this repo deliberately holds no second opinion
 * about which files RedSkills wrote. So a machine with no checkout is
 * left alone and says so, rather than being guessed at.
 *
 * A host that comes out has its stamp entry dropped. The stamp means
 * "this host has been refreshed against that checkout", which stops
 * being true the moment the host is unwired — leaving it would let the
 * next converge skip re-wiring a host that no longer has anything.
 */
export async function unwireSkillHosts(
  p: Platform,
  opts: HostRefreshOptions = {},
): Promise<HostUnwireOutcome[]> {
  const home = opts.home ?? homeOf();
  const hosts = opts.hosts ?? REFRESH_HOSTS;

  const source = opts.source !== undefined ? opts.source : await currentSource();
  if (source === null) {
    log.skip("red-skills: not installed, no host to unwire");
    return [];
  }

  const plugins = opts.plugins ?? (await declaredPlugins(p, opts.tools));
  const present = opts.present ?? (await presenceProbe());
  const run = opts.run ?? (await defaultRunner());

  const ctx: HostContext = { plugins, source };
  const stamp = readHostStamp(home);
  const out: HostUnwireOutcome[] = [];

  for (const host of hosts) {
    if (!present(host.cmd)) {
      out.push({ host: host.name, unwired: false, reason: `${host.cmd} is not installed` });
      continue;
    }

    log.step(`${host.name}: removing red-skills`);
    const failure = await runSteps(host.unwire(ctx), run);
    if (failure !== null) {
      log.warn(`${host.name}: ${failure}`);
      out.push({ host: host.name, unwired: false, reason: failure });
      continue;
    }

    if (host.name in stamp) {
      delete stamp[host.name];
      await writeHostStamp(home, stamp);
    }
    log.ok(`${host.name}: red-skills removed`);
    out.push({ host: host.name, unwired: true });
  }

  return out;
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
