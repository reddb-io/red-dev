/**
 * Retention for RedSkills: what mise prunes, and what nothing prunes.
 *
 * Nothing on this machine ever removed a RedSkills version. Measured on
 * one developer host before this file existed: 1003 MB of extracted
 * trees under ~/.red-skills/versions, 93 MB of retained tarballs under
 * ~/.red-skills/cache and 69 MB of per-version plugin copies inside the
 * agent hosts — about 1.16 GB, all of it accumulated one install at a
 * time by something that only ever added.
 *
 * From here the versions are mise's, and so is the policy that retires
 * them: `mise prune` at the end of an update deletes the versions no
 * config still names. Writing a keep-N of our own would be
 * reimplementing the half of the tool we adopted it for.
 *
 * What mise cannot collect is everything above — a shape it never
 * created and therefore will never look at. That is what this module
 * removes, once, and it is the reason the two halves are separate
 * rather than one pass: pruning is a policy that runs forever, and this
 * is a migration that runs on a machine carrying the old install mode's
 * leftovers and then has nothing left to do.
 *
 * ## The line this draws
 *
 * migrations.ts says a migration may repair and must not remove, and
 * the exception here is drawn as narrowly as the one the release-binary
 * handover already pays for: everything below is *derived* state — a
 * published artifact extracted a second time, a tarball already
 * unpacked, a plugin copy the host rebuilds on demand — and the tree
 * anything resolves through is protected explicitly rather than by
 * being missed.
 *
 * Three protections carry that:
 *
 *  - `~/.red-skills/current` is resolved first, and the version it
 *    names is never a candidate. If it does not resolve at all, the
 *    version trees are left alone entirely: a prune with nothing
 *    protected is one that would take the tree the machine is about to
 *    use.
 *  - A version directory that is a link is left alone. Those are the
 *    new layout's links into mise's installs; they cost nothing, and
 *    what they point at is mise's to prune, not ours to delete through.
 *  - A host's plugin copy is removed only when the host has a newer one
 *    and does not record this one as installed. A copy a host still
 *    resolves through is not derived state, it is the plugin.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What kind of leftover this is, so the report can group them. */
export type LegacyKind = "version-tree" | "tarball" | "plugin-copy";

export interface LegacyItem {
  path: string;
  kind: LegacyKind;
  /** What removing it gives back, which is the whole point of removing it. */
  bytes: number;
}

export interface LegacyCleanupOptions {
  /** Defaults to this user's home. Injected by the tests. */
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * A host that keeps its own copy of each plugin version.
 *
 * The Spec is explicit that this work removes RedSkills' duplication
 * rather than the host's: a host caches a plugin per version whatever
 * the marketplace source is, and that is its business. What is
 * collected here is the *history* — the versions it kept after moving
 * on — which no host ever revisits and none of them delete.
 */
interface HostPluginCache {
  /** `<host>/plugins/cache`, under which each marketplace has a directory. */
  cache: string;
  /**
   * The copies this host records as installed, or null when it has a
   * record this module could not read. Null refuses the host outright:
   * an unreadable record is not evidence that nothing is installed.
   */
  installed: () => Set<string> | null;
}

/** The marketplace name both hosts file RedSkills plugins under. */
const MARKETPLACE = "red-skills";

const EXACT_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

export function hostPluginCaches(home: string): HostPluginCache[] {
  return [
    {
      cache: join(home, ".claude", "plugins", "cache"),
      installed: () => claudeInstalledPaths(home),
    },
    // Codex records that a plugin is enabled in config.toml and not
    // where it put it, so there is nothing to read back. It keeps one
    // version per plugin in practice, and the newest-version protection
    // below is what covers it.
    { cache: join(home, ".codex", "plugins", "cache"), installed: () => new Set<string>() },
  ];
}

/**
 * Everything the old install mode left behind, and nothing else.
 *
 * A plan rather than a sweep: the migration removes exactly what this
 * returns, the tests assert against it without deleting anything, and
 * an empty plan is what makes a second run a no-op instead of a second
 * deletion.
 */
export function planLegacyRedSkillsCleanup(opts: LegacyCleanupOptions = {}): LegacyItem[] {
  const home = opts.home ?? homeOf(opts.env ?? process.env);
  return [
    ...supersededVersionTrees(home),
    ...retainedTarballs(home),
    ...hostPluginCaches(home).flatMap((host) => supersededPluginCopies(host)),
  ];
}

export interface LegacyCleanup {
  removed: LegacyItem[];
  /** The sum of what was removed, for the one line worth reading. */
  bytes: number;
}

/**
 * Remove the plan, and report what actually went.
 *
 * An item that cannot be removed is dropped from the report rather than
 * thrown: this runs unattended, and one locked directory is not a
 * reason to abandon the gigabyte beside it. It stays in the plan, so
 * the next run asks again.
 */
export function clearLegacyRedSkills(opts: LegacyCleanupOptions = {}): LegacyCleanup {
  const removed: LegacyItem[] = [];
  for (const item of planLegacyRedSkillsCleanup(opts)) {
    try {
      rmSync(item.path, { recursive: true, force: true });
    } catch {
      continue;
    }
    if (existsSync(item.path)) continue;
    removed.push(item);
  }
  return { removed, bytes: removed.reduce((sum, item) => sum + item.bytes, 0) };
}

/**
 * The extracted trees under ~/.red-skills/versions, minus the live one.
 *
 * Only real directories: a link there is what the ADR 0008 layout
 * left, pointing into mise's installs, and removing it would both cost
 * nothing and risk deleting through it. (The package set that replaced
 * that layout lives under ~/.red-skills/sets, and red-skills-set.ts
 * retires its own revisions.)
 */
function supersededVersionTrees(home: string): LegacyItem[] {
  const versions = join(home, ".red-skills", "versions");
  const current = resolved(join(home, ".red-skills", "current"));
  if (current === null) return [];

  const out: LegacyItem[] = [];
  for (const name of listing(versions)) {
    const path = join(versions, name);
    const stat = statOf(path);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (resolved(path) === current) continue;
    out.push({ path, kind: "version-tree", bytes: treeBytes(path) });
  }
  return out;
}

/**
 * The tarballs ~/.red-skills/cache kept after unpacking them.
 *
 * The directory itself stays. It is where the standalone installer
 * downloads to, and on a machine that still uses it an absent cache
 * directory is a thing to recreate rather than a thing to have.
 */
function retainedTarballs(home: string): LegacyItem[] {
  const cache = join(home, ".red-skills", "cache");
  const out: LegacyItem[] = [];
  for (const name of listing(cache)) {
    if (!name.endsWith(".tar.gz")) continue;
    const path = join(cache, name);
    const stat = statOf(path);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) continue;
    out.push({ path, kind: "tarball", bytes: stat.size });
  }
  return out;
}

/**
 * One host's superseded plugin copies.
 *
 * Per plugin, the highest version stays and everything below it goes,
 * along with anything the host names as installed — which is what keeps
 * a host that is deliberately on an older version working. A directory
 * whose name is not a version is left alone too: it was put there by
 * something this module does not understand.
 */
function supersededPluginCopies(host: HostPluginCache): LegacyItem[] {
  const installed = host.installed();
  if (installed === null) return [];

  const root = join(host.cache, MARKETPLACE);
  const out: LegacyItem[] = [];
  for (const plugin of listing(root)) {
    const pluginDir = join(root, plugin);
    const versions = listing(pluginDir)
      .map((name) => ({ name, parts: versionParts(name) }))
      .filter((v): v is { name: string; parts: number[] } => v.parts !== null)
      .sort((a, b) => compareVersions(a.parts, b.parts));

    // Everything but the last, which is the newest this host holds.
    for (const version of versions.slice(0, -1)) {
      const path = join(pluginDir, version.name);
      if (installed.has(path)) continue;
      const stat = statOf(path);
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
      out.push({ path, kind: "plugin-copy", bytes: treeBytes(path) });
    }
  }
  return out;
}

/**
 * The copies Claude Code records as installed, by path.
 *
 * Claude writes the install path of every plugin it carries into
 * installed_plugins.json, which makes "is anything resolving through
 * this directory" a question with an answer rather than a guess. A file
 * that is there and cannot be parsed answers null, and the caller
 * leaves the whole host alone.
 */
function claudeInstalledPaths(home: string): Set<string> | null {
  const path = join(home, ".claude", "plugins", "installed_plugins.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Absent, which is a host that has installed nothing.
    return new Set<string>();
  }

  try {
    const parsed = JSON.parse(raw) as { plugins?: Record<string, { installPath?: unknown }[]> };
    const out = new Set<string>();
    for (const entries of Object.values(parsed.plugins ?? {})) {
      for (const entry of entries ?? []) {
        if (typeof entry?.installPath === "string") out.add(normalise(entry.installPath));
      }
    }
    return out;
  } catch {
    return null;
  }
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return normalise(env["HOME"] ?? env["USERPROFILE"] ?? homedir());
}

function normalise(path: string): string {
  return path.replace(/\\/g, "/");
}

function listing(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function statOf(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** The path a link ends at, or null when there is nothing at the end of it. */
function resolved(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function versionParts(name: string): number[] | null {
  const m = EXACT_VERSION.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Segment by segment, so 3.10.0 comes after 3.9.0. */
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * What one tree occupies, following nothing.
 *
 * Walked rather than shelled out to `du`, which does not exist on every
 * target this runs on, and counted with lstat so a link inside the tree
 * contributes its own size instead of the size of whatever it names.
 */
function treeBytes(path: string): number {
  const stat = statOf(path);
  if (!stat) return 0;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
  let total = 0;
  for (const name of listing(path)) total += treeBytes(join(path, name));
  return total;
}
