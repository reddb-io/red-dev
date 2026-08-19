/**
 * The workstation lock: every external application, at one exact version.
 *
 * The RedSkills package set (src/red-skills-set.ts) answers what *our*
 * revision is, and answers it well: one tree, one digest, one signed
 * manifest. It says nothing at all about the machine around it. Claude
 * Code arrives from an install script that fetches whatever shipped this
 * morning, Codex from npm at `latest`, zellij from a release tag, VS Code
 * from Microsoft's apt repository, node from mise — six acquisition paths,
 * none of which records what it took. Two workstations provisioned an hour
 * apart are therefore two different workstations, and the only way to find
 * out which one a bug belongs to is to go and look at both.
 *
 * ADR 0010 keeps third-party applications as independent tools rather than
 * folding them into the package set, so their publishers keep their own
 * release cycles. What it does not give them is a moment where the whole
 * set is decided together. That moment is this file: a **lock** — one
 * target, and for every external application on it an exact version, the
 * surface it belongs to, the official source that exact version comes
 * from, the artifact checksum, and the provenance record that says who
 * vouches for it. Spec #201's offline depot then carries a lock and its
 * artifacts to a machine with no network, and the machine installs the
 * combination somebody already ran.
 *
 * ## A target is one or more surfaces
 *
 * Ubuntu is one surface: the CLIs, the GUI applications and the runtimes
 * all live in the same place. A Windows workstation is two — decision 38
 * of the spec puts the coder CLIs, zellij and herdr in WSL and leaves the
 * GUI applications native — and both halves are provisioned from one
 * medium, so they are one target with two surfaces rather than two
 * targets. That is why every locked application names its surface: a lock
 * that said "codex 0.55.0" without saying *where* would be satisfied by
 * installing it on the wrong side of the fence.
 *
 * ## What "exact" refuses
 *
 * A lock exists to be reproducible, so every input that resolves
 * differently tomorrow is refused rather than recorded:
 *
 *   - a mutable selector — `latest`, `stable`, `next`, `^1.2`, a branch —
 *     as the version, because the point of the lock is that nothing
 *     resolves at install time;
 *   - a source URL that resolves through a moving pointer, of which
 *     `/releases/latest/download/` is the one this project has already
 *     been bitten by (see manifest.ts's `gh` provider);
 *   - a version that the source coordinate does not name, because a
 *     coordinate and a version that disagree install one thing and record
 *     another;
 *   - an application on a surface its target does not have, which is what
 *     a cross-target install looks like from inside: an Ubuntu lock whose
 *     entries name a Windows surface, or a Windows lock handed to an
 *     Ubuntu machine.
 *
 * ## Cloud authentication is not installation
 *
 * Every coder CLI here needs an account somewhere, and none of them can
 * get one from a depot on a USB stick. Decision 19 of the spec settles
 * what that means: readiness is installed, synchronized and verified, and
 * an unconfigured cloud identity is *reported* rather than counted as a
 * failed installation. So the plan carries an `unconfigured` list that
 * never touches its verdict — an air-gapped bootstrap that ends with
 * seven CLIs installed and seven accounts unconfigured has succeeded, and
 * says so while naming exactly what the operator still has to do.
 *
 * ## The fixtures are fixtures
 *
 * `src/fixtures/workstation-lock/*.json` are locks with `origin:
 * "fixture"`: their versions and checksums were written down here, not
 * fetched from a publisher. They are enough to plan from — which is what
 * the tests do — and installing from one is refused, because a checksum
 * nobody computed from bytes is not provenance.
 */

import { readFileSync } from "node:fs";

import { sha256Hex } from "./checksum.ts";
import { redSkillsRootPosix } from "./red-skills-root.ts";

export const WORKSTATION_LOCK_SCHEMA = "red.workstation-lock.v1";

// ------------------------------------------------------------- the vocabulary

/**
 * Where an application runs on a target.
 *
 * `both` is Ubuntu, where the distinction does not exist. It is a
 * property of the surface rather than of the application because the same
 * application makes the opposite choice on the other target: zellij is a
 * CLI on both, and on Windows that means WSL.
 */
export type SurfaceRole = "cli" | "gui" | "both";

/** One place a target installs into. */
export interface LockSurface {
  id: string;
  os: "linux" | "windows";
  distro: string;
  version: string;
  arch: "x64" | "arm64";
  env: "desktop" | "wsl" | "windows";
  role: SurfaceRole;
}

/** One workstation a lock can provision. */
export interface LockTarget {
  id: string;
  label: string;
  /** Sorted by id, unique. */
  surfaces: LockSurface[];
}

export type AppKind = "coder" | "companion" | "editor" | "runtime" | "tooling";

/**
 * How the exact version is fetched.
 *
 * `coordinate` is the exact thing a package manager is asked for —
 * `@openai/codex@0.55.0`, `code=1.104.2`, `reddb-io/zellij@v0.44.3-red.2`
 * — and it has to contain the version, so that the field a person reads
 * and the string a machine passes to apt cannot drift apart. `origin` is
 * the publisher's own URL for it.
 */
export interface LockSource {
  kind: "npm" | "github-release" | "installer" | "winget" | "apt-repo" | "mise";
  coordinate: string;
  origin: string;
  publisher: string;
}

/** The bytes, and what they hash to. */
export interface LockArtifact {
  name: string;
  sha256: string;
}

/**
 * Who vouches for the artifact, and where that can be checked.
 *
 * A closed vocabulary rather than free text, because the interesting
 * question about a depot is "what kind of proof does this rest on", and
 * an answer nothing can group is an answer nobody reads.
 */
export interface LockProvenance {
  attestation:
    | "npm-provenance"
    | "github-attestation"
    | "sigstore-bundle"
    | "publisher-key"
    | "winget-manifest"
    | "release-checksums";
  reference: string;
}

/** The account an application needs, and the file that proves it has one. */
export interface LockCloudAuth {
  service: string;
  evidence: string;
}

/** One external application, locked to one version on one surface. */
export interface LockedApp {
  id: string;
  label: string;
  kind: AppKind;
  surface: string;
  version: string;
  source: LockSource;
  artifact: LockArtifact;
  provenance: LockProvenance;
  /** Null for everything that needs no account: runtimes, editors, tools. */
  cloudAuth: LockCloudAuth | null;
}

/**
 * Whether the versions and checksums in here came from a publisher.
 *
 * `fixture` is test data and depot rehearsal: plannable, never
 * installable. Nothing else may be installed either until it has been
 * `resolved`, which is the only path that puts a real digest in.
 */
export type LockOrigin = "resolved" | "fixture";

export interface WorkstationLock {
  schema: string;
  target: LockTarget;
  origin: LockOrigin;
  /** ISO 8601, from the caller: this module never reads a clock. */
  resolvedAt: string;
  /** Sorted by surface then id, unique on the pair. */
  apps: LockedApp[];
  lockDigest: string;
}

/**
 * Every application a complete workstation has to end up with.
 *
 * The seven managed coder hosts of ADR 0010 — the same seven
 * `HOST_ADAPTERS` walks — plus the companions the spec names, plus the
 * two runtimes the set cannot run without: node, which red-dev and four
 * of the CLIs are written against, and python, which hermes declares as a
 * runtime need in src/agents.ts. A lock missing any of them is incomplete
 * and cannot provision a clean machine, which is a fact about the lock
 * and not about the machine, so it is answered before anything is run.
 */
export const REQUIRED_WORKSTATION_APPS = [
  "claude-code",
  "codex",
  "gemini",
  "herdr",
  "hermes",
  "mise",
  "node",
  "opencode",
  "pi",
  "python",
  "red-dev",
  "redcode",
  "vscode",
  "zellij",
] as const;

// ------------------------------------------------------------- the encoding

const SURFACE_KEYS = ["id", "os", "distro", "version", "arch", "env", "role"] as const;
const TARGET_KEYS = ["id", "label", "surfaces"] as const;
const SOURCE_KEYS = ["kind", "coordinate", "origin", "publisher"] as const;
const ARTIFACT_KEYS = ["name", "sha256"] as const;
const PROVENANCE_KEYS = ["attestation", "reference"] as const;
const CLOUD_AUTH_KEYS = ["service", "evidence"] as const;
const APP_KEYS = [
  "id",
  "label",
  "kind",
  "surface",
  "version",
  "source",
  "artifact",
  "provenance",
  "cloudAuth",
] as const;
const LOCK_KEYS = ["schema", "target", "origin", "resolvedAt", "apps", "lockDigest"] as const;

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const SOURCE_KINDS = new Set<LockSource["kind"]>([
  "npm",
  "github-release",
  "installer",
  "winget",
  "apt-repo",
  "mise",
]);
const ATTESTATIONS = new Set<LockProvenance["attestation"]>([
  "npm-provenance",
  "github-attestation",
  "sigstore-bundle",
  "publisher-key",
  "winget-manifest",
  "release-checksums",
]);
const APP_KINDS = new Set<AppKind>(["coder", "companion", "editor", "runtime", "tooling"]);

/** The key a lock's apps are sorted and made unique on. PURE. */
function appKey(app: Pick<LockedApp, "id" | "surface">): string {
  return `${app.surface} ${app.id}`;
}

/** The bytes the lock digest is taken over. PURE. */
export function workstationLockIdentityBytes(
  lock: Pick<WorkstationLock, "schema" | "target" | "origin" | "resolvedAt" | "apps">,
): string {
  return `${JSON.stringify({
    schema: lock.schema,
    target: lock.target,
    origin: lock.origin,
    resolvedAt: lock.resolvedAt,
    apps: lock.apps,
  })}\n`;
}

/** The digest a lock must declare for its own contents. PURE. */
export function workstationLockDigest(
  lock: Pick<WorkstationLock, "schema" | "target" | "origin" | "resolvedAt" | "apps">,
): string {
  return sha256Hex(workstationLockIdentityBytes(lock));
}

/** The one encoding a lock is allowed to have on disk. PURE. */
export function encodeWorkstationLock(lock: WorkstationLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

// -------------------------------------------------------------- the refusals

/**
 * Selectors that name whatever is newest rather than one release.
 *
 * The shape check below refuses all of these already — none of them looks
 * like a version — so this list exists for the sentence it produces: a
 * lock that was resolved through a channel is a different mistake from a
 * lock with a typo in it, and the operator reading the refusal is the one
 * who has to know which.
 */
const MUTABLE_SELECTORS = new Set([
  "",
  "*",
  "current",
  "dev",
  "edge",
  "head",
  "latest",
  "main",
  "master",
  "next",
  "nightly",
  "stable",
]);

/** Path segments that resolve to a different artifact tomorrow. */
const MUTABLE_PATHS = [
  "/releases/latest",
  "/latest/download",
  "/download/latest/",
  "/nightly/",
  "/edge/",
];

/**
 * One exact version, or not a version at all. PURE.
 *
 * Deliberately refuses a leading `v`: the tag belongs in the source
 * coordinate, where the publisher's spelling is what a fetch has to use,
 * and the version field is the number the installed binary answers with.
 * Keeping the two apart is what lets `0.44.3-red.2` and `v0.44.3-red.2`
 * both be right without either being ambiguous.
 */
export function isExactVersion(value: string): boolean {
  if (/[\^~*\s]|^[<>=]|\.x(\.|$)/.test(value)) return false;
  return /^\d+(\.\d+)*([.\-+][0-9A-Za-z][0-9A-Za-z.\-+]*)?$/.test(value);
}

function isOfficialUrl(value: string): boolean {
  if (!value.startsWith("https://")) return false;
  const lower = value.toLowerCase();
  return !MUTABLE_PATHS.some((path) => lower.includes(path)) && !lower.endsWith("/latest");
}

/**
 * Everything wrong with a lock, in the order it was found. PURE.
 *
 * Separate from the parser because the two callers ask at different
 * moments: parsing checks bytes that arrived from a depot, while an
 * install checks a lock already in memory — which a resolver, a test or a
 * later ticket may have built without going through JSON at all. Both
 * have to refuse the same things, and one implementation is how they stay
 * refusing the same things.
 */
export function auditWorkstationLock(lock: WorkstationLock): string[] {
  const problems: string[] = [];
  if (lock.schema !== WORKSTATION_LOCK_SCHEMA) {
    problems.push(`unsupported lock schema: ${lock.schema}`);
  }
  if (lock.origin !== "resolved" && lock.origin !== "fixture") {
    problems.push(`unknown lock origin: ${String(lock.origin)}`);
  }
  if (!ISO_8601.test(lock.resolvedAt)) {
    problems.push("lock resolution time is not an ISO 8601 instant");
  }

  const surfaces = new Map<string, LockSurface>();
  let priorSurface = "";
  for (const surface of lock.target.surfaces) {
    if (surfaces.has(surface.id)) problems.push(`surface ${surface.id} is declared twice`);
    if (priorSurface && priorSurface.localeCompare(surface.id, "en") >= 0) {
      problems.push("target surfaces must be unique and sorted");
    }
    priorSurface = surface.id;
    surfaces.set(surface.id, surface);
  }
  if (surfaces.size === 0) problems.push("target declares no surface");

  let priorApp = "";
  for (const app of lock.apps) {
    const where = `${app.id} on ${app.surface}`;
    if (priorApp && priorApp.localeCompare(appKey(app), "en") >= 0) {
      problems.push("locked applications must be unique per surface and sorted");
    }
    priorApp = appKey(app);

    const surface = surfaces.get(app.surface);
    if (surface === undefined) {
      // The cross-target case seen from inside one lock: an entry naming a
      // surface this target does not have cannot be installed anywhere.
      problems.push(`${where}: target ${lock.target.id} has no such surface`);
    }
    if (!APP_KINDS.has(app.kind)) problems.push(`${where}: unknown application kind ${app.kind}`);
    if (!isExactVersion(app.version)) {
      problems.push(
        MUTABLE_SELECTORS.has(app.version.toLowerCase())
          ? `${where}: ${app.version} is a moving channel, not a release`
          : `${where}: ${app.version} is not an exact version`,
      );
    }
    if (!SOURCE_KINDS.has(app.source.kind)) {
      problems.push(`${where}: unknown source kind ${app.source.kind}`);
    }
    if (!app.source.coordinate.includes(app.version)) {
      problems.push(`${where}: source ${app.source.coordinate} does not name version ${app.version}`);
    }
    if (!isOfficialUrl(app.source.origin)) {
      problems.push(`${where}: source origin ${app.source.origin} is not an exact official URL`);
    }
    if (app.source.publisher.length === 0) problems.push(`${where}: no publisher recorded`);
    if (app.artifact.name.length === 0) problems.push(`${where}: no artifact recorded`);
    if (!HEX64.test(app.artifact.sha256)) problems.push(`${where}: artifact checksum is invalid`);
    if (!ATTESTATIONS.has(app.provenance.attestation)) {
      problems.push(`${where}: unknown attestation ${app.provenance.attestation}`);
    }
    if (!isOfficialUrl(app.provenance.reference)) {
      problems.push(`${where}: provenance reference ${app.provenance.reference} is not an exact official URL`);
    }
    if (app.cloudAuth !== null && app.cloudAuth.service.length === 0) {
      problems.push(`${where}: cloud authentication names no service`);
    }
  }

  if (workstationLockDigest(lock) !== lock.lockDigest) {
    problems.push("lock digest does not match the locked contents");
  }
  return problems;
}

/** The required applications this lock does not carry, sorted. PURE. */
export function missingFromLock(lock: WorkstationLock): string[] {
  const present = new Set(lock.apps.map((app) => app.id));
  return REQUIRED_WORKSTATION_APPS.filter((id) => !present.has(id));
}

// ---------------------------------------------------------------- the parser

export type LockParse =
  | { ok: true; lock: WorkstationLock }
  | { ok: false; reason: string };

/**
 * `~/.red/skills/workstation-lock.json` — the exact target this machine
 * is provisioned against.
 *
 * One file, beside the package-set state, because the two are the same
 * fact seen from two sides: the set is what RedSkills is on this
 * machine, and the lock is what everything RedSkills does not publish is
 * on it. A machine with no lock is a machine nobody has resolved one for
 * yet, which is the ordinary state before the first depot import.
 */
export function workstationLockPath(home: string): string {
  return `${redSkillsRootPosix(home)}/workstation-lock.json`;
}

/**
 * The lock this machine holds, or why it holds none. PURE of everything
 * but the one read.
 *
 * Absent and unreadable are different answers: the first is a machine
 * that was never given a lock, the second is one whose lock cannot be
 * trusted. Both leave the caller with nothing to install from, and only
 * the second is worth an operator's attention.
 */
export function readWorkstationLock(
  home: string,
  read: (path: string) => Uint8Array | null = readIfPresent,
): { ok: true; lock: WorkstationLock } | { ok: false; present: boolean; reason: string } {
  const path = workstationLockPath(home);
  const bytes = read(path);
  if (bytes === null) {
    return { ok: false, present: false, reason: `no workstation lock at ${path}` };
  }
  const parsed = parseWorkstationLock(bytes);
  return parsed.ok ? parsed : { ok: false, present: true, reason: parsed.reason };
}

function readIfPresent(path: string): Uint8Array | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function sameKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected)
  );
}

function strings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "string" && (value[key] as string).length > 0);
}

/**
 * A lock out of its bytes, or why these bytes are not one. PURE.
 *
 * Shape first and meaning second, in the same order and for the same
 * reason as `parsePackageSetManifest`: this is the one input that arrives
 * from outside the machine, and an `as` here would turn a malformed depot
 * into an installation that verified nothing while reporting that it did.
 * The last check is that the bytes are exactly the canonical encoding, so
 * a lock that reached the machine reformatted is refused rather than
 * silently re-blessed under a digest computed from something else.
 */
export function parseWorkstationLock(bytes: Uint8Array | string): LockParse {
  const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "lock is not valid JSON" };
  }
  if (!sameKeys(raw, LOCK_KEYS)) {
    return { ok: false, reason: "lock shape or key order is not canonical" };
  }
  if (raw["schema"] !== WORKSTATION_LOCK_SCHEMA) {
    return { ok: false, reason: `unsupported lock schema: ${String(raw["schema"])}` };
  }

  const rawTarget = raw["target"];
  if (!sameKeys(rawTarget, TARGET_KEYS) || !strings(rawTarget, ["id", "label"])) {
    return { ok: false, reason: "target shape or key order is not canonical" };
  }
  const rawSurfaces = rawTarget["surfaces"];
  if (!Array.isArray(rawSurfaces) || rawSurfaces.length === 0) {
    return { ok: false, reason: "target must declare at least one surface" };
  }
  const surfaces: LockSurface[] = [];
  for (const entry of rawSurfaces) {
    if (!sameKeys(entry, SURFACE_KEYS) || !strings(entry, SURFACE_KEYS)) {
      return { ok: false, reason: "surface shape or key order is not canonical" };
    }
    surfaces.push(entry as unknown as LockSurface);
  }

  const rawApps = raw["apps"];
  if (!Array.isArray(rawApps) || rawApps.length === 0) {
    return { ok: false, reason: "lock must declare at least one application" };
  }
  const apps: LockedApp[] = [];
  for (const entry of rawApps) {
    if (!sameKeys(entry, APP_KEYS) || !strings(entry, ["id", "label", "kind", "surface", "version"])) {
      return { ok: false, reason: "application shape or key order is not canonical" };
    }
    const source = entry["source"];
    const artifact = entry["artifact"];
    const provenance = entry["provenance"];
    const cloudAuth = entry["cloudAuth"];
    if (!sameKeys(source, SOURCE_KEYS) || !strings(source, SOURCE_KEYS)) {
      return { ok: false, reason: `application ${String(entry["id"])}: source is not canonical` };
    }
    if (!sameKeys(artifact, ARTIFACT_KEYS) || !strings(artifact, ARTIFACT_KEYS)) {
      return { ok: false, reason: `application ${String(entry["id"])}: artifact is not canonical` };
    }
    if (!sameKeys(provenance, PROVENANCE_KEYS) || !strings(provenance, PROVENANCE_KEYS)) {
      return { ok: false, reason: `application ${String(entry["id"])}: provenance is not canonical` };
    }
    if (cloudAuth !== null && (!sameKeys(cloudAuth, CLOUD_AUTH_KEYS) || !strings(cloudAuth, CLOUD_AUTH_KEYS))) {
      return {
        ok: false,
        reason: `application ${String(entry["id"])}: cloud authentication is not canonical`,
      };
    }
    apps.push(entry as unknown as LockedApp);
  }

  const lock: WorkstationLock = {
    schema: WORKSTATION_LOCK_SCHEMA,
    target: { id: rawTarget["id"] as string, label: rawTarget["label"] as string, surfaces },
    origin: raw["origin"] as LockOrigin,
    resolvedAt: raw["resolvedAt"] as string,
    apps,
    lockDigest: raw["lockDigest"] as string,
  };
  const problems = auditWorkstationLock(lock);
  if (problems.length > 0) return { ok: false, reason: problems[0] as string };
  if (encodeWorkstationLock(lock) !== text) {
    return { ok: false, reason: "lock bytes are not canonical" };
  }
  return { ok: true, lock };
}

// --------------------------------------------------------------- the targets

const UBUNTU_24_X64: LockSurface = {
  id: "ubuntu-24.04-x64",
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  arch: "x64",
  env: "desktop",
  role: "both",
};

const WINDOWS_11_X64: LockSurface = {
  id: "windows-11-x64",
  os: "windows",
  distro: "windows",
  version: "11",
  arch: "x64",
  env: "windows",
  role: "gui",
};

const WSL_UBUNTU_24_X64: LockSurface = {
  id: "wsl-ubuntu-24.04-x64",
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  arch: "x64",
  env: "wsl",
  role: "cli",
};

/**
 * The targets a lock can be resolved for.
 *
 * Two, which is the pair Spec #201 names as initial support: the bare
 * Ubuntu 24.04 desktop, and the Windows workstation whose CLI half is a
 * WSL distro. Ubuntu 26.04 is the same shape as the first with a
 * different codename and arrives with its own journey in #213; adding it
 * is a surface and a fixture, not a change here.
 */
export const WORKSTATION_TARGETS: readonly LockTarget[] = [
  {
    id: "ubuntu-24.04-x64",
    label: "Ubuntu 24.04 desktop, x64",
    surfaces: [UBUNTU_24_X64],
  },
  {
    id: "windows-11-x64+wsl-ubuntu-24.04",
    label: "Windows 11 x64 with WSL2 Ubuntu 24.04",
    // Sorted, because the encoding is canonical: the Windows half comes
    // first by name, not by importance.
    surfaces: [WINDOWS_11_X64, WSL_UBUNTU_24_X64],
  },
];

export function workstationTarget(id: string): LockTarget | null {
  return WORKSTATION_TARGETS.find((target) => target.id === id) ?? null;
}

// ------------------------------------------------------------- the catalogue

/** What a resolver found for one application on one surface. */
export interface ResolvedRelease {
  version: string;
  artifact: LockArtifact;
}

/** The source and provenance of one exact release on one surface. */
export interface AppSourcing {
  source: LockSource;
  provenance: LockProvenance;
}

/**
 * One external application, before a version is known.
 *
 * `runs` is the placement rule: a CLI goes to the surface that runs CLIs,
 * a GUI application to the one with a display, and `every` is for the two
 * that both halves of a Windows workstation genuinely need — mise, which
 * owns the runtimes on the Linux side and red-dev's own version on the
 * Windows side, and red-dev itself, which configures the Windows host
 * from Windows and the distro from the distro.
 */
export interface WorkstationApp {
  id: string;
  label: string;
  kind: AppKind;
  runs: "cli" | "gui" | "every";
  cloudAuth: LockCloudAuth | null;
  /** Null when this surface has no official source for this application. */
  sourcing: (surface: LockSurface, release: ResolvedRelease) => AppSourcing | null;
}

/** npm's own tarball name for a package version. PURE. */
function npmTarball(pkg: string, version: string): string {
  const unscoped = pkg.includes("/") ? (pkg.split("/")[1] as string) : pkg;
  return `${unscoped}-${version}.tgz`;
}

/**
 * A package on the public npm registry.
 *
 * The provenance is npm's own attestation endpoint rather than the
 * package page: what a depot has to be able to re-check offline is the
 * signed statement, and the URL that serves it is part of the lock.
 */
function npmSource(pkg: string, publisher: string) {
  return (_surface: LockSurface, release: ResolvedRelease): AppSourcing => ({
    source: {
      kind: "npm",
      coordinate: `${pkg}@${release.version}`,
      origin: `https://registry.npmjs.org/${pkg}/-/${npmTarball(pkg, release.version)}`,
      publisher,
    },
    provenance: {
      attestation: "npm-provenance",
      reference: `https://registry.npmjs.org/-/npm/v1/attestations/${pkg}@${release.version}`,
    },
  });
}

/** One asset of one GitHub release, by tag — never through `latest`. */
function githubReleaseSource(repo: string, publisher: string) {
  return (_surface: LockSurface, release: ResolvedRelease): AppSourcing => ({
    source: {
      kind: "github-release",
      coordinate: `${repo}@v${release.version}`,
      origin: `https://github.com/${repo}/releases/download/v${release.version}/${release.artifact.name}`,
      publisher,
    },
    provenance: {
      attestation: "github-attestation",
      reference: `https://github.com/${repo}/attestations/v${release.version}`,
    },
  });
}

/**
 * The publisher's install script, invoked with the version.
 *
 * An install script is a moving pointer by design — that is what people
 * want from a one-liner — so it can only appear in a lock where the
 * publisher takes a version argument. `coordinate` records the exact
 * invocation, and the audit above rejects the entry if it does not name
 * the locked version, which is how an unpinnable installer stays out of a
 * lock instead of quietly meaning `latest`.
 */
function installerSource(url: string, publisher: string) {
  return (_surface: LockSurface, release: ResolvedRelease): AppSourcing => ({
    source: {
      kind: "installer",
      coordinate: `${url} ${release.version}`,
      origin: url,
      publisher,
    },
    provenance: { attestation: "release-checksums", reference: `${url}.sha256` },
  });
}

/** A winget package, at the version whose manifest is in winget-pkgs. */
function wingetSource(id: string, publisher: string) {
  return (_surface: LockSurface, release: ResolvedRelease): AppSourcing => ({
    source: {
      kind: "winget",
      coordinate: `${id} ${release.version}`,
      origin: `https://winget.azureedge.net/cache/manifests/${id}/${release.version}`,
      publisher,
    },
    provenance: {
      attestation: "winget-manifest",
      reference: `https://github.com/microsoft/winget-pkgs/tree/master/manifests/${id.replace(/\./g, "/")}/${release.version}`,
    },
  });
}

/** A package from a third-party apt repository, pinned with `=`. */
function aptRepoSource(pkg: string, repo: string, key: string, publisher: string) {
  return (_surface: LockSurface, release: ResolvedRelease): AppSourcing => ({
    source: {
      kind: "apt-repo",
      coordinate: `${pkg}=${release.version}`,
      origin: repo,
      publisher,
    },
    provenance: { attestation: "publisher-key", reference: key },
  });
}

/**
 * The external applications, independent of the RedSkills package set.
 *
 * Everything here is somebody else's release, including our own two —
 * red-dev and RedCode ship on their own cadence and reach a machine the
 * same way zellij does. What is deliberately *not* here is the package
 * set itself: it has an identity of its own (`red.package-set.v1`), it is
 * signed by its publisher, and duplicating its version into this lock
 * would create a second answer to a question that already has one.
 */
export const WORKSTATION_APPS: readonly WorkstationApp[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    kind: "coder",
    runs: "cli",
    cloudAuth: { service: "Anthropic", evidence: "~/.claude/.credentials.json" },
    sourcing: installerSource("https://claude.ai/install.sh", "Anthropic"),
  },
  {
    id: "codex",
    label: "Codex CLI",
    kind: "coder",
    runs: "cli",
    cloudAuth: { service: "OpenAI", evidence: "~/.codex/auth.json" },
    sourcing: npmSource("@openai/codex", "OpenAI"),
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    kind: "coder",
    runs: "cli",
    cloudAuth: { service: "Google", evidence: "~/.gemini/oauth_creds.json" },
    sourcing: npmSource("@google/gemini-cli", "Google"),
  },
  {
    id: "herdr",
    label: "Herdr",
    kind: "companion",
    runs: "cli",
    cloudAuth: null,
    sourcing: installerSource("https://herdr.dev/install.sh", "Herdr"),
  },
  {
    id: "hermes",
    label: "Hermes Agent",
    kind: "coder",
    runs: "cli",
    cloudAuth: { service: "Nous Research", evidence: "~/.hermes/credentials.json" },
    sourcing: installerSource("https://hermes.nousresearch.com/install.sh", "Nous Research"),
  },
  {
    // mise on both halves of a Windows workstation, and that is not
    // duplication: the WSL one owns node, python and the CLIs, the
    // Windows one owns red-dev's own version there. They are two
    // installations of the same publisher's tool, which is exactly what
    // the surface field exists to be able to say.
    id: "mise",
    label: "mise",
    kind: "tooling",
    runs: "every",
    cloudAuth: null,
    sourcing: (surface, release) =>
      surface.os === "windows"
        ? wingetSource("jdx.mise", "jdx")(surface, release)
        : aptRepoSource(
            "mise",
            "https://mise.jdx.dev/deb",
            "https://mise.jdx.dev/gpg-key.pub",
            "jdx",
          )(surface, release),
  },
  {
    id: "node",
    label: "Node.js",
    kind: "runtime",
    runs: "cli",
    cloudAuth: null,
    sourcing: (_surface, release) => ({
      source: {
        kind: "mise",
        coordinate: `node@${release.version}`,
        origin: `https://nodejs.org/dist/v${release.version}/${release.artifact.name}`,
        publisher: "OpenJS Foundation",
      },
      provenance: {
        attestation: "release-checksums",
        reference: `https://nodejs.org/dist/v${release.version}/SHASUMS256.txt.asc`,
      },
    }),
  },
  {
    id: "opencode",
    label: "OpenCode",
    kind: "coder",
    runs: "cli",
    cloudAuth: { service: "model provider", evidence: "~/.local/share/opencode/auth.json" },
    sourcing: npmSource("opencode-ai", "OpenCode"),
  },
  {
    id: "pi",
    label: "Pi",
    kind: "coder",
    runs: "cli",
    cloudAuth: { service: "model provider", evidence: "~/.pi/auth.json" },
    sourcing: npmSource("@mariozechner/pi-coding-agent", "Mario Zechner"),
  },
  {
    id: "python",
    label: "Python",
    kind: "runtime",
    runs: "cli",
    cloudAuth: null,
    sourcing: (_surface, release) => ({
      source: {
        kind: "mise",
        coordinate: `python@${release.version}`,
        origin: `https://www.python.org/ftp/python/${release.version}/${release.artifact.name}`,
        publisher: "Python Software Foundation",
      },
      provenance: {
        attestation: "release-checksums",
        reference: `https://www.python.org/ftp/python/${release.version}/${release.artifact.name}.asc`,
      },
    }),
  },
  {
    id: "red-dev",
    label: "red-dev",
    kind: "tooling",
    runs: "every",
    cloudAuth: null,
    sourcing: githubReleaseSource("reddb-io/red-dev", "RedDB"),
  },
  {
    id: "redcode",
    label: "RedCode",
    kind: "coder",
    runs: "cli",
    cloudAuth: { service: "model provider", evidence: "~/.local/share/redcode/auth.json" },
    sourcing: githubReleaseSource("reddb-io/redcode", "RedDB"),
  },
  {
    // Microsoft's apt repository on Linux and winget on Windows, which is
    // the same tool from the same publisher through the two channels each
    // side actually has. The extension that goes inside it belongs to the
    // package set, not here.
    id: "vscode",
    label: "Visual Studio Code",
    kind: "editor",
    runs: "gui",
    cloudAuth: null,
    sourcing: (surface, release) =>
      surface.os === "windows"
        ? wingetSource("Microsoft.VisualStudioCode", "Microsoft")(surface, release)
        : aptRepoSource(
            "code",
            "https://packages.microsoft.com/repos/code",
            "https://packages.microsoft.com/keys/microsoft.asc",
            "Microsoft",
          )(surface, release),
  },
  {
    // Our fork, for as long as manifest.ts pins it: upstream 0.44.2 leaks
    // OSC replies into the terminal and there is no filename that says
    // so. The lock records the fork's tag, and the day the fix is
    // upstream both places change together.
    id: "zellij",
    label: "Zellij",
    kind: "companion",
    runs: "cli",
    cloudAuth: null,
    sourcing: githubReleaseSource("reddb-io/zellij", "RedDB"),
  },
];

/** The surface of `target` an application installs onto. PURE. */
export function surfacesFor(app: WorkstationApp, target: LockTarget): LockSurface[] {
  if (app.runs === "every") return [...target.surfaces];
  const wanted = app.runs;
  const matching = target.surfaces.filter((s) => s.role === wanted || s.role === "both");
  // One surface, always: a target with two CLI halves would be two
  // workstations, and picking one of them here would hide that.
  return matching.slice(0, 1);
}

// -------------------------------------------------------------- the resolver

/** What a resolution needs from the outside world: one exact release. */
export type ReleaseResolver = (
  app: WorkstationApp,
  surface: LockSurface,
) => Promise<ResolvedRelease>;

export type LockResolution =
  | { ok: true; lock: WorkstationLock }
  | { ok: false; reason: string };

/**
 * Resolve every external application for one target into one lock.
 *
 * The network lives in `resolve`, which is the whole reason this is
 * shaped as an injection: a resolution is a hundred registry lookups on a
 * connected machine, and it is a table in a test — and both have to
 * produce the same bytes for the same answers, or the fixture proves
 * nothing about the real thing. `resolvedAt` is a parameter for the same
 * reason: a lock that read a clock would never be byte-reproducible.
 *
 * A resolver that hands back something mutable is refused here rather
 * than written down, which is the difference between a lock and a
 * transcript of one afternoon's `latest`.
 *
 * `origin` is the resolver's own claim about itself: a resolution that
 * really fetched and hashed the publisher's bytes is `resolved`, and one
 * that read a table — a fixture, a depot rehearsal — says `fixture` and
 * is refused at install. It is a parameter rather than something this
 * function decides because this function cannot tell the difference.
 */
export async function resolveWorkstationLock(
  target: LockTarget,
  resolvedAt: string,
  resolve: ReleaseResolver,
  origin: LockOrigin = "resolved",
): Promise<LockResolution> {
  const apps: LockedApp[] = [];
  for (const app of WORKSTATION_APPS) {
    for (const surface of surfacesFor(app, target)) {
      const release = await resolve(app, surface);
      const sourcing = app.sourcing(surface, release);
      if (sourcing === null) {
        return {
          ok: false,
          reason: `${app.id} has no official source on ${surface.id}`,
        };
      }
      apps.push({
        id: app.id,
        label: app.label,
        kind: app.kind,
        surface: surface.id,
        version: release.version,
        source: sourcing.source,
        artifact: release.artifact,
        provenance: sourcing.provenance,
        cloudAuth: app.cloudAuth,
      });
    }
  }
  apps.sort((a, b) => appKey(a).localeCompare(appKey(b), "en"));

  const identity = { schema: WORKSTATION_LOCK_SCHEMA, target, origin, resolvedAt, apps };
  const lock: WorkstationLock = { ...identity, lockDigest: workstationLockDigest(identity) };

  const problems = auditWorkstationLock(lock);
  if (problems.length > 0) return { ok: false, reason: problems[0] as string };
  const missing = missingFromLock(lock);
  if (missing.length > 0) {
    return { ok: false, reason: `lock is incomplete: ${missing.join(", ")}` };
  }
  return { ok: true, lock };
}

// ------------------------------------------------------------------ the plan

/** One application as the machine currently has it. */
export interface ObservedApp {
  id: string;
  surface: string;
  /** Null when something is there but will not say what it is. */
  version: string | null;
}

/** The machine a lock is being planned against. */
export interface ObservedTarget {
  id: string;
  surfaces: string[];
  installed: readonly ObservedApp[];
  /** Applications whose cloud identity this machine already has. */
  authenticated: readonly string[];
}

export type LockAction =
  /** Nothing here yet. */
  | "install"
  /** Something here, at another version: the lock decides, in both directions. */
  | "replace"
  /** Already exactly what the lock says. */
  | "present";

export interface LockStep {
  app: LockedApp;
  action: LockAction;
  /** What is on the machine now, for a `replace` a person has to believe. */
  observed: string | null;
}

/** An account the operator still has to configure. Never a failure. */
export interface UnconfiguredIdentity {
  app: string;
  service: string;
  evidence: string;
}

export interface LockPlan {
  target: string;
  /** Every locked application, in lock order. */
  steps: LockStep[];
  unconfigured: UnconfiguredIdentity[];
}

export type LockPlanResult = { ok: true; plan: LockPlan } | { ok: false; reason: string };

/**
 * What this machine would do with this lock, without doing any of it.
 *
 * The refusals come first and they are all about identity: a lock for
 * another target, or a machine missing a surface the lock installs onto,
 * is not a plan with problems in it — it is a plan for somewhere else,
 * and the useful thing to do with it is to say so before an operator
 * spends an afternoon watching it half-apply.
 */
export function planLockedInstall(
  lock: WorkstationLock,
  observed: ObservedTarget,
): LockPlanResult {
  const problems = auditWorkstationLock(lock);
  if (problems.length > 0) return { ok: false, reason: problems[0] as string };

  if (lock.target.id !== observed.id) {
    return {
      ok: false,
      reason: `lock provisions ${lock.target.id}, not ${observed.id}`,
    };
  }
  const here = new Set(observed.surfaces);
  const absent = lock.target.surfaces.map((s) => s.id).filter((id) => !here.has(id));
  if (absent.length > 0) {
    return { ok: false, reason: `target ${observed.id} has no surface ${absent.join(", ")}` };
  }
  const missing = missingFromLock(lock);
  if (missing.length > 0) {
    return { ok: false, reason: `lock is incomplete: ${missing.join(", ")}` };
  }

  const found = new Map<string, string | null>();
  for (const app of observed.installed) found.set(appKey(app), app.version);

  const steps: LockStep[] = lock.apps.map((app) => {
    const key = appKey(app);
    if (!found.has(key)) return { app, action: "install", observed: null };
    const version = found.get(key) ?? null;
    return version === app.version
      ? { app, action: "present", observed: version }
      : { app, action: "replace", observed: version };
  });

  const authenticated = new Set(observed.authenticated);
  const unconfigured: UnconfiguredIdentity[] = [];
  for (const app of lock.apps) {
    if (app.cloudAuth === null || authenticated.has(app.id)) continue;
    if (unconfigured.some((entry) => entry.app === app.id)) continue;
    unconfigured.push({
      app: app.id,
      service: app.cloudAuth.service,
      evidence: app.cloudAuth.evidence,
    });
  }

  return { ok: true, plan: { target: lock.target.id, steps, unconfigured } };
}

/**
 * Whether the target is provisioned, in the sense the spec settles.
 *
 * Installed, synchronized and verified — and cloud authentication
 * deliberately outside it. `pending` is what is actually left to do;
 * `unconfigured` is carried through so a caller reporting readiness can
 * name the accounts in the same breath without either changing the
 * verdict.
 */
export interface LockReadiness {
  ready: boolean;
  pending: string[];
  unconfigured: UnconfiguredIdentity[];
}

export function lockReadiness(plan: LockPlan): LockReadiness {
  const pending = plan.steps
    .filter((step) => step.action !== "present")
    .map((step) => `${step.app.id} on ${step.app.surface}`);
  return { ready: pending.length === 0, pending, unconfigured: plan.unconfigured };
}

// --------------------------------------------------------------- the install

/** Performs one step. Whatever a caller uses to actually put bytes on disk. */
export type LockInstaller = (step: LockStep) => Promise<{ ok: boolean; detail?: string }>;

export interface LockInstallReport {
  target: string;
  installed: string[];
  /** Steps that needed nothing, so an operator can see the run was partial. */
  present: string[];
  failed: { app: string; detail: string }[];
  unconfigured: UnconfiguredIdentity[];
}

export type LockInstallResult =
  | { ok: true; report: LockInstallReport }
  | { ok: false; reason: string };

/**
 * Install the complete target from the lock, and nothing else.
 *
 * Everything refusable is refused before the first step runs — a fixture
 * lock, a lock for another target, a mutable version, an incomplete set —
 * because a locked installation that discovers its input was wrong
 * halfway through has already put an unlocked version on the machine.
 *
 * A failed application does not roll back the ones already installed and
 * does not stop the rest: decision 24 of the spec asks for visible,
 * retryable partial state rather than a transaction the host package
 * managers cannot honour anyway. The report names every side of it.
 */
export async function installFromLock(
  lock: WorkstationLock,
  observed: ObservedTarget,
  install: LockInstaller,
): Promise<LockInstallResult> {
  if (lock.origin !== "resolved") {
    return {
      ok: false,
      reason: `refusing to install a ${lock.origin} lock: its checksums were never computed from published bytes`,
    };
  }
  const planned = planLockedInstall(lock, observed);
  if (!planned.ok) return planned;

  const report: LockInstallReport = {
    target: lock.target.id,
    installed: [],
    present: [],
    failed: [],
    unconfigured: planned.plan.unconfigured,
  };
  for (const step of planned.plan.steps) {
    const name = `${step.app.id} on ${step.app.surface}`;
    if (step.action === "present") {
      report.present.push(name);
      continue;
    }
    const outcome = await install(step);
    if (outcome.ok) report.installed.push(name);
    else report.failed.push({ app: name, detail: outcome.detail ?? "install failed" });
  }
  return { ok: true, report };
}

/** Whether bytes that arrived are the bytes the lock names. PURE. */
export function artifactMatches(app: LockedApp, bytes: Uint8Array | string): boolean {
  return sha256Hex(bytes) === app.artifact.sha256;
}
