import { toolPolicy } from "./tool-policy.ts";
import { runsHere } from "./workstation.ts";
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
 * red-dev itself and portable agent hosts now use the same route. Agent
 * choices stay in agents.ts; installing one writes its `latest` selector
 * through `mise use -g`, while RedCode also belongs to the workstation
 * suite fragment because it is part of the default RedDB environment.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { log } from "./log.ts";
import { providerFor, TOOLS, type Tool } from "./manifest.ts";
import { AGENTS } from "./agents.ts";
import type { Platform } from "./platform.ts";
import { convergeMiseGithubAuth } from "./mise-github.ts";

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
  /** A mise version selector. Managed catalog entries always use "latest". */
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
  /** The package was reviewed and is expected to trip aube's popularity gate. */
  allowLowDownloads?: true;
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
 * Reconcile the long-running service with mise's own red-dev binary.
 * The bootstrap in ~/.local/bin can be older than the mise installation, and
 * PATH ordering during a tool postinstall is not the interactive shell's PATH.
 * MISE_TOOL_INSTALL_PATH is the RedRouter version directory, so ../.. is the
 * common installs directory. Linux's `latest` link follows future upgrades.
 */
export const RED_ROUTER_RECONCILE_POSTINSTALL =
  '"$MISE_TOOL_INSTALL_PATH/../../red-dev/latest/red-dev" red-router install';

/**
 * Run the exact binary mise just installed, not an old bootstrap earlier
 * on PATH. Linux upgrades retire old resource controls; desktops also
 * reconcile GNOME. Neither operation re-enters mise.
 * MISE_TOOL_INSTALL_PATH is supplied by mise's tool-level postinstall.
 */
export const RED_DEV_RESOURCE_POSTINSTALL = '"$MISE_TOOL_INSTALL_PATH/red-dev" doctor --repair workloads --apply';
export const RED_DEV_DESKTOP_POSTINSTALL = `${RED_DEV_RESOURCE_POSTINSTALL} && "$MISE_TOOL_INSTALL_PATH/red-dev" desktop reconcile`;

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
const RED_ROUTER_ALIAS = "red-router";

/**
 * Where mise keeps everything it owns on this machine.
 *
 * `MISE_DATA_DIR` first, because a machine that moved it moved all of
 * it. Then the platform default — and the two are *not* the same shape:
 * mise follows XDG on unix and `%LOCALAPPDATA%\mise` on Windows, where
 * there is no XDG anything. This resolved to `~/.local/share/mise` on
 * every platform until 2026-08-19, which on Windows is a directory mise
 * has never read. Two things were quietly wrong there for as long as
 * they had existed:
 *
 *   - the local `red-skills-set` plugin (ADR 0010) was written to
 *     `C:\Users\<me>\.local\share\mise\plugins`, so mise never saw
 *     it and `mise upgrade red-skills` had nothing to dispatch into;
 *   - `miseToolBin` found nothing, so the signature verifier fell back
 *     to the bare name and a converge that had just installed cosign
 *     reported `Executable not found in $PATH: "cosign"` — on a Windows
 *     machine, every time, no matter how many times it was re-run.
 *
 * XDG is honoured on unix only. `XDG_DATA_HOME` set on Windows is
 * somebody's WSL habit leaking through the environment, not a place
 * mise will look.
 */
export function miseDataRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string {
  const explicit = env["MISE_DATA_DIR"];
  if (explicit) return explicit;

  if (platform === "win32") {
    const local = env["LOCALAPPDATA"];
    if (local) return join(local, "mise");
    return join(homedir(), "AppData", "Local", "mise");
  }

  const xdg = env["XDG_DATA_HOME"];
  if (xdg) return join(xdg, "mise");
  return join(homedir(), ".local", "share", "mise");
}

/**
 * The directory mise installs tools into.
 *
 * Used to tell a mise-managed copy of a command apart from the one
 * somebody installed by hand, which is the only way to say which of two
 * identical binaries an upgrade will actually move.
 */
export function miseInstallRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(miseDataRoot(env), "installs");
}

/**
 * mise's shim for one tool, when there is one. PURE-ish.
 *
 * A shim is a small program that re-enters mise and execs whatever the
 * current version is, so its path never changes. That makes it the one
 * stable answer on Windows, where the `latest` selector is written as a
 * regular file holding `.\\<version>` rather than as a directory link —
 * a symlink there needs a privilege an ordinary process does not have.
 *
 * Not for every caller: a shim is useless where mise cannot run, which
 * is precisely the WSL-to-Windows crossing (`mise ERROR Version:` from
 * inside a distro). Callers that cross a boundary want `miseToolBin`.
 */
export function miseShim(tool: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const windows = process.platform === "win32";
  const path = join(miseDataRoot(env), "shims", windows ? `${tool}.exe` : tool);
  return existsSync(path) ? path : null;
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
    for (const rel of windows ? [`${exe}.exe`, join("bin", `${exe}.exe`), `${exe}.cmd`, join("bin", `${exe}.cmd`), join("node_modules", ".bin", `${exe}.cmd`)] : [exe, join("bin", exe), join("node_modules", ".bin", exe)]) {
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
  return join(miseDataRoot(env), "plugins");
}

/** Where the fragment lands. */
export function miseConfigPath(home?: string): string {
  const root = home ? join(home, ".config", "mise") :
    process.env["MISE_CONFIG_DIR"] ??
    (process.platform === "win32"
      ? join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "mise")
      : join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "mise"));
  return join(root, "conf.d", "10-reddb-io.toml");
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
 * Everything red-dev curates is exempt from a `minimum_release_age` gate.
 *
 * mise can hold a tool back until a release has been public for some
 * time — a good default against a compromised or hastily-yanked
 * upstream, and one a person sets globally for everything they install.
 * Applied to what red-dev itself installs it produces a machine that
 * cannot be fixed: red-dev cut 1.0.64 to move a directory, a WSL distro
 * with a 24h gate kept resolving `latest` to 1.0.51, and the older
 * binary recreated the directory the newer one had just moved, on every
 * run. The updater being subject to the delay means the delay outlives
 * whatever it was protecting against.
 *
 * The same holds for the agents (claude, codex, redcode, ...) and the
 * catalogue tools: a short list of high-quality publishers we chose on
 * purpose, whose release the person wants the day it ships. A quarantine
 * there only produces "update available" banners that `mise upgrade`
 * then declines to act on.
 *
 * What stays outside the exemption is everything the person added to
 * their own config.toml: the gate they set still covers those.
 *
 * ## Written twice, because the fragment alone does not carry it
 *
 * mise resolves a *list* setting by precedence rather than by union:
 * the value in the person's own `config.toml` replaces the fragment's
 * outright, it does not extend it. A machine with
 * `minimum_release_age_excludes = ["npm:@reddb-io/red-skills"]` in
 * their global config therefore excluded the core and nothing else —
 * the fragment's longer list lost silently, and the plugin packages sat
 * a release behind the core until somebody looked. Measured on the
 * machine that found it: core at 3.22.0, all three plugins at 3.19.5,
 * and a package set refused as a downgrade because a composed set is
 * the *oldest* version common to all of them.
 *
 * So the fragment keeps this block — it is the right answer for a
 * machine with no list of its own, and it is readable — and red-dev
 * additionally passes the same list as `MISE_MINIMUM_RELEASE_AGE_EXCLUDES`
 * on its own invocations of mise (`runMise` in src/providers.ts), where
 * the environment outranks every config file. Those invocations name
 * curated tools one at a time, so replacing the list for the length of
 * one `mise install` reaches nothing else the person owns.
 *
 * mise matches an exclusion by the name the tool is declared under, so
 * both the registry short name (`claude`) and the backend-qualified spec
 * (`github:reddb-io/redcode`) work; verified against mise 2026.9.
 */
export function releaseAgeExcludes(
  entries: readonly MiseEntry[],
  hosts: readonly { mise?: string }[] = [],
): string[] {
  const specs = [
    ...entries.map((e) => e.spec),
    ...hosts.flatMap((h) => (h.mise ? [h.mise] : [])),
  ];
  return [...new Set(specs)].sort();
}

/**
 * No release-age gate at all, for the mise calls red-dev makes itself.
 *
 * The exemption above names curated tools, and the runtimes red-dev
 * installs (node, python, ...) are not among them, so they still waited
 * out mise's default day. Measured on the maintainer's machine: Claude Code 2.1.284 was
 * published, the native installer had it, and every mise path — `mise
 * upgrade`, `red-dev agents update` — kept answering 2.1.283 as current
 * for another nineteen hours. A machine that red-dev keeps on `latest`
 * installs the latest as soon as it exists; a wait is a pin with a
 * timer on it.
 *
 * Environment, not config: it outranks whatever the person set in their
 * own `config.toml`, and it reaches only the commands red-dev runs.
 * Their own `mise upgrade` keeps whatever gate they chose for it, apart
 * from the curated tools the exemption above names.
 */
export const MISE_NO_RELEASE_AGE: Readonly<Record<string, string>> = {
  MISE_MINIMUM_RELEASE_AGE: "0",
};

export function renderMiseConfig(
  entries: MiseEntry[],
  hosts: readonly { mise?: string }[] = [],
  credentialCommand = "gh auth token --hostname github.com",
): string {
  const sorted = [...entries].sort((a, b) => key(a).localeCompare(key(b)));

  const out: string[] = [
    HEADER,
    "",
    "# Use the account already selected by `gh auth login`. The token is",
    "# read for each mise process and never copied into this file.",
    "[settings.github]",
    `credential_command = ${str(credentialCommand)}`,
    "",
    "# Reuse remote metadata for ordinary installs and version checks.",
    "# `red-dev update` bypasses this cache to discover new releases.",
    "[settings]",
    'fetch_remote_versions_cache = "1h"',
  ];

  const excludes = releaseAgeExcludes(sorted, hosts);
  if (excludes.length > 0) {
    out.push(
      "",
      "# A release-age gate must not hold back what red-dev curates.",
      "# See releaseAgeExcludes in src/mise-config.ts.",
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
      const options = [
        `version = ${str(e.version)}`,
        ...(e.postinstall ? [`postinstall = ${str(e.postinstall)}`] : []),
        ...(e.allowLowDownloads ? ["allow_low_downloads = true"] : []),
      ];
      out.push(options.length > 1 ? `${key} = { ${options.join(", ")} }` : `${key} = ${str(e.version)}`);
    }
  }

  return `${out.join("\n")}\n`;
}

/** The tools this platform gets from mise, in manifest order. */
export function miseEntries(
  p: Platform,
  tools: readonly Tool[] = TOOLS,
  hosts: readonly { key?: string; mise?: string; miseSuite?: true; cmd: string; placement?: import("./workstation.ts").Placement }[] = AGENTS,
): MiseEntry[] {
  const entries: MiseEntry[] = [];

  // Agent hosts whose release is managed by mise. They live in the agent
  // catalog because red-skills wires its marketplace into them. Without
  // this projection `mise upgrade` would know nothing about the copy
  // red-dev installed.
  for (const host of hosts) {
    if (p.profile?.agents !== undefined && !p.profile.agents.includes(host.key ?? host.cmd)) continue;
    if (host.mise && host.miseSuite && runsHere(host.placement ?? "both", p)) {
      const policy = toolPolicy(host.cmd, host.mise);
      if (policy.mode !== "external") entries.push({ spec: host.mise, alias: host.cmd, version: policy.mode === "fixed" ? policy.version : "latest" });
    }
  }

  for (const tool of tools) {
    const pr = providerFor(tool, p);
    if (pr.kind !== "mise") continue;
    entries.push({
      spec: pr.spec,
      ...(pr.alias ? { alias: pr.alias } : {}),
      version: pr.version ?? "latest",
      ...(pr.allowLowDownloads ? { allowLowDownloads: true as const } : {}),
      // Resident services reconcile after whichever mise operation moved
      // their package. RedSkills reaches the Worker-gated host/companion
      // walk; RedRouter rewrites its generated service definition and loads
      // the new executable when that definition changed.
      ...(pr.alias === REDSKILLS_ALIAS ? { postinstall: REDSKILLS_RECONCILE_POSTINSTALL } : {}),
      ...(pr.alias === RED_ROUTER_ALIAS
        ? { postinstall: p.os === "linux" ? RED_ROUTER_RECONCILE_POSTINSTALL : "red-dev red-router install" }
        : {}),
      ...(pr.alias === "red-dev" && p.os === "linux"
        ? { postinstall: p.env === "desktop" ? RED_DEV_DESKTOP_POSTINSTALL : RED_DEV_RESOURCE_POSTINSTALL } : {}),
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
  return miseEntries(p, tools).filter(e => toolPolicy(e.alias ?? e.spec, e.spec).mode === "follow").map((e) => e.alias ?? e.spec);
}

/**
 * The same tools, spelled the way mise resolves them without help. PURE.
 *
 * `mise prune --tools <name>` looks the name up in the active config,
 * and an alias only exists there once the conf.d fragment has been
 * written. On a machine where it has not — every machine before the
 * fragment existed, and any whose `red-dev install` never reached it —
 * `mise prune --tools redcode` matches nothing and exits 0, which is
 * how one host collected fifteen versions of RedCode and 2.9 GB while
 * every update reported a successful prune. The backend-qualified spec
 * needs no alias to resolve, so retention is named by spec.
 */
export function miseToolSpecs(p: Platform, tools: readonly Tool[] = TOOLS): string[] {
  return miseEntries(p, tools).filter(e => toolPolicy(e.alias ?? e.spec, e.spec).mode === "follow").map((e) => e.spec);
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
  opts: { home?: string; tools?: readonly Tool[]; hosts?: readonly { mise?: string }[] } = {},
): ConvergeMiseConfigResult {
  const path = miseConfigPath(opts.home);
  const entries = miseEntries(p, opts.tools ?? TOOLS);
  const auth = convergeMiseGithubAuth(
    dirname(dirname(path)),
    p.os === "windows" ? "win32" : "linux",
    opts.home ? undefined : process.env["MISE_CONFIG_FILE"],
  );
  const desired = renderMiseConfig(entries, opts.hosts ?? AGENTS, auth.command);

  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === desired) return { path, changed: auth.changed, entries: entries.length };

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
