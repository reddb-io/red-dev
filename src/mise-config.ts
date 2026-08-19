/**
 * The mise config fragment that makes the reddb-io suite updatable.
 *
 * Every tool in this organisation shipped with its own installer and no
 * updater. `red-dev update` upgraded what apt and winget owned and left
 * the suite — and red-dev itself — frozen at whatever version the last
 * bootstrap happened to fetch. The only way forward was to re-run the
 * boot one-liner and hope.
 *
 * mise already solves this, and solves it without asking anything of the
 * repositories: its `github:` backend reads the release assets directly
 * and scores them by OS, architecture, libc and archive format. Nothing
 * had to be added to reddb-io/reddb, reddb-io/toon or any of the others
 * for `mise install github:reddb-io/reddb` to work — that was verified
 * against the real releases before this file existed.
 *
 * What mise deliberately does *not* have is a way to hand someone a set
 * of tools: there is no remote `[include]`, no bundle, no meta-package.
 * Config is assembled from `conf.d/*.toml` fragments on disk, and
 * something has to put a fragment there. That something is red-dev,
 * which is already the thing that installs mise and already carries the
 * list of what the suite is.
 *
 * So the manifest stays the single source of truth and this module is
 * only a projection of it. The rendering is a pure function over
 * entries, separate from anything that touches disk, because the
 * interesting failure is a malformed or non-deterministic file rather
 * than a failed write — and only the pure half can be tested without a
 * mise installation in the loop.
 *
 * Two things are deliberately *not* here yet.
 *
 * red-dev itself. Putting `red-dev` in this fragment is one line and
 * would make the binary self-updating, which is the open `lifecycle`
 * context in .red/CONTEXT-MAP.md. It is not one line of consequence:
 * boot.sh installs to ~/.local/bin and mise installs a shim, so a
 * machine that has run both has two copies and the winner is whichever
 * PATH order it happens to have. `mise upgrade` updating the copy
 * nobody executes is worse than no self-update at all, because it
 * reports success. That ordering has to be decided first.
 *
 * The agents (redcode and the rest). They live in agents.ts behind
 * their own install methods and their own readiness probes, which is a
 * second migration rather than another line in the manifest.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { log } from "./log.ts";
import { providerFor, TOOLS, type Tool } from "./manifest.ts";
import type { Platform } from "./platform.ts";

/**
 * One tool, as mise needs to hear about it.
 *
 * `spec` is the backend-qualified name (`github:reddb-io/reddb`), which
 * is what mise resolves. `alias` is the name a person types. They are
 * separate because the two disagree more often than not: the binary in
 * reddb-io/toon is `tq`, and the one in reddb-io/reddb is `red`.
 */
export interface MiseEntry {
  /** Backend-qualified: "github:reddb-io/reddb", "npm:@reddb-io/red-skills". */
  spec: string;
  /**
   * Short name exposed through [tool_alias].
   *
   * Absent means the spec is used verbatim. Present is what allows
   * `mise upgrade red` instead of `mise upgrade github:reddb-io/reddb`,
   * without depending on the upstream mise registry — which admits new
   * tools on a popularity bar judged case by case, with rejections that
   * are not explained.
   */
  alias?: string;
  /** A mise version selector: "1.23.2", "0.28", "latest". */
  version: string;
  /**
   * A command mise runs after it installs or upgrades this tool.
   *
   * The seam ADR 0010 asks for: `mise upgrade red-skills` has to reach
   * red-dev's host reconciliation, and mise's own tool-level
   * `postinstall` is the supported way to be told that a tool moved.
   * Absent on every other entry, because a tool that is one binary on
   * PATH has nothing for this machine to reconcile afterwards.
   */
  postinstall?: string;
}

/**
 * What mise runs after RedSkills moves.
 *
 * The command is idempotent by construction — it compares the active
 * package-set identity against the one the hosts were last converged
 * against and returns without writing when they agree — so mise
 * invoking it after a reinstall that changed nothing costs one process
 * and no host state. See reconcileRedSkills in red-skills-acquire.ts.
 */
export const REDSKILLS_RECONCILE_POSTINSTALL = "red-dev red-skills reconcile";

/**
 * The alias whose entry carries that postinstall.
 *
 * Spelled here rather than imported from red-skills-set.ts, for the
 * reason the spec is duplicated there rather than imported from here:
 * this module is what the manifest projects, and an import in the other
 * direction would close a cycle around a top-level `const`. A test pins
 * the two spellings against each other.
 */
const REDSKILLS_ALIAS = "red-skills";

/**
 * The directory mise installs tools into.
 *
 * Used to tell a mise-managed copy of a command apart from the one
 * somebody installed by hand, which is the only way to say which of two
 * identical binaries an upgrade will actually move.
 */
export function miseInstallRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["MISE_DATA_DIR"];
  if (explicit) return join(explicit, "installs");
  const xdg = env["XDG_DATA_HOME"];
  if (xdg) return join(xdg, "mise", "installs");
  return join(homedir(), ".local", "share", "mise", "installs");
}

/**
 * The binary of a mise-installed tool, by path rather than by `$PATH`.
 *
 * A converge installs a tool and then uses it, and those are two things
 * in one process: `$PATH` was read when this process started, so a tool
 * mise put on disk thirty seconds ago is not on it and will not be
 * until a new shell. Resolving through the bare command name meant the
 * item that installed cosign was followed by the item that needs it
 * reporting `Executable not found in $PATH: "cosign"` — on a machine
 * where cosign had just been installed successfully, which reads as a
 * broken install rather than as the ordering problem it is.
 *
 * mise's layout is `<installs>/<tool>/<version>/[bin/]<exe>`. The
 * version directories include symlinks (`latest`, `3`, `3.1`) beside
 * the real ones; a link is preferred where it exists, because it is
 * what mise moves when it upgrades and following it keeps this answer
 * correct after the next one. Falling back to the newest real version
 * covers a tree where nothing linked.
 *
 * Returns null when mise has no such tool, and every caller falls back
 * to the bare name: a machine that installed the tool some other way
 * still works, and the error it gets when it did not is the same one it
 * always was.
 */
export function miseToolBin(
  tool: string,
  exe: string = tool,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const root = join(miseInstallRoot(env), tool);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }

  const windows = process.platform === "win32";
  const candidates = ["latest", ...names.filter((n) => n !== "latest").sort(byVersionDesc)];
  for (const name of candidates) {
    for (const rel of windows ? [`${exe}.exe`, join("bin", `${exe}.exe`)] : [exe, join("bin", exe)]) {
      const path = join(root, name, rel);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/** Newest first, by numeric segments, so `3.10.0` sorts above `3.9.0`. */
function byVersionDesc(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.+-]/).map((n) => Number.parseInt(n, 10));
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const l = x[i];
    const r = y[i];
    if (Number.isNaN(l ?? NaN) || Number.isNaN(r ?? NaN)) return a < b ? 1 : -1;
    if ((l ?? -1) !== (r ?? -1)) return (r ?? -1) - (l ?? -1);
  }
  return 0;
}

/**
 * The directory mise keeps its plugins in.
 *
 * Beside `installs` under the same data root, and resolved the same
 * way, because a machine that moved `MISE_DATA_DIR` moved both. A local
 * plugin is a directory here; there is no registry entry and no network
 * step, which is what makes `mise plugins link` and writing the
 * directory ourselves the same act.
 */
export function misePluginRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["MISE_DATA_DIR"];
  if (explicit) return join(explicit, "plugins");
  const xdg = env["XDG_DATA_HOME"];
  if (xdg) return join(xdg, "mise", "plugins");
  return join(homedir(), ".local", "share", "mise", "plugins");
}

/** Where the fragment lands. */
export function miseConfigPath(home: string = homedir()): string {
  return join(home, ".config", "mise", "conf.d", "10-reddb-io.toml");
}

const HEADER = [
  "# Generated by red-dev. Do not edit — `red-dev install` rewrites it.",
  "#",
  "# This is a conf.d fragment, not your mise config. Your own tools and",
  "# runtimes live in ~/.config/mise/config.toml, which red-dev never",
  "# touches; mise merges the two.",
  "#",
  "# `red-dev update` refreshes these, naming them one by one. Bare",
  "# `mise upgrade` would reach your tools as well as ours, so it is not",
  "# what red-dev runs.",
].join("\n");

/**
 * Entries → TOML. Pure, total, and deterministic.
 *
 * Deterministic matters more than it looks: this file is rewritten on
 * every converge and compared against what is already on disk, so a
 * stable order is the difference between "nothing to do" and a write
 * plus a log line on every single run.
 */
/**
 * The suite is exempt from a `minimum_release_age` gate.
 *
 * mise can hold a tool back until a release has been public for some
 * time — a good default against a compromised or hastily-yanked
 * upstream, and one a person sets globally for everything they install.
 * Applied to this organisation it produces a machine that cannot be
 * fixed: red-dev cut 1.0.64 to move a directory, a WSL distro with a
 * 24h gate kept resolving `latest` to 1.0.51, and the older binary
 * recreated the directory the newer one had just moved, on every run.
 * The updater being subject to the delay means the delay outlives
 * whatever it was protecting against.
 *
 * The exemption is narrow on purpose: it names the reddb-io specs this
 * fragment declares and nothing else, so the gate a person set still
 * covers node, python, every tool they added themselves. It is written
 * here rather than asked of the person because the fragment is what
 * red-dev owns; their own `config.toml` is theirs, and mise merges the
 * two.
 */
function releaseAgeExcludes(entries: MiseEntry[]): string[] {
  return [...new Set(entries.filter((e) => isOurs(e.spec)).map((e) => e.spec))].sort();
}

/** A spec this organisation publishes, by backend and owner rather than by name. */
function isOurs(spec: string): boolean {
  return /^(github|npm):@?reddb-io[/-]/.test(spec);
}

export function renderMiseConfig(entries: MiseEntry[]): string {
  const sorted = [...entries].sort((a, b) => key(a).localeCompare(key(b)));

  const out: string[] = [HEADER];

  const excludes = releaseAgeExcludes(sorted);
  if (excludes.length > 0) {
    out.push(
      "",
      "# A release-age gate must not reach the tools that carry the fix.",
      "# See releaseAgeExcludes in src/mise-config.ts.",
      "[settings]",
      `minimum_release_age_excludes = [${excludes.map((s) => str(s)).join(", ")}]`,
    );
  }

  const aliased = sorted.filter((e) => e.alias);
  if (aliased.length > 0) {
    out.push("", "[tool_alias]");
    for (const e of aliased) out.push(`${tomlKey(e.alias ?? "")} = ${str(e.spec)}`);
  }

  if (sorted.length > 0) {
    out.push("", "[tools]");
    for (const e of sorted) {
      const key = tomlKey(e.alias ?? e.spec);
      // An inline table only where there is something to say beyond the
      // version: every other row stays the one-line form a person can
      // read, and a diff of this file keeps showing only what moved.
      out.push(
        e.postinstall
          ? `${key} = { version = ${str(e.version)}, postinstall = ${str(e.postinstall)} }`
          : `${key} = ${str(e.version)}`,
      );
    }
  }

  return `${out.join("\n")}\n`;
}

/** The tools this platform gets from mise, in manifest order. */
export function miseEntries(p: Platform, tools: readonly Tool[] = TOOLS): MiseEntry[] {
  const entries: MiseEntry[] = [];
  for (const tool of tools) {
    const pr = providerFor(tool, p);
    if (pr.kind !== "mise") continue;
    entries.push({
      spec: pr.spec,
      ...(pr.alias ? { alias: pr.alias } : {}),
      version: pr.version ?? "latest",
      // The RedSkills entry, and only it: whichever way mise advances
      // the package set — a suite upgrade, a bare `mise upgrade
      // red-skills`, a first install — the hosts are reconciled from
      // the same place afterwards, rather than only when red-dev
      // happened to be the one driving.
      ...(pr.alias === REDSKILLS_ALIAS ? { postinstall: REDSKILLS_RECONCILE_POSTINSTALL } : {}),
    });
  }
  return entries;
}

/**
 * The names `mise upgrade` has to be given to mean "only this suite".
 *
 * `mise upgrade` with no arguments upgrades every outdated tool in the
 * active config, and the active config is this fragment *merged with
 * the user's own* — so the bare form reaches the runtimes they declared
 * in config.toml, which the header of this very file promises red-dev
 * never touches. Naming the tools keeps that promise.
 */
export function miseToolNames(p: Platform, tools: readonly Tool[] = TOOLS): string[] {
  return miseEntries(p, tools).map((e) => e.alias ?? e.spec);
}

export interface ConvergeMiseConfigResult {
  path: string;
  changed: boolean;
  entries: number;
}

/**
 * Write the fragment, but only when it would differ.
 *
 * Read-compare-write rather than an unconditional write: a converge runs
 * often, and a file whose mtime moves every time is one that looks like
 * it changed to everything downstream watching it.
 */
export function convergeMiseConfig(
  p: Platform,
  opts: { home?: string; tools?: readonly Tool[] } = {},
): ConvergeMiseConfigResult {
  const path = miseConfigPath(opts.home);
  const entries = miseEntries(p, opts.tools ?? TOOLS);
  const desired = renderMiseConfig(entries);

  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === desired) return { path, changed: false, entries: entries.length };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, desired, "utf8");
  log.ok(`mise: ${entries.length} tools declared in ${path}`);
  return { path, changed: true, entries: entries.length };
}

/** A bare TOML key where the name allows it, a quoted one otherwise. */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : str(name);
}

function str(value: string): string {
  return JSON.stringify(value);
}

function key(e: MiseEntry): string {
  return e.alias ?? e.spec;
}
