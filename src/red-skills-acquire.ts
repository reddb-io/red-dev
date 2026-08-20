/**
 * Online acquisition: one mirror, immutable snapshots, same-commit assets.
 *
 * ADR 0010 gives online RedSkills acquisition to a local mise plugin —
 * channels (`stable`, `next`, an exact version, an exact commit), one
 * shared Git mirror, an immutable snapshot per revision, release assets
 * overlaid from *that* commit, the published manifest verified, and
 * red-dev's reconciliation invoked from a tool-level postinstall. ADR
 * 0011 gives the other half: what a package set is, how it is verified,
 * and that `~/.red/skills/current` may only name a verified one.
 *
 * This module is the acquisition itself, and it is deliberately not
 * written in shell inside the plugin. A plugin that cloned, snapshotted
 * and verified on its own would be a second implementation of
 * everything below, and `red-dev update` would then have to either
 * shell out to it or drift from it. So the plugin's scripts
 * (src/red-skills-mise-plugin.ts) are dispatchers into these functions,
 * `red-dev update` calls the same functions, and "both entry points
 * reach the same active digest" is true because there is only one
 * implementation to reach it with.
 *
 * ## The order is the design
 *
 *   list      `git ls-remote --tags`, which needs no clone and answers
 *             in one round trip — a channel is resolved before this
 *             machine has spent a byte of disk on it
 *   short-cut a resolved commit that is already the active revision's
 *             ends the acquisition here: no clone, no download, no
 *             copy, no reconciliation, nothing for a host to notice
 *   assets    the release's package-set manifest, which is the cheap
 *             call that says whether there is a set to acquire at all
 *   mirror    one bare mirror, cloned once and fetched afterwards
 *   snapshot  `git archive` into a directory named by the commit, which
 *             is immutable and reused by name
 *   stage     the snapshot plus the same commit's assets, as the
 *             manifest-set shape red-skills-set.ts already verifies
 *   activate  which verifies again, and only then moves `current`
 *
 * The short-cut is why "a no-op install produces no host writes" is a
 * property rather than a hope: the acquisition that changes nothing
 * returns before it has anything to change, and the reconciliation is
 * gated separately on the active identity actually having moved.
 *
 * ## Same commit, or nothing
 *
 * A snapshot is source; the bundles a host loads are built. Overlaying
 * assets from a *different* commit would produce a tree nothing ever
 * tested, with an identity that names one commit and bytes that came
 * from two — so a manifest whose `sourceCommit` is not the resolved
 * commit is refused before anything is staged, alongside the artifact
 * whose SHA-256 does not match and the release that publishes no
 * signature at all. All three refusals happen before red-dev is asked
 * to reconcile anything, which is the acceptance criterion this file
 * carries.
 *
 * ## What "unavailable" means, and why it is not a refusal
 *
 * red-skills publishes `red.package-set.v1` over its release assets but
 * does not yet publish the complete workstation tree beside it
 * (reddb-io/red-skills#3977). A release with no package-set manifest is
 * therefore the ordinary state of every machine today, not a fault: it
 * is reported as `unavailable`, the machine keeps the composed set the
 * four npm entries produce, and nothing is logged as refused. Refusals
 * are for a set that exists and is wrong.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { sha256Hex } from "./checksum.ts";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import { redSkillsPluginNames } from "./red-skills-plugins.ts";
import { redSkillsRoot } from "./red-skills-root.ts";
import {
  convergeRedSkillsPackageSet,
  cosignVerifier,
  recordPackageSetRefusal,
  hostActivationConfig,
  parsePackageSetManifest,
  healSetArtifacts,
  readPackageSetState,
  revisionKey,
  SET_BUNDLE_NAME,
  SET_MANIFEST_NAME,
  setArtifactsDir,
  verifyPackageSet,
  type PackageSetIdentity,
  type PackageSetManifest,
  type SetFailure,
  type SignatureVerifier,
} from "./red-skills-set.ts";

// -------------------------------------------------------------- the source

/** Where RedSkills is published, as `owner/repo`. */
export const REDSKILLS_REPO = "reddb-io/red-skills";

/** The Git URL the mirror is cloned from. HTTPS, so no key is needed to read it. */
export const REDSKILLS_GIT_URL = `https://github.com/${REDSKILLS_REPO}.git`;

/**
 * The channels ADR 0010 names, and nothing else.
 *
 * `stable` is the highest release with no prerelease part; `next` is
 * the highest release of any kind, which is the same commit as `stable`
 * whenever no prerelease has been published since. There is no `latest`
 * here on purpose: mise already spells that word for its own selectors,
 * and a channel that means "whatever mise would have picked" would hide
 * exactly the prerelease/release distinction these two exist to make.
 */
export type Channel = "stable" | "next";

export const CHANNELS: readonly Channel[] = ["stable", "next"];

/** The channel a machine gets when nothing selects one. */
export const DEFAULT_CHANNEL: Channel = "stable";

/** The environment variable that overrides the channel for one invocation. */
export const CHANNEL_ENV = "RED_SKILLS_CHANNEL";

/** What was asked for, once it is a thing this code can act on. */
export type Selector =
  | { kind: "channel"; channel: Channel }
  | { kind: "version"; version: string }
  | { kind: "commit"; commit: string };

const EXACT_VERSION = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const HEX40 = /^[0-9a-f]{40}$/;

/**
 * Read one selector, or refuse to guess. PURE.
 *
 * Guessing is the failure worth avoiding here: a typo that resolves to
 * "some other version" installs something nobody asked for and reports
 * success, while a typo that resolves to nothing is one line to fix.
 * `commit:` is accepted as a prefix so a 40-hex string can be *meant*
 * as a commit even where one day a tag could be spelled the same way.
 */
export function parseSelector(raw: string): Selector | null {
  const value = raw.trim();
  if (value === "") return null;
  if ((CHANNELS as readonly string[]).includes(value)) {
    return { kind: "channel", channel: value as Channel };
  }
  const explicit = value.startsWith("commit:") ? value.slice("commit:".length) : null;
  if (explicit !== null) {
    return HEX40.test(explicit.toLowerCase()) ? { kind: "commit", commit: explicit.toLowerCase() } : null;
  }
  if (HEX40.test(value.toLowerCase())) return { kind: "commit", commit: value.toLowerCase() };
  const version = EXACT_VERSION.exec(value);
  if (version?.[1]) return { kind: "version", version: version[1] };
  return null;
}

/** How a selector is written back into a log line or a state file. PURE. */
export function selectorLabel(selector: Selector): string {
  switch (selector.kind) {
    case "channel":
      return selector.channel;
    case "version":
      return selector.version;
    case "commit":
      return `commit:${selector.commit}`;
  }
}

// ------------------------------------------------------------- the listing

/** One published revision, as the remote's tags describe it. */
export interface RemoteRevision {
  /** The tag as the publisher wrote it, `v` and all — a release is looked up by this. */
  tag: string;
  /** The tag without its `v`, which is what a pinned selector is compared against. */
  version: string;
  commit: string;
  /** A version with a prerelease part: `3.20.0-next.1`. Only `next` sees these. */
  prerelease: boolean;
}

/**
 * Parse `git ls-remote --tags --refs`. PURE.
 *
 * `--refs` drops the `^{}` peel lines, so every line here is
 * `<sha>\trefs/tags/<tag>` and the sha is the tagged commit for a
 * lightweight tag. An annotated tag without `--refs` would give the tag
 * object's own sha, which is not a commit and would fail to archive —
 * so the flag is part of the contract rather than a tidiness.
 *
 * Anything that is not a release tag is dropped rather than guessed at:
 * a repository accumulates `nightly`, `latest` and hand-made tags, and
 * a channel that resolved one of those would be a channel that means
 * whatever somebody last pushed.
 */
export function parseRemoteRevisions(out: string): RemoteRevision[] {
  const seen = new Map<string, RemoteRevision>();
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{40})\s+refs\/tags\/(.+?)\s*$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const tag = m[2];
    const version = EXACT_VERSION.exec(tag)?.[1];
    if (!version) continue;
    // First writer wins, so a repository carrying both `3.19.5` and
    // `v3.19.5` resolves deterministically rather than by line order.
    if (!seen.has(version)) {
      seen.set(version, { tag, version, commit: m[1], prerelease: version.includes("-") });
    }
  }
  return [...seen.values()].sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * Order two versions the way semver does, prerelease included. PURE.
 *
 * Numeric field by numeric field, then "a release outranks its own
 * prereleases", then prerelease identifiers compared numerically where
 * both are numeric and lexically otherwise. Enough of semver to order
 * `3.19.5`, `3.20.0-next.1` and `3.20.0-next.10` correctly, which is
 * every shape this repository publishes.
 */
export function compareVersions(a: string, b: string): number {
  const [aCore = "", aPre = ""] = splitVersion(a);
  const [bCore = "", bPre = ""] = splitVersion(b);
  const aNums = aCore.split(".").map(Number);
  const bNums = bCore.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (aNums[i] ?? 0) - (bNums[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (aPre === "" && bPre === "") return 0;
  if (aPre === "") return 1;
  if (bPre === "") return -1;
  const aIds = aPre.split(".");
  const bIds = bPre.split(".");
  for (let i = 0; i < Math.max(aIds.length, bIds.length); i++) {
    const left = aIds[i];
    const right = bIds[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const numeric = /^\d+$/.test(left) && /^\d+$/.test(right);
    const cmp = numeric ? Number(left) - Number(right) : left < right ? -1 : left > right ? 1 : 0;
    if (cmp !== 0) return cmp < 0 ? -1 : 1;
  }
  return 0;
}

function splitVersion(value: string): [string, string] {
  const dash = value.indexOf("-");
  return dash < 0 ? [value, ""] : [value.slice(0, dash), value.slice(dash + 1)];
}

/** What a selector resolved to, or why it resolved to nothing. */
export type Resolution =
  | { ok: true; commit: string; version: string | null; tag: string | null }
  | { ok: false; reason: string };

/**
 * Resolve one selector against one listing. PURE, and total.
 *
 * Pure because this is the half that has to be deterministic: the same
 * listing and the same selector must name the same commit on every
 * machine, on every run, offline, forever. Everything that could make
 * it otherwise — the network, the clock, what happens to be installed —
 * is in the callers.
 *
 * A commit selector resolves to itself and is *not* required to be in
 * the listing: pinning a commit that carries no tag is the whole point
 * of having a commit selector. Its version is filled in when a tag does
 * name it, and left null otherwise; the identity a null version ends up
 * with comes from the tree's own package.json, which is where
 * red-skills-set.ts reads it from.
 */
export function resolveRevision(
  selector: Selector,
  revisions: readonly RemoteRevision[],
): Resolution {
  if (selector.kind === "commit") {
    const tagged = revisions.find((r) => r.commit === selector.commit);
    return {
      ok: true,
      commit: selector.commit,
      version: tagged?.version ?? null,
      tag: tagged?.tag ?? null,
    };
  }

  if (selector.kind === "version") {
    const hit = revisions.find((r) => r.version === selector.version);
    if (!hit) {
      return { ok: false, reason: `no release is tagged ${selector.version} in ${REDSKILLS_REPO}` };
    }
    return { ok: true, commit: hit.commit, version: hit.version, tag: hit.tag };
  }

  // Sorted here rather than trusted from the caller. parseRemoteRevisions
  // already returns them in order, and a channel that quietly resolved
  // to "whichever line the remote printed last" would be a channel that
  // works until somebody hands it a listing from somewhere else.
  const eligible = revisions
    .filter((r) => selector.channel !== "stable" || !r.prerelease)
    .sort((a, b) => compareVersions(a.version, b.version));
  const hit = eligible.at(-1);
  if (!hit) {
    return {
      ok: false,
      reason:
        selector.channel === "stable"
          ? `${REDSKILLS_REPO} publishes no stable release`
          : `${REDSKILLS_REPO} publishes no release`,
    };
  }
  return { ok: true, commit: hit.commit, version: hit.version, tag: hit.tag };
}

// -------------------------------------------------------------- the runner

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Every process this module starts goes through one injected function.
 *
 * One seam rather than a `git` seam and a `tar` seam: the tests need to
 * assert *the sequence* — one clone, then fetches, then one archive per
 * commit — and a sequence split across two mocks is a sequence neither
 * of them can see.
 */
export type CommandRunner = (argv: readonly string[], opts?: { cwd?: string }) => CommandResult;

/**
 * The real one. Never interactive: a mirror fetch that stops to ask for
 * a password is an update that hangs with no output, which is the
 * failure mode this repository has already paid for once elsewhere.
 */
export const systemRunner: CommandRunner = (argv, opts = {}) => {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) return { code: 1, stdout: "", stderr: "empty command" };
  const r = spawnSync(cmd, rest, {
    cwd: opts.cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never" },
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

// ------------------------------------------------------ mirror and snapshot

// `~/.red/skills`, decided once in src/red-skills-root.ts and re-exported
// here because this module was where every importer already looked for it.
export { redSkillsRoot } from "./red-skills-root.ts";

/**
 * The one bare mirror, shared by every revision this machine acquires.
 *
 * One directory rather than one per version, because that is the whole
 * saving: a shallow clone per install re-downloads the same history
 * every time, and the second version of the day costs a fetch of what
 * changed instead of a clone of everything.
 */
export function redSkillsMirrorDir(home: string): string {
  return join(redSkillsRoot(home), "mirror", "red-skills.git");
}

/** `~/.red/skills/snapshots/<commit>` — immutable, and reused by name. */
export function redSkillsSnapshotDir(home: string, commit: string): string {
  return join(redSkillsRoot(home), "snapshots", commit);
}

/** `~/.red/skills/candidates/<commit>` — the manifest set staged for verification. */
export function redSkillsCandidateDir(home: string, commit: string): string {
  return join(redSkillsRoot(home), "candidates", commit);
}

/** Exported so the argv can be asserted without a network. PURE. */
export function lsRemoteArgv(url: string): string[] {
  return ["git", "ls-remote", "--tags", "--refs", url];
}

/** PURE. `--mirror` because nothing works in this clone; it is only fetched from. */
export function mirrorCloneArgv(url: string, dir: string): string[] {
  return ["git", "clone", "--mirror", "--quiet", url, dir];
}

/** PURE. `--prune` so a deleted upstream tag stops resolving here too. */
export function mirrorFetchArgv(dir: string): string[] {
  return ["git", "--git-dir", dir, "fetch", "--prune", "--tags", "--quiet", "origin"];
}

/** PURE. */
export function snapshotArchiveArgv(mirror: string, commit: string, tar: string): string[] {
  return ["git", "--git-dir", mirror, "archive", "--format=tar", `--output=${tar}`, commit];
}

/**
 * PURE. `exclude` names paths tar must not attempt to create.
 *
 * The excludes come first, before `-f`: GNU tar applies an option to
 * everything after it and bsdtar does not care, so this ordering is the
 * one both agree on.
 */
export function extractArgv(tar: string, dest: string, exclude: readonly string[] = []): string[] {
  return ["tar", ...exclude.map((path) => `--exclude=${path}`), "-xf", tar, "-C", dest];
}

/** PURE. Every path in a commit, with its mode, from the bare mirror. */
export function lsTreeArgv(mirror: string, commit: string): string[] {
  return ["git", "--git-dir", mirror, "ls-tree", "-r", "-z", commit];
}

/** PURE. One blob's bytes — for a symlink, the path it points at. */
export function catBlobArgv(mirror: string, blob: string): string[] {
  return ["git", "--git-dir", mirror, "cat-file", "blob", blob];
}

/**
 * The symlinks in a commit, read from git rather than from the tarball.
 *
 * `git ls-tree -r -z` records mode `120000` for a symlink and gives the
 * blob whose content is the target. Asking git is exact; parsing `tar
 * -tv` output would be a guess about two different tar implementations'
 * column formats, and getting it wrong here means silently dropping a
 * file from a verified revision.
 *
 * NUL-separated (`-z`) because a path may contain anything, including a
 * newline, and a revision that extracted differently depending on
 * somebody's filename would be a revision with two identities.
 */
export function parseSymlinkEntries(stdout: string): { path: string; blob: string }[] {
  const out: { path: string; blob: string }[] = [];
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    // `<mode> SP <type> SP <object> TAB <path>`
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(/\s+/);
    const [mode, type, object] = meta;
    if (mode !== "120000" || type !== "blob" || !object) continue;
    out.push({ path: record.slice(tab + 1), blob: object });
  }
  return out;
}

/** Ask the remote what it publishes, without cloning anything. */
export function listRemoteRevisions(
  run: CommandRunner,
  url: string,
): { ok: true; revisions: RemoteRevision[] } | { ok: false; reason: string } {
  const r = run(lsRemoteArgv(url));
  if (r.code !== 0) {
    return { ok: false, reason: `git ls-remote ${url} exited ${r.code}: ${firstLine(r.stderr)}` };
  }
  return { ok: true, revisions: parseRemoteRevisions(r.stdout) };
}

/**
 * Clone the mirror once, fetch it every time after.
 *
 * Presence is decided by the mirror's own `HEAD`, not by the directory
 * existing: an interrupted clone leaves a directory behind, and a
 * fetch into that is an error message rather than a repair.
 */
export function ensureMirror(
  run: CommandRunner,
  opts: { url: string; dir: string },
): { ok: true; cloned: boolean } | { ok: false; reason: string } {
  const { url, dir } = opts;
  if (existsSync(join(dir, "HEAD"))) {
    const fetched = run(mirrorFetchArgv(dir));
    if (fetched.code !== 0) {
      return { ok: false, reason: `git fetch exited ${fetched.code}: ${firstLine(fetched.stderr)}` };
    }
    return { ok: true, cloned: false };
  }

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  const cloned = run(mirrorCloneArgv(url, dir));
  if (cloned.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, reason: `git clone --mirror exited ${cloned.code}: ${firstLine(cloned.stderr)}` };
  }
  return { ok: true, cloned: true };
}

/**
 * The commit's tree, extracted once and never written to again.
 *
 * `git archive` rather than a worktree or a second clone: it produces
 * source and nothing else — no `.git`, no index, nothing that a later
 * command could advance underneath a revision the machine has already
 * recorded an identity for. Staged under a `.staging-` name and renamed,
 * so a snapshot directory either does not exist or is complete; an
 * interrupted extract can never be mistaken for a revision.
 *
 * ## Symlinks, and why Windows never had a verified set
 *
 * Creating a symlink on Windows needs a privilege an ordinary process
 * does not have — Developer Mode or an elevated shell grants it, a
 * converge has neither. So `tar -xf` aborted on the first one it met,
 * the whole acquisition was refused with `tree`, and the only RedSkills
 * that ever reached a Windows machine was the *composed* one built from
 * npm payloads, which carry no symlinks. Measured on the machine that
 * found it: one symlink in the entire 4.0.1 tree
 * (`packages/worker/AGENTS.md` -> `CLAUDE.md`), and it cost that side
 * every signed set red-skills has ever published.
 *
 * Where a symlink cannot be created, it is written as a regular file
 * holding the path it pointed at — which is exactly what `git clone`
 * does on Windows when `core.symlinks` is false, so a snapshot and a
 * clone of the same commit agree. Copying the *target's contents*
 * instead was the alternative and is rejected: it makes the snapshot
 * disagree with the repository, and it has no answer for a link that
 * points at a directory or outside the tree.
 *
 * This changes nothing about what is verified. The signature covers the
 * release's artifacts, not the source tree, and the source's identity
 * is the commit — see the note at the top of this file.
 */
export function ensureSnapshot(
  run: CommandRunner,
  opts: {
    mirror: string;
    home: string;
    commit: string;
    /**
     * `native` creates real symlinks; `as-file` writes the target path
     * as a regular file. Defaults to what this platform can actually
     * do, and is named here so the Windows behaviour is testable on a
     * machine that is not Windows.
     */
    symlinks?: "native" | "as-file";
  },
): { ok: true; path: string; created: boolean } | { ok: false; reason: string } {
  const path = redSkillsSnapshotDir(opts.home, opts.commit);
  if (existsSync(path)) return { ok: true, path, created: false };

  const staging = redSkillsSnapshotDir(opts.home, `.staging-${opts.commit}`);
  const tar = `${staging}.tar`;
  rmSync(staging, { recursive: true, force: true });
  rmSync(tar, { force: true });
  mkdirSync(staging, { recursive: true });

  const archived = run(snapshotArchiveArgv(opts.mirror, opts.commit, tar));
  if (archived.code !== 0) {
    rmSync(staging, { recursive: true, force: true });
    rmSync(tar, { force: true });
    return {
      ok: false,
      reason: `git archive ${opts.commit.slice(0, 12)} exited ${archived.code}: ${firstLine(archived.stderr)}`,
    };
  }
  // Which entries tar must be told to skip, and what to write in their
  // place. Empty everywhere a symlink is an ordinary thing to create.
  const asFile = (opts.symlinks ?? (process.platform === "win32" ? "as-file" : "native")) === "as-file";
  let links: { path: string; blob: string }[] = [];
  if (asFile) {
    const listed = run(lsTreeArgv(opts.mirror, opts.commit));
    if (listed.code !== 0) {
      rmSync(staging, { recursive: true, force: true });
      rmSync(tar, { force: true });
      return {
        ok: false,
        reason: `git ls-tree ${opts.commit.slice(0, 12)} exited ${listed.code}: ${firstLine(listed.stderr)}`,
      };
    }
    links = parseSymlinkEntries(listed.stdout);
  }

  const extracted = run(extractArgv(tar, staging, links.map((l) => l.path)));
  rmSync(tar, { force: true });
  if (extracted.code !== 0) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, reason: `tar -xf exited ${extracted.code}: ${firstLine(extracted.stderr)}` };
  }

  for (const link of links) {
    const target = run(catBlobArgv(opts.mirror, link.blob));
    if (target.code !== 0) {
      rmSync(staging, { recursive: true, force: true });
      return {
        ok: false,
        reason: `git cat-file ${link.blob.slice(0, 12)} exited ${target.code}: ${firstLine(target.stderr)}`,
      };
    }
    const dest = join(staging, link.path);
    mkdirSync(dirname(dest), { recursive: true });
    // No trailing newline: the file *is* the target path, the way git
    // writes it, not a line of text about it.
    writeFileSync(dest, target.stdout);
  }

  if (existsSync(path)) {
    // Somebody else finished first. Theirs is the same commit by
    // construction, so the staged copy is the one that goes.
    rmSync(staging, { recursive: true, force: true });
    return { ok: true, path, created: false };
  }
  renameSync(staging, path);
  return { ok: true, path, created: true };
}

// --------------------------------------------------------------- the assets

/** Every way an acquisition can end badly, the package set's own plus ours. */
export type AcquireFailure = SetFailure | "cross-commit" | "network";

/**
 * What asking for one revision's release assets produced.
 *
 * Three outcomes rather than two, because "there is no package set for
 * this release yet" and "there is one and it is wrong" are different
 * facts about the machine and deserve different words: the first keeps
 * the composed set quietly, the second is refused out loud.
 */
export type AssetOutcome =
  | { kind: "ready"; dir: string; manifest: PackageSetManifest }
  | { kind: "unavailable"; reason: string }
  | { kind: "refused"; failure: AcquireFailure; reason: string };

export interface AssetRequest {
  commit: string;
  version: string | null;
  /** The tag the release is published under, or null for an untagged commit. */
  tag: string | null;
  /** Where the manifest, its bundle and `artifacts/` are to be written. */
  dest: string;
}

export type AssetProvider = (req: AssetRequest) => Promise<AssetOutcome>;

/** The GitHub API URL for one release, by tag. PURE. */
export function releaseByTagUrl(repo: string, tag: string): string {
  return `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

/**
 * The published assets of one release, verified as they land.
 *
 * The manifest is fetched first and parsed before a single artifact is
 * downloaded, so a release whose commit does not match the resolved one
 * costs one request rather than 25 MB. Each artifact is then hashed in
 * memory and compared against the manifest before it is written, for
 * the reason downloadVerified does the same: an artifact verified after
 * writing is an artifact some later line can install.
 */
export function githubAssetProvider(
  opts: { fetcher?: typeof fetch; repo?: string; env?: NodeJS.ProcessEnv } = {},
): AssetProvider {
  const fetcher = opts.fetcher ?? fetch;
  const repo = opts.repo ?? REDSKILLS_REPO;
  const env = opts.env ?? process.env;

  return async (req) => {
    if (!req.tag) {
      return {
        kind: "unavailable",
        reason: `commit ${req.commit.slice(0, 12)} carries no release tag, so it publishes no assets`,
      };
    }

    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    const token = env["GITHUB_TOKEN"];
    if (token) headers["Authorization"] = `Bearer ${token}`;

    let release: { assets?: ReleaseAsset[] };
    try {
      const res = await fetcher(releaseByTagUrl(repo, req.tag), { headers });
      if (res.status === 404) {
        return { kind: "unavailable", reason: `${repo} publishes no release tagged ${req.tag}` };
      }
      if (!res.ok) {
        return { kind: "refused", failure: "network", reason: `GitHub API ${res.status} for ${req.tag}` };
      }
      release = (await res.json()) as { assets?: ReleaseAsset[] };
    } catch (err) {
      return { kind: "refused", failure: "network", reason: `GitHub API failed: ${(err as Error).message}` };
    }

    const assets = release.assets ?? [];
    const byName = new Map(assets.map((a) => [a.name, a.browser_download_url]));
    const manifestUrl = byName.get(SET_MANIFEST_NAME);
    if (!manifestUrl) {
      return {
        kind: "unavailable",
        reason: `release ${req.tag} publishes no ${SET_MANIFEST_NAME} (reddb-io/red-skills#3977)`,
      };
    }
    const bundleUrl = byName.get(SET_BUNDLE_NAME);
    if (!bundleUrl) {
      return {
        kind: "refused",
        failure: "signature",
        reason: `release ${req.tag} publishes ${SET_MANIFEST_NAME} with no ${SET_BUNDLE_NAME} beside it`,
      };
    }

    const manifestBytes = await fetchBytes(fetcher, manifestUrl);
    if (!manifestBytes.ok) return { kind: "refused", failure: "network", reason: manifestBytes.reason };
    const parsed = parsePackageSetManifest(manifestBytes.bytes);
    if (!parsed.ok) return { kind: "refused", failure: "manifest", reason: parsed.reason };
    const { manifest } = parsed;

    if (manifest.sourceCommit !== req.commit) {
      return {
        kind: "refused",
        failure: "cross-commit",
        reason:
          `release ${req.tag} declares commit ${manifest.sourceCommit.slice(0, 12)} but ` +
          `${selectorCommitLabel(req)} resolved to ${req.commit.slice(0, 12)}`,
      };
    }

    const artifacts = setArtifactsDir(req.dest);
    mkdirSync(artifacts, { recursive: true });
    for (const artifact of manifest.artifacts) {
      const url = byName.get(artifact.name);
      if (!url) {
        return {
          kind: "refused",
          failure: "artifact",
          reason: `release ${req.tag} declares ${artifact.name} and does not publish it`,
        };
      }
      const got = await fetchBytes(fetcher, url);
      if (!got.ok) return { kind: "refused", failure: "network", reason: got.reason };
      if (got.bytes.byteLength !== artifact.size) {
        return { kind: "refused", failure: "artifact", reason: `artifact size mismatch: ${artifact.name}` };
      }
      if (sha256Hex(got.bytes) !== artifact.sha256) {
        return { kind: "refused", failure: "artifact", reason: `artifact checksum mismatch: ${artifact.name}` };
      }
      writeFileSync(join(artifacts, artifact.name), got.bytes);
    }

    const bundle = await fetchBytes(fetcher, bundleUrl);
    if (!bundle.ok) return { kind: "refused", failure: "network", reason: bundle.reason };
    writeFileSync(join(req.dest, SET_MANIFEST_NAME), manifestBytes.bytes);
    writeFileSync(join(req.dest, SET_BUNDLE_NAME), bundle.bytes);
    return { kind: "ready", dir: req.dest, manifest };
  };
}

/**
 * A depot, a fixture, or anything else that already has the assets.
 *
 * The same three outcomes as the online provider, decided by what the
 * directory carries, so an offline import (#211) and an online update
 * take the identical path from here on.
 */
export function directoryAssetProvider(dir: string): AssetProvider {
  return async (req) => {
    const manifestPath = join(dir, SET_MANIFEST_NAME);
    if (!existsSync(manifestPath)) {
      return { kind: "unavailable", reason: `${dir} carries no ${SET_MANIFEST_NAME}` };
    }
    const parsed = parsePackageSetManifest(readFileSync(manifestPath));
    if (!parsed.ok) return { kind: "refused", failure: "manifest", reason: parsed.reason };
    if (parsed.manifest.sourceCommit !== req.commit) {
      return {
        kind: "refused",
        failure: "cross-commit",
        reason:
          `${dir} declares commit ${parsed.manifest.sourceCommit.slice(0, 12)} but ` +
          `${selectorCommitLabel(req)} resolved to ${req.commit.slice(0, 12)}`,
      };
    }
    if (!existsSync(join(dir, SET_BUNDLE_NAME))) {
      return {
        kind: "refused",
        failure: "signature",
        reason: `${dir} carries ${SET_MANIFEST_NAME} with no ${SET_BUNDLE_NAME} beside it`,
      };
    }
    if (dir !== req.dest) {
      rmSync(req.dest, { recursive: true, force: true });
      mkdirSync(dirname(req.dest), { recursive: true });
      cpSync(dir, req.dest, { recursive: true, dereference: true });
    }
    return { kind: "ready", dir: req.dest, manifest: parsed.manifest };
  };
}

async function fetchBytes(
  fetcher: typeof fetch,
  url: string,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }> {
  try {
    const res = await fetcher(url);
    if (!res.ok) return { ok: false, reason: `download failed ${res.status}: ${url}` };
    return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()) };
  } catch (err) {
    return { ok: false, reason: `download failed: ${url} (${(err as Error).message})` };
  }
}

function selectorCommitLabel(req: AssetRequest): string {
  return req.version ? `${req.version}` : "the selector";
}

// -------------------------------------------------------------- the staging

/**
 * Which declared artifacts belong inside the tree rather than beside it.
 *
 * The bundles and the assets they lazily load, and nothing else: that
 * is the shape composeSet already produces from the npm packages — every
 * plugin's `dist/` file beside the core's, where the `bin/*.mjs` shims
 * resolve them through their real path. The rest of the release (the
 * VS Code extension, the verifier, checksums) stays in `artifacts/`,
 * which is what the companion surfaces read (#205).
 */
export function overlaysIntoTree(name: string): boolean {
  return name.endsWith(".bundle.min.mjs") || name.endsWith(".asset.cjs");
}

export interface StageRequest {
  /** The extracted commit — source, with no built bundles in it. */
  snapshot: string;
  /** The verified assets directory: manifest, bundle, `artifacts/`. */
  assets: string;
  /** Where the candidate manifest set is assembled. */
  dest: string;
  /** The plugins the activation config enables. */
  plugins: readonly string[];
}

/**
 * Assemble a candidate manifest set out of one commit and its assets.
 *
 * The result is exactly the shape red-skills-set.ts verifies — manifest,
 * signature bundle, `artifacts/`, `tree/` — because the point is that
 * acquisition invents no verification of its own. What it adds is the
 * overlay: the snapshot is source, the bundles are built, and both come
 * from the same commit or the acquisition has already refused.
 */
export function stageCandidate(
  req: StageRequest,
): { ok: true; dir: string } | { ok: false; reason: string } {
  const manifestPath = join(req.assets, SET_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: `staged assets carry no ${SET_MANIFEST_NAME}` };
  }
  const parsed = parsePackageSetManifest(readFileSync(manifestPath));
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const tree = join(req.dest, "tree");
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(req.dest, { recursive: true });
  cpSync(req.snapshot, tree, { recursive: true, dereference: true });

  const dist = join(tree, "dist");
  mkdirSync(dist, { recursive: true });
  for (const artifact of parsed.manifest.artifacts) {
    if (!overlaysIntoTree(artifact.name)) continue;
    const from = join(setArtifactsDir(req.assets), artifact.name);
    if (!existsSync(from)) {
      return { ok: false, reason: `declared artifact is missing: ${artifact.name}` };
    }
    cpSync(from, join(dist, artifact.name), { dereference: true });
  }

  // The opt-in gate the OpenCode generator reads, written once beside
  // the tree exactly as the composed set writes it. Never overwritten:
  // a set that ships its own is the publisher's to decide.
  const config = join(tree, ".red", "config.yaml");
  if (!existsSync(config)) {
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, hostActivationConfig(req.plugins), "utf8");
  }
  return { ok: true, dir: req.dest };
}

// ---------------------------------------------------------- the acquisition

export interface AcquireOptions {
  home?: string;
  /** `stable`, `next`, a version, or a commit. Defaults to the channel env, then `stable`. */
  selector?: string;
  run?: CommandRunner;
  /** Defaults to the GitHub release assets of the resolved tag. */
  assets?: AssetProvider;
  verifier?: SignatureVerifier;
  url?: string;
  /** The plugins the staged activation config enables. Defaults to the manifest's. */
  plugins?: readonly string[];
  platform?: NodeJS.Platform;
  manifestPlatform?: Platform;
  env?: NodeJS.ProcessEnv;
  /** Verify and stage, but leave `current` where it is (ADR 0010's Workers rule). */
  stageOnly?: boolean;
}

export interface Acquisition {
  /**
   * `acquired` moved the machine; `current` found it already there;
   * `unavailable` found nothing published to acquire; `unreachable`
   * could not ask; `refused` found something and would not have it.
   *
   * The last two are separate because only one of them is a statement
   * about the package set. A laptop on a train cannot read the remote,
   * and recording that as a refused candidate would leave doctor saying
   * this machine rejected a set it never saw.
   */
  outcome: "acquired" | "current" | "unavailable" | "unreachable" | "refused";
  /** One sentence saying why, always — including on the happy path. */
  reason: string;
  failure: AcquireFailure | null;
  selector: Selector | null;
  commit: string | null;
  version: string | null;
  mirror: { path: string; cloned: boolean } | null;
  snapshot: { path: string; created: boolean } | null;
  candidate: string | null;
  /** What `~/.red/skills/current` names once this returns. */
  active: PackageSetIdentity | null;
  /**
   * The revision verified and staged rather than activated, or null.
   *
   * Non-null exactly when a Worker held the activation. `active` still
   * names what the machine resolves, so a caller writing down "which
   * revision is this" — mise's install receipt, most of all — can say
   * the one that was actually acquired instead of the one it replaced.
   */
  staged: PackageSetIdentity | null;
  writes: string[];
}

/**
 * Acquire one revision of the package set, or leave the machine alone.
 *
 * Everything expensive happens after something cheap has justified it,
 * and nothing at all happens after the machine has been found already
 * on the resolved commit. That ordering is the acceptance criterion
 * about a no-op install: it is not that the writes are skipped, it is
 * that the work which would produce them is never started.
 */
export async function acquireRedSkills(opts: AcquireOptions = {}): Promise<Acquisition> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homeOf(env);
  const run = opts.run ?? systemRunner;
  const url = opts.url ?? REDSKILLS_GIT_URL;
  const raw = opts.selector ?? env[CHANNEL_ENV] ?? DEFAULT_CHANNEL;
  // Whether a revision was *asked* for, as against defaulted to. The
  // difference decides what happens on a machine resolving a
  // development checkout: `red-dev red-skills install 3.19.5` is a
  // person leaving the override, and an unpinned `red-dev update` is
  // not — see the checkout short-cut below.
  const pinned = opts.selector !== undefined || env[CHANNEL_ENV] !== undefined;

  /**
   * Every ending that is not an activation, in one shape.
   *
   * A refusal also writes one line — the failure and the reason — into
   * the package-set state, because "why did this machine not move" is a
   * question asked hours later by `red-dev doctor` rather than at the
   * moment the log line scrolled past. Nothing else writes: `current`,
   * `unavailable` and `unreachable` are not faults of the set, and a
   * state file that changed on every quiet run would be a file nothing
   * could compare.
   */
  const nothing = (
    outcome: Acquisition["outcome"],
    reason: string,
    failure: AcquireFailure | null = null,
    extra: Partial<Acquisition> = {},
  ): Acquisition => ({
    outcome,
    reason,
    failure,
    selector: null,
    commit: null,
    version: null,
    mirror: null,
    snapshot: null,
    candidate: null,
    active: activeIdentityOf(home),
    staged: null,
    writes:
      outcome === "refused" && failure !== null
        ? recordPackageSetRefusal(home, { failure, reason })
        : [],
    ...extra,
  });

  const selector = parseSelector(raw);
  if (!selector) {
    return nothing(
      "refused",
      `'${raw}' is not a channel (${CHANNELS.join(", ")}), a version, or a 40-character commit`,
      "manifest",
    );
  }

  // Before the network, because a machine on a development checkout has
  // nothing to ask the remote. `red-dev update` runs this on every run
  // with no selector, and an update that replaced somebody's working
  // tree with `stable` would be an update that undid the override it was
  // never told about. Naming a revision explicitly still leaves it.
  if (!pinned) {
    const override = activeCheckoutRevision(home);
    if (override) {
      return nothing(
        "current",
        `this machine resolves the development checkout ${override.key} — ` +
          "`red-dev red-skills sync <path>` advances it",
        null,
        { selector, active: activeIdentityOf(home) },
      );
    }
  }

  const listed = listRemoteRevisions(run, url);
  if (!listed.ok) return nothing("unreachable", listed.reason, "network", { selector });

  const resolved = resolveRevision(selector, listed.revisions);
  if (!resolved.ok) return nothing("refused", resolved.reason, "manifest", { selector });
  const { commit, version, tag } = resolved;

  // The short-cut. A machine already on this commit is a machine with
  // nothing to acquire — no clone, no snapshot, no download, and above
  // all nothing for a host to be reconciled against.
  const active = activeIdentityOf(home);
  if (active && active.sourceCommit === commit) {
    // Before returning: a set activated before activation carried its
    // artifacts has no VS Code extension to install from, and this
    // branch is the only place a machine on that revision ever passes
    // through. See healSetArtifacts.
    const healed = healSetArtifacts(home, commit);
    if (healed !== null) log.ok(`red-skills: ${healed} restored to the active set`);

    return nothing("current", `already on ${commit.slice(0, 12)} (${selectorLabel(selector)})`, null, {
      selector,
      commit,
      version,
      active,
    });
  }

  const candidate = redSkillsCandidateDir(home, commit);
  const assets = opts.assets ?? githubAssetProvider({ env });
  const fetched = await assets({ commit, version, tag, dest: candidate });
  if (fetched.kind === "unavailable") {
    rmSync(candidate, { recursive: true, force: true });
    return nothing("unavailable", fetched.reason, null, { selector, commit, version, active });
  }
  if (fetched.kind === "refused") {
    rmSync(candidate, { recursive: true, force: true });
    return nothing(
      fetched.failure === "network" ? "unreachable" : "refused",
      fetched.reason,
      fetched.failure,
      { selector, commit, version, active },
    );
  }

  const mirror = redSkillsMirrorDir(home);
  const mirrored = ensureMirror(run, { url, dir: mirror });
  if (!mirrored.ok) {
    return nothing("unreachable", mirrored.reason, "network", { selector, commit, version, active });
  }

  const snapshot = ensureSnapshot(run, { mirror, home, commit });
  if (!snapshot.ok) {
    return nothing("refused", snapshot.reason, "tree", {
      selector,
      commit,
      version,
      active,
      mirror: { path: mirror, cloned: mirrored.cloned },
    });
  }

  const plugins = opts.plugins ?? redSkillsPluginNames(opts.manifestPlatform ?? manifestPlatformOf(opts.platform));
  const staged = stageCandidate({ snapshot: snapshot.path, assets: candidate, dest: candidate, plugins });
  if (!staged.ok) {
    return nothing("refused", staged.reason, "tree", {
      selector,
      commit,
      version,
      active,
      mirror: { path: mirror, cloned: mirrored.cloned },
      snapshot: { path: snapshot.path, created: snapshot.created },
    });
  }

  // Verified here, before the converge is asked to do anything, so a
  // refusal is a refusal *before* postinstall rather than a rollback
  // after one. The converge verifies again on its own; that repetition
  // is the point — neither caller trusts the other's check.
  const verifier = opts.verifier ?? cosignVerifier({ home });
  const verification = verifyPackageSet(candidate, { verifier });
  if (!verification.ok) {
    return nothing("refused", verification.reason, verification.failure, {
      selector,
      commit,
      version,
      active,
      mirror: { path: mirror, cloned: mirrored.cloned },
      snapshot: { path: snapshot.path, created: snapshot.created },
      candidate,
    });
  }

  const converged = convergeRedSkillsPackageSet({
    home,
    source: candidate,
    verifier,
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.stageOnly === true ? { stageOnly: true } : {}),
  });
  if (converged.refused) {
    return nothing("refused", converged.refused.reason, converged.refused.failure, {
      selector,
      commit,
      version,
      active: converged.active,
      mirror: { path: mirror, cloned: mirrored.cloned },
      snapshot: { path: snapshot.path, created: snapshot.created },
      candidate,
      writes: converged.writes,
    });
  }

  retainAcquired(home, converged.retained.map((r) => r.sourceCommit).filter((c) => c !== ""));

  return {
    outcome: converged.changed ? "acquired" : "current",
    reason: converged.changed
      ? `${verification.identity.version} at ${commit.slice(0, 12)} (${selectorLabel(selector)})`
      : `already on ${commit.slice(0, 12)} (${selectorLabel(selector)})`,
    failure: null,
    selector,
    commit,
    version: verification.identity.version,
    mirror: { path: mirror, cloned: mirrored.cloned },
    snapshot: { path: snapshot.path, created: snapshot.created },
    candidate,
    active: converged.active,
    staged: converged.staged,
    writes: converged.writes,
  };
}

/**
 * Collect the snapshots and candidates no retained revision names.
 *
 * The same retention the revisions themselves have — the active one and
 * the rollback — applied to what they were acquired from, because a
 * mirror that never grows and a snapshots directory that grows forever
 * is the same unbounded machine with an extra step. Nothing is removed
 * for a machine that has recorded no commit at all, which is what an
 * offline import looks like halfway through.
 */
export function retainAcquired(home: string, keep: readonly string[]): string[] {
  if (keep.length === 0) return [];
  const removed: string[] = [];
  for (const parent of [join(redSkillsRoot(home), "snapshots"), join(redSkillsRoot(home), "candidates")]) {
    if (!existsSync(parent)) continue;
    for (const name of listing(parent)) {
      if (keep.includes(name) || name.startsWith(".staging-")) continue;
      rmSync(join(parent, name), { recursive: true, force: true });
      removed.push(join(parent, name));
    }
  }
  return removed;
}

// ----------------------------------------------------------- reconciliation

/** Where the last reconciled identity is recorded. */
export function reconciledStampPath(home: string): string {
  return join(redSkillsRoot(home), "reconciled.json");
}

export interface Reconciliation {
  /** Whether the host reconciliation was actually invoked. */
  reconciled: boolean;
  reason: string;
  /** The identity the stamp names once this returns. */
  identity: PackageSetIdentity | null;
  writes: string[];
}

export interface ReconcileOptions {
  home?: string;
  /**
   * The host wiring. Defaults to red-dev's own converge over every
   * installed host.
   *
   * Returning `false` means "this did not fully converge, do not stamp
   * it". Without that, one blocked host would leave a stamp saying the
   * machine was reconciled against these bytes, and the retry that is
   * supposed to fix it would be skipped as already done — the surface
   * would stay broken until the *next* revision moved.
   */
  reconcile?: () => Promise<boolean | void> | boolean | void;
  /** Reconcile even when the stamp already names the active revision. */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  manifestPlatform?: Platform;
}

/**
 * Reconcile the hosts, once, for a revision that actually moved.
 *
 * This is what the tool-level postinstall runs, and what `red-dev
 * update` runs after its own acquisition — the same function, so the
 * two entry points cannot reconcile differently. The gate is a stamp
 * naming the identity the hosts were last converged against: mise
 * invokes a postinstall on every install it performs, including the
 * ones that reinstalled the same revision, and a reconciliation that
 * ran anyway would rewrite host state nothing asked to change.
 *
 * The stamp is the identity and nothing else — no timestamp, no run
 * count. What it has to answer is "were the hosts wired against these
 * bytes", and a field that changes on every run would make an unchanged
 * file impossible to assert.
 */
export async function reconcileRedSkills(opts: ReconcileOptions = {}): Promise<Reconciliation> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homeOf(env);
  const active = activeIdentityOf(home);
  if (!active) {
    return { reconciled: false, reason: "no package set is active on this machine", identity: null, writes: [] };
  }

  const key = revisionKey(active);
  const stamp = reconciledStampPath(home);
  const recorded = readStamp(stamp);
  if (!opts.force && recorded === key) {
    return { reconciled: false, reason: `hosts already reconciled against ${key}`, identity: active, writes: [] };
  }

  const reconcile =
    opts.reconcile ??
    (async () => {
      const { convergeRedSkills } = await import("./agents.ts");
      const { detect } = await import("./platform.ts");
      const { reconciliationFailed } = await import("./red-skills-hosts.ts");
      const { companionReconciliationFailed } = await import("./red-skills-companions.ts");
      const converged = await convergeRedSkills(opts.manifestPlatform ?? detect());
      return (
        !reconciliationFailed(converged.hosts) &&
        !companionReconciliationFailed(converged.companions)
      );
    });
  const converged = await reconcile();
  if (converged === false) {
    return {
      reconciled: true,
      reason: `hosts reconciled against ${key} with surfaces still to converge`,
      identity: active,
      writes: [],
    };
  }

  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(stamp, `${JSON.stringify({ schema: 1, key }, null, 2)}\n`, "utf8");
  return { reconciled: true, reason: `hosts reconciled against ${key}`, identity: active, writes: [stamp] };
}

/*
 * There used to be an `updateRedSkillsPackageSet` here — acquire, then
 * reconcile, as the whole operation both entry points ran. It is gone,
 * and deliberately: the whole operation is now four surfaces rather
 * than two, and src/staged-update.ts is the one place that walks them.
 * Keeping a second composition of the same two halves beside it would
 * be exactly the drift the acquisition was consolidated to end — the
 * two would agree until one of them learned about Workers.
 */

/** One line for each outcome, in the voice the rest of a converge speaks. */
export function announce(a: Acquisition): void {
  switch (a.outcome) {
    case "acquired":
      log.ok(`red-skills package set: ${a.reason}`);
      return;
    case "current":
      log.skip(`red-skills package set: ${a.reason}`);
      return;
    case "unavailable":
      log.skip(`red-skills package set: ${a.reason}`);
      return;
    case "unreachable":
      // A warning, not a failure: an update that could not ask is an
      // update that changed nothing, and the machine still resolves the
      // set it did before.
      log.warn(`red-skills package set: ${a.reason}`);
      return;
    case "refused":
      log.err(`red-skills package set refused (${a.failure ?? "unknown"}): ${a.reason}`);
      log.plain("       current is unchanged — the machine keeps the set it already resolves");
      return;
  }
}

// ------------------------------------------------------------------ details

/**
 * The active revision when it is a development checkout, or null.
 *
 * Read from the state file rather than tracked here, because the
 * override is a fact about what this machine resolves and the state
 * file is where that fact already lives.
 */
function activeCheckoutRevision(home: string): { key: string } | null {
  const state = readPackageSetState(home);
  const active = state.revisions.find((r) => r.key === state.active);
  return active && active.kind === "checkout" ? { key: active.key } : null;
}

function activeIdentityOf(home: string): PackageSetIdentity | null {
  const state = readPackageSetState(home);
  const active = state.revisions.find((r) => r.key === state.active);
  if (!active) return null;
  return { version: active.version, digest: active.digest, sourceCommit: active.sourceCommit };
}

function readStamp(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { key?: unknown };
    return typeof parsed.key === "string" ? parsed.key : null;
  } catch {
    // An unreadable stamp is a machine that has to reconcile again,
    // which is the safe half of the two answers it could give.
    return null;
  }
}

function listing(dir: string): string[] {
  try {
    // Sorted, so a retention pass removes in the same order everywhere.
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}

/** The same spelling red-skills-set.ts uses, so the two agree on one home. */
function homeOf(env: NodeJS.ProcessEnv): string {
  return (env["HOME"] ?? env["USERPROFILE"] ?? homedir()).replace(/\\/g, "/");
}

/**
 * Enough of a Platform to derive the plugin set from the manifest.
 *
 * Only `os` is read by that projection, and the caller may hand in the
 * real detected platform instead — this is the fallback for a plugin
 * script that was handed nothing but an install path.
 */
function manifestPlatformOf(platform?: NodeJS.Platform): Platform {
  const windows = (platform ?? process.platform) === "win32";
  return {
    os: windows ? "windows" : "linux",
    distro: null,
    version: null,
    codename: null,
    env: windows ? "windows" : "desktop",
    arch: process.arch === "arm64" ? "arm64" : "x64",
    caps: { apt: false, gui: false, systemd: false, winget: false, flatpak: false },
  };
}
