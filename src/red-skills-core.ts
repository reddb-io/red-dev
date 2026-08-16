/**
 * The RedSkills core: resolved by mise, linked into the layout everything reads.
 *
 * Until now the core arrived the way every reddb-io tool used to — a
 * curled `install.sh` that fetched a release tarball. That works exactly
 * once. Nothing on the machine afterwards knows the payload is old,
 * because the only thing that could tell it is the same script, and the
 * only way to run the script again is to remember to. It is the frozen
 * -forever shape mise-config.ts was written about, applied to the one
 * package the rest of this product talks to most.
 *
 * So the core becomes a manifest entry like everything else, and mise
 * resolves it through its `npm:` backend at `latest`. Not `github:`:
 * that backend scores release assets to put a single executable on
 * PATH, and the payload here is a tree of bundles and shims rather than
 * one binary. npm is where that tree is already published.
 *
 * ## The half that is not the entry
 *
 * mise installs into its own tree — `installs/<tool>/<version>` — and
 * nothing on this machine looks there. `red-skills-ext`, the host
 * census in host-state.ts and the WSL rescue shim all resolve through
 * `~/.red-skills/current`, and they did so before this file existed.
 * An entry that installs the core somewhere else and does not repoint
 * that link converges a machine into the worst available state: the
 * core is installed, everything reports success, and nothing can find
 * it.
 *
 * That is why the entry and the layout ship together. The layout is:
 *
 *   ~/.red-skills/versions/v<version>   the package set for one version
 *   ~/.red-skills/current               -> the newest of those
 *
 * which is the shape the standalone one-liner already produces, chosen
 * for that reason rather than invented here.
 *
 * ## Links, not copies, and junctions on Windows
 *
 * The per-version directory is a link into mise's install rather than a
 * copy of it. A copy doubles a 20 MB payload per version and, worse,
 * has to be kept in step with the thing it was copied from.
 *
 * On Windows a plain symlink needs SeCreateSymbolicLinkPrivilege, which
 * in practice means developer mode — a machine-wide setting an installer
 * has no business demanding. A junction needs none of it: it is an
 * ordinary directory reparse point any user can create. That is also
 * what keeps the directory-copy emulation out of the picture entirely;
 * `repairCopiedRedSkillsCurrent` exists to clean up after that class of
 * bug, and the way not to need it is to never create a copy.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { log } from "./log.ts";
import { miseInstallRoot } from "./mise-config.ts";

/**
 * The backend-qualified name the manifest declares and mise resolves.
 *
 * Duplicated as a literal in manifest.ts rather than imported from
 * here: manifest.ts is what mise-config.ts projects, and this module
 * reads mise-config.ts, so an import would close a cycle around a
 * top-level `const`. A test pins the two spellings against each other,
 * which is the cheap half of the trade.
 */
export const REDSKILLS_CORE_SPEC = "npm:@reddb-io/red-skills";

/** The short name [tool_alias] exposes, and the one people type. */
export const REDSKILLS_CORE_ALIAS = "red-skills";

/** How npm nests the package inside the install prefix mise hands it. */
const CORE_PACKAGE = "@reddb-io/red-skills";

/**
 * The directory mise keeps one tool's versions under.
 *
 * Two spellings, because mise uses two. A tool named through
 * [tool_alias] installs under the alias verbatim — `red-skills` —
 * while a bare backend spec is flattened into a directory name:
 * `npm:@types/semver` becomes `npm-types-semver`. Both were read off a
 * real mise install rather than derived from its documentation, because
 * the whole layout below hangs on getting this one string right.
 */
export function miseInstallDirName(entry: { spec: string; alias?: string }): string {
  if (entry.alias) return entry.alias;
  const colon = entry.spec.indexOf(":");
  if (colon < 0) return entry.spec;
  const backend = entry.spec.slice(0, colon);
  const name = entry.spec.slice(colon + 1).replace(/^@/, "").replace(/[@/]/g, "-");
  return `${backend}-${name}`;
}

/** Where mise keeps the installed versions of the core. */
export function coreInstallsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    miseInstallRoot(env),
    miseInstallDirName({ spec: REDSKILLS_CORE_SPEC, alias: REDSKILLS_CORE_ALIAS }),
  );
}

/** The package tree inside one installed version. */
export function corePayloadDir(installsDir: string, version: string): string {
  return join(installsDir, version, "node_modules", CORE_PACKAGE);
}

/** `~/.red-skills/versions/v<version>` — the per-version directory. */
export function redSkillsVersionDir(home: string, version: string): string {
  return join(home, ".red-skills", "versions", `v${version}`);
}

/** `~/.red-skills/current` — the only thing that moves. */
export function redSkillsCurrentLink(home: string): string {
  return join(home, ".red-skills", "current");
}

const EXACT_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * The newest version mise has installed, or null when it has installed none.
 *
 * Exact `x.y.z` directories only. mise writes `latest`, `3` and `3.18`
 * beside them as symlinks into whichever exact version each selector
 * resolved to; counting those would make the answer depend on which
 * selectors this machine happened to ask for, and would name a link
 * whose target moves under a per-version directory that must not.
 *
 * Sorted segment by segment rather than lexically, so 3.10.0 comes
 * after 3.9.0 — the ordering bug that only shows up two years in.
 */
export function installedCoreVersion(installsDir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(installsDir);
  } catch {
    return null;
  }

  const versions = names
    .map((name) => EXACT_VERSION.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .filter((m) => statOf(join(installsDir, m[0]))?.isSymbolicLink() === false)
    .map((m) => ({
      name: m[0],
      parts: [Number(m[1]), Number(m[2]), Number(m[3])] as const,
    }))
    .sort((a, b) =>
      a.parts[0] - b.parts[0] || a.parts[1] - b.parts[1] || a.parts[2] - b.parts[2]
    );

  return versions.at(-1)?.name ?? null;
}

/**
 * The link flavour this platform can create without asking for rights.
 *
 * "junction" on Windows and "dir" everywhere else. Node ignores the
 * type argument on POSIX, so the distinction only ever bites on the one
 * platform where it matters — and there the wrong answer is not a
 * cosmetic difference: a "dir" symlink needs
 * SeCreateSymbolicLinkPrivilege, which an unprivileged account only has
 * with developer mode on. A junction needs nothing.
 */
export function directoryLinkType(
  platform: NodeJS.Platform = process.platform,
): "junction" | "dir" {
  return platform === "win32" ? "junction" : "dir";
}

export interface RedSkillsLayout {
  /** The version `current` names once this returns. */
  version: string;
  /** `~/.red-skills/versions/v<version>`. */
  versionDir: string;
  /** `~/.red-skills/current`. */
  current: string;
  /** False when the machine was already in this state. */
  changed: boolean;
}

export interface RedSkillsLayoutOptions {
  /** Defaults to this user's home. Injected by the tests. */
  home?: string;
  /** Defaults to mise's installs directory for the core. */
  installsDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * Point the layout at whatever mise has installed.
 *
 * Answers null when there is nothing to point at — mise has not
 * installed the core, or has installed a version whose payload is not
 * where it should be. Null is "no opinion", never "broken": a machine
 * that has never had the core is the ordinary state of a fresh install
 * before the mise entry has run, and it must not travel as a failure.
 *
 * Non-destructive by construction. A per-version directory that already
 * exists is used as it stands, whichever install mode created it, and
 * only `current` is repointed. That is what lets this and the standalone
 * one-liner converge the same machine without fighting over the tree:
 * they agree on the name of the directory, so whoever gets there first
 * owns its contents and the other one has nothing left to do.
 */
export function convergeRedSkillsCoreLayout(
  opts: RedSkillsLayoutOptions = {},
): RedSkillsLayout | null {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homeOf(env);
  const installsDir = opts.installsDir ?? coreInstallsDir(env);
  const platform = opts.platform ?? process.platform;

  const version = installedCoreVersion(installsDir);
  if (version === null) return null;

  const versionDir = redSkillsVersionDir(home, version);
  const current = redSkillsCurrentLink(home);

  // Asked before anything is written, and answered by resolving both
  // ends rather than by reading the link's text. A converge runs often;
  // recreating a link that already points where it should would churn
  // the mtime of the one path every consumer stats.
  if (resolvesTo(current, versionDir)) {
    return { version, versionDir, current, changed: false };
  }

  if (!existsSync(versionDir)) {
    const payload = corePayloadDir(installsDir, version);
    if (!existsSync(payload)) return null;
    if (!linkDirectory(payload, versionDir, platform)) return null;
  }

  if (!linkDirectory(versionDir, current, platform)) return null;

  log.ok(`red-skills core ${version}: current -> ${versionDir}`);
  return { version, versionDir, current, changed: true };
}

/**
 * The layout step that belongs after a mise install.
 *
 * Keyed on the spec and silent for every other tool, so the provider in
 * providers.ts stays a generic one call site wide instead of growing a
 * table of per-tool afterthoughts.
 */
export function convergeCoreAfterMise(
  spec: string,
  opts: RedSkillsLayoutOptions = {},
): RedSkillsLayout | null {
  if (spec !== REDSKILLS_CORE_SPEC) return null;
  return convergeRedSkillsCoreLayout(opts);
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return (env["HOME"] ?? env["USERPROFILE"] ?? homedir()).replace(/\\/g, "/");
}

function statOf(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Do these two paths name the same directory, once every link is followed? */
function resolvesTo(link: string, target: string): boolean {
  try {
    return realpathSync(link) === realpathSync(target);
  } catch {
    return false;
  }
}

/**
 * Replace `path` with a link to `target`, unless a real directory is there.
 *
 * A real directory in the way is somebody else's tree — a source
 * checkout, or the copy Git Bash leaves behind when it emulates a
 * symlink. Removing it to make room would be this function deleting
 * data it did not create, so it declines and says so instead. The
 * machine keeps what it has and the next converge asks again.
 */
function linkDirectory(target: string, path: string, platform: NodeJS.Platform): boolean {
  const existing = statOf(path);
  if (existing && existing.isDirectory() && !existing.isSymbolicLink()) {
    log.warn(`red-skills: ${path} is a real directory, not a link — leaving it alone`);
    return false;
  }

  mkdirSync(dirname(path), { recursive: true });
  if (existing) removeLink(path);
  symlinkSync(target, path, directoryLinkType(platform));
  return true;
}

/**
 * Unlink, and fall back to rmdir.
 *
 * A junction is a directory reparse point. Unlinking one is supported,
 * but the failure if it ever is not would be an EPERM on the single
 * path this whole module exists to move — cheap enough to catch.
 */
function removeLink(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    rmdirSync(path);
  }
}
