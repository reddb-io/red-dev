/**
 * The offline depot: one target's complete workstation, carried by hand.
 *
 * Two files already answer half of this. src/red-skills-set.ts says what
 * *our* revision is — one tree, one signed manifest, one digest — and
 * src/workstation-lock.ts says what everything we do not publish is, at
 * one exact version per surface. Both of them still assume a network:
 * the set is acquired from a GitHub release, and the lock records where
 * each artifact *would* be fetched from. A machine behind an air gap can
 * read neither.
 *
 * A **depot** is the medium that closes that gap. On a connected machine
 * it resolves every remote input once, hashes what came back against the
 * lock, copies the verified package set beside it, and signs one manifest
 * over the lot. On a target with no egress at all it is the only input:
 * the manifest is verified, every byte is re-hashed, the lock is
 * installed from depot-local artifacts, and `dev` — and only `dev` — is
 * activated. Nothing in the import path takes a fetcher, so "no network"
 * is a property of the code rather than a promise in a runbook.
 *
 * ## What the manifest has to pin
 *
 * Everything an import would otherwise have to ask somebody about:
 *
 *   - the **target**, in full, because a depot is target-specific and an
 *     Ubuntu depot half-applied to a Windows workstation is worse than no
 *     depot at all (the same argument ADR 0014 makes about the lock);
 *   - the **lock digest**, so the lock that arrives is the lock that was
 *     exported rather than one edited on the way;
 *   - the **package-set identity** — version, whole-set digest, source
 *     commit, ADR 0011's three facts — plus the revision this depot
 *     rolls back to, since a target with no network cannot fetch a
 *     previous release once the new one is on it;
 *   - the **activation**, which is `dev` and nothing else, because a
 *     depot that shipped every payload and left the choice to the import
 *     would be a depot that starts Memory and Brain on a machine for no
 *     reason anybody chose;
 *   - and every **entry**: its depot-relative path, its size and its
 *     sha256, so an import can prove the medium byte-for-byte before it
 *     touches the machine.
 *
 * The digest is taken over all of that, in canonical bytes, for the same
 * reason the package-set manifest and the lock do it: a depot that
 * arrives reformatted is refused rather than re-blessed under a digest
 * computed from whatever showed up.
 *
 * ## Nothing secret travels
 *
 * A depot is built on somebody's workstation and carried on a USB stick,
 * which is exactly the shape of accident that puts an `~/.aws/credentials`
 * or a `.npmrc` with a publish token on a stranger's desk. So both ends
 * scan: the export refuses to finish a depot that contains recognised
 * credential material, and the import refuses to read one. `scanForCredentials`
 * names the recogniser and the path and never the bytes it matched — a
 * finding that quoted the secret would put it in the log, the report and
 * the issue comment that pastes them.
 *
 * ## A second converge writes nothing
 *
 * `importDepot` verifies unconditionally and writes conditionally. The
 * machine-owned copy is skipped when the same manifest bytes are already
 * there, the lock installs nothing that is already at its locked version,
 * and the state file is rewritten only when one of those actually moved.
 * So the second run over an imported depot returns `converged: true` with
 * an empty `writes`, which is the acceptance criterion stated as a value
 * a test can read rather than a filesystem a test has to watch.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { sha256Hex } from "./checksum.ts";
import { ACTIVATED_PLUGIN, activatedPlugins } from "./red-skills-plugins.ts";
import {
  SET_BUNDLE_NAME,
  SET_MANIFEST_NAME,
  revisionKey,
  verifyPackageSet,
  type PackageSetIdentity,
  type SignatureVerifier,
} from "./red-skills-set.ts";
import {
  artifactMatches,
  auditWorkstationLock,
  encodeWorkstationLock,
  installFromLock,
  lockReadiness,
  missingFromLock,
  parseWorkstationLock,
  planLockedInstall,
  type LockInstallReport,
  type LockInstaller,
  type LockStep,
  type LockTarget,
  type LockedApp,
  type ObservedTarget,
  type UnconfiguredIdentity,
  type WorkstationLock,
} from "./workstation-lock.ts";

export const OFFLINE_DEPOT_SCHEMA = "red.offline-depot.v1";

/** The manifest a depot is identified and verified by. */
export const DEPOT_MANIFEST_NAME = "depot.manifest.json";

/** Its detached signature, verified with the same vendored trust root. */
export const DEPOT_BUNDLE_NAME = "depot.manifest.sigstore.json";

/** The workstation lock the depot provisions from. */
export const DEPOT_LOCK_NAME = "workstation-lock.json";

/** The verified RedSkills package set, exactly as red-skills-set.ts reads it. */
export const DEPOT_SET_DIR = "package-set";

/** `apps/<surface>/<artifact>` — one locked application's bytes. */
export const DEPOT_APPS_DIR = "apps";

// ---------------------------------------------------------------- the shape

/**
 * What one entry is, so an import knows what refusing it means.
 *
 * Three roles rather than a free-text label, and the split is the one an
 * operator reading a refusal cares about: a missing `app` is one
 * application that will not install, a corrupt `package-set` byte is the
 * whole of RedSkills, and a `lock` that does not hash is a depot that
 * cannot say what it provisions at all.
 */
export type DepotRole = "lock" | "package-set" | "app";

export interface DepotEntry {
  /** Depot-relative, POSIX-separated, never escaping the depot. */
  path: string;
  role: DepotRole;
  size: number;
  sha256: string;
}

/** One package-set revision the depot carries, by ADR 0011's identity. */
export interface DepotRevision {
  /** `<version>+<digest12>`, the same key the set state uses. */
  key: string;
  version: string;
  digest: string;
  /** Empty for a composed set: npm packages carry no commit. */
  sourceCommit: string;
}

/**
 * What a depot says about itself: `red.offline-depot.v1`.
 *
 * Every field except `depotDigest` is an input to `depotDigest`, so the
 * manifest cannot describe one depot and identify another.
 */
export interface OfflineDepot {
  schema: string;
  /** The one workstation this depot may be imported onto. */
  target: LockTarget;
  /** ISO 8601, from the caller: this module never reads a clock. */
  exportedAt: string;
  /** The digest the depot's own lock file must recompute to. */
  lockDigest: string;
  /** The revision this depot activates, and the one it rolls back to. */
  packageSet: { active: DepotRevision; previous: DepotRevision | null };
  /** `["dev"]`, always. Carried so the import can be held to it. */
  activated: string[];
  /** Sorted by path, unique. */
  entries: DepotEntry[];
  depotDigest: string;
}

const REVISION_KEYS = ["key", "version", "digest", "sourceCommit"] as const;
const ENTRY_KEYS = ["path", "role", "size", "sha256"] as const;
const SET_KEYS = ["active", "previous"] as const;
const DEPOT_KEYS = [
  "schema",
  "target",
  "exportedAt",
  "lockDigest",
  "packageSet",
  "activated",
  "entries",
  "depotDigest",
] as const;

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DEPOT_ROLES = new Set<DepotRole>(["lock", "package-set", "app"]);

/** The bytes the depot digest is taken over. PURE. */
export function offlineDepotIdentityBytes(
  depot: Omit<OfflineDepot, "depotDigest">,
): string {
  return `${JSON.stringify({
    schema: depot.schema,
    target: depot.target,
    exportedAt: depot.exportedAt,
    lockDigest: depot.lockDigest,
    packageSet: depot.packageSet,
    activated: depot.activated,
    entries: depot.entries,
  })}\n`;
}

/** The digest a depot must declare for its own contents. PURE. */
export function offlineDepotDigest(depot: Omit<OfflineDepot, "depotDigest">): string {
  return sha256Hex(offlineDepotIdentityBytes(depot));
}

/** The one encoding a depot manifest is allowed to have on disk. PURE. */
export function encodeOfflineDepot(depot: OfflineDepot): string {
  return `${JSON.stringify(depot, null, 2)}\n`;
}

/**
 * The short name one depot is addressable by on the target. PURE.
 *
 * The head of its own digest, for the reason `revisionKey` takes the head
 * of the set's: two depots that differ anywhere differ here, and the same
 * depot imported twice is the same directory rather than a second copy.
 */
export function depotKey(depot: Pick<OfflineDepot, "depotDigest">): string {
  return depot.depotDigest.slice(0, 12);
}

// ------------------------------------------------------------- the refusals

/**
 * A depot-relative path that cannot point outside the depot. PURE.
 *
 * Every entry path is joined onto both the medium and the machine-owned
 * copy, so an absolute path, a Windows separator or a `..` segment is not
 * a malformed field — it is a write somewhere nobody asked for.
 */
export function isDepotPath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function auditRevision(revision: DepotRevision, where: string, problems: string[]): void {
  if (!HEX64.test(revision.digest)) problems.push(`${where}: whole-set digest is invalid`);
  if (revision.key !== revisionKey(revision)) {
    problems.push(`${where}: revision key ${revision.key} does not name ${revision.version}`);
  }
  if (revision.sourceCommit !== "" && !/^[0-9a-f]{40}$/.test(revision.sourceCommit)) {
    problems.push(`${where}: source commit is neither empty nor 40 hex characters`);
  }
}

/**
 * Everything wrong with a depot, in the order it was found. PURE.
 *
 * Separate from the parser for the reason `auditWorkstationLock` is: the
 * export builds a depot in memory and the import reads one out of JSON,
 * and both have to refuse the same things or the export will happily
 * write a depot no target will take.
 */
export function auditOfflineDepot(depot: OfflineDepot): string[] {
  const problems: string[] = [];
  if (depot.schema !== OFFLINE_DEPOT_SCHEMA) {
    problems.push(`unsupported depot schema: ${depot.schema}`);
  }
  if (!ISO_8601.test(depot.exportedAt)) {
    problems.push("depot export time is not an ISO 8601 instant");
  }
  if (!HEX64.test(depot.lockDigest)) problems.push("lock digest is invalid");

  const surfaces = new Set<string>();
  let priorSurface = "";
  for (const surface of depot.target.surfaces) {
    if (surfaces.has(surface.id)) problems.push(`surface ${surface.id} is declared twice`);
    if (priorSurface && priorSurface.localeCompare(surface.id, "en") >= 0) {
      problems.push("target surfaces must be unique and sorted");
    }
    priorSurface = surface.id;
    surfaces.add(surface.id);
  }
  if (surfaces.size === 0) problems.push("target declares no surface");

  auditRevision(depot.packageSet.active, "active package set", problems);
  if (depot.packageSet.previous !== null) {
    auditRevision(depot.packageSet.previous, "previous package set", problems);
  }

  // Spec #201 draws this line once, in red-skills-plugins.ts. A depot
  // that declared its own activation would be a second answer to a
  // question that already has one, and the second answer is the one
  // that ships every payload switched on.
  if (depot.activated.length !== 1 || depot.activated[0] !== ACTIVATED_PLUGIN) {
    problems.push(`depot activates ${depot.activated.join(", ") || "nothing"}, not ${ACTIVATED_PLUGIN}`);
  }

  const roles = new Set<DepotRole>();
  const paths = new Set<string>();
  let priorPath = "";
  for (const entry of depot.entries) {
    if (!isDepotPath(entry.path)) {
      problems.push(`entry path ${entry.path} is not inside the depot`);
    }
    if (paths.has(entry.path)) problems.push(`entry ${entry.path} is declared twice`);
    if (priorPath && priorPath.localeCompare(entry.path, "en") >= 0) {
      problems.push("depot entries must be unique and sorted");
    }
    priorPath = entry.path;
    paths.add(entry.path);
    if (!DEPOT_ROLES.has(entry.role)) {
      problems.push(`entry ${entry.path}: unknown role ${entry.role}`);
    } else {
      roles.add(entry.role);
    }
    if (!Number.isInteger(entry.size) || entry.size < 0) {
      problems.push(`entry ${entry.path}: size is not a byte count`);
    }
    if (!HEX64.test(entry.sha256)) problems.push(`entry ${entry.path}: checksum is invalid`);
  }
  if (!paths.has(DEPOT_LOCK_NAME)) {
    problems.push(`depot carries no ${DEPOT_LOCK_NAME}`);
  }
  if (!paths.has(`${DEPOT_SET_DIR}/${SET_MANIFEST_NAME}`)) {
    problems.push(`depot carries no ${DEPOT_SET_DIR}/${SET_MANIFEST_NAME}`);
  }
  if (!paths.has(`${DEPOT_SET_DIR}/${SET_BUNDLE_NAME}`)) {
    problems.push(`depot carries no ${DEPOT_SET_DIR}/${SET_BUNDLE_NAME}`);
  }
  if (!roles.has("app")) {
    problems.push("depot carries no application artifacts");
  }

  if (offlineDepotDigest(depot) !== depot.depotDigest) {
    problems.push("depot digest does not match the depot contents");
  }
  return problems;
}

// ---------------------------------------------------------------- the parser

export type DepotParse =
  | { ok: true; depot: OfflineDepot }
  | { ok: false; reason: string };

function sameKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected)
  );
}

function parseRevision(raw: unknown): DepotRevision | null {
  if (!sameKeys(raw, REVISION_KEYS)) return null;
  const key = raw["key"];
  const version = raw["version"];
  const digest = raw["digest"];
  const sourceCommit = raw["sourceCommit"];
  if (typeof key !== "string" || typeof version !== "string") return null;
  if (typeof digest !== "string" || typeof sourceCommit !== "string") return null;
  return { key, version, digest, sourceCommit };
}

/**
 * A depot out of its bytes, or why these bytes are not one. PURE.
 *
 * Checked rather than cast, for the reason `parsePackageSetManifest` is:
 * this is the one input on an air-gapped target that arrived from outside
 * the machine, and an `as` here would turn a malformed field into an
 * import that verifies nothing while reporting that it did. The canonical
 * bytes are the last gate, so a depot that is right but reformatted is
 * refused rather than re-signed by accident.
 */
export function parseOfflineDepot(bytes: Uint8Array | string): DepotParse {
  const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "depot manifest is not valid JSON" };
  }
  if (!sameKeys(raw, DEPOT_KEYS)) {
    return { ok: false, reason: "depot manifest shape or key order is not canonical" };
  }

  const target = raw["target"];
  if (
    target === null ||
    typeof target !== "object" ||
    !Array.isArray((target as LockTarget).surfaces)
  ) {
    return { ok: false, reason: "depot manifest declares no target" };
  }
  const set = raw["packageSet"];
  if (!sameKeys(set, SET_KEYS)) {
    return { ok: false, reason: "depot manifest package-set shape is not canonical" };
  }
  const active = parseRevision(set["active"]);
  if (active === null) {
    return { ok: false, reason: "depot manifest names no active package-set revision" };
  }
  const previous = set["previous"] === null ? null : parseRevision(set["previous"]);
  if (previous === null && set["previous"] !== null) {
    return { ok: false, reason: "depot manifest previous package-set revision is malformed" };
  }

  const activated = raw["activated"];
  if (!Array.isArray(activated) || activated.some((name) => typeof name !== "string")) {
    return { ok: false, reason: "depot manifest activation list is malformed" };
  }
  const list = raw["entries"];
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, reason: "depot manifest declares no entries" };
  }
  const entries: DepotEntry[] = [];
  for (const item of list) {
    if (!sameKeys(item, ENTRY_KEYS)) {
      return { ok: false, reason: "depot entry shape or key order is not canonical" };
    }
    const path = item["path"];
    const role = item["role"];
    const size = item["size"];
    const sha256 = item["sha256"];
    if (typeof path !== "string" || typeof role !== "string" || typeof sha256 !== "string") {
      return { ok: false, reason: "depot entry fields are malformed" };
    }
    if (typeof size !== "number") {
      return { ok: false, reason: `depot entry ${path}: size is not a number` };
    }
    entries.push({ path, role: role as DepotRole, size, sha256 });
  }

  const schema = raw["schema"];
  const exportedAt = raw["exportedAt"];
  const lockDigest = raw["lockDigest"];
  const depotDigest = raw["depotDigest"];
  if (
    typeof schema !== "string" ||
    typeof exportedAt !== "string" ||
    typeof lockDigest !== "string" ||
    typeof depotDigest !== "string"
  ) {
    return { ok: false, reason: "depot manifest identity fields are malformed" };
  }

  const depot: OfflineDepot = {
    schema,
    target: target as LockTarget,
    exportedAt,
    lockDigest,
    packageSet: { active, previous },
    activated: activated as string[],
    entries,
    depotDigest,
  };
  const problems = auditOfflineDepot(depot);
  if (problems.length > 0) return { ok: false, reason: problems[0] as string };
  if (encodeOfflineDepot(depot) !== text) {
    return { ok: false, reason: "depot manifest bytes are not the canonical encoding" };
  }
  return { ok: true, depot };
}

// ---------------------------------------------------------- the credentials

/** One thing in a depot that looks like somebody's secret. */
export interface CredentialFinding {
  /** Depot-relative path, so a finding can be acted on without the medium. */
  path: string;
  /** The recogniser that fired, never the bytes it matched. */
  kind: string;
}

/**
 * Files that are credential stores whatever is in them.
 *
 * Matched on the trailing path segments rather than the basename alone,
 * because `credentials` and `config` are ordinary words everywhere except
 * under `.aws` and `.kube`, and a recogniser that fired on either would
 * teach the operator to ignore the scan.
 */
const CREDENTIAL_PATHS: readonly { suffix: string; kind: string }[] = [
  { suffix: ".aws/credentials", kind: "aws-credentials" },
  { suffix: ".aws/config", kind: "aws-config" },
  { suffix: ".kube/config", kind: "kubeconfig" },
  { suffix: ".docker/config.json", kind: "docker-auth" },
  { suffix: ".config/gh/hosts.yml", kind: "gh-hosts" },
  { suffix: ".git-credentials", kind: "git-credentials" },
  { suffix: ".netrc", kind: "netrc" },
  { suffix: "_netrc", kind: "netrc" },
  { suffix: ".npmrc", kind: "npmrc" },
  { suffix: ".pypirc", kind: "pypirc" },
  { suffix: ".claude/.credentials.json", kind: "claude-credentials" },
  { suffix: ".codex/auth.json", kind: "codex-auth" },
  { suffix: "auth.json", kind: "auth-store" },
  { suffix: "credentials.json", kind: "credential-store" },
  { suffix: "id_rsa", kind: "private-key" },
  { suffix: "id_ed25519", kind: "private-key" },
  { suffix: "id_ecdsa", kind: "private-key" },
  { suffix: "id_dsa", kind: "private-key" },
];

/** Extensions that are key material by convention. */
const CREDENTIAL_SUFFIXES: readonly { suffix: string; kind: string }[] = [
  { suffix: ".pem", kind: "private-key" },
  { suffix: ".key", kind: "private-key" },
  { suffix: ".p12", kind: "keystore" },
  { suffix: ".pfx", kind: "keystore" },
  { suffix: ".jks", kind: "keystore" },
];

/**
 * Token shapes their issuers made recognisable on purpose.
 *
 * Every one of these has a fixed prefix and a fixed length precisely so
 * that a scanner can find it, which is the whole reason a depot scan can
 * be honest about what it does and does not catch: an opaque secret in a
 * file nothing here names will not be found, and the export is a place to
 * catch the ordinary accident rather than a determined leak.
 */
const CREDENTIAL_PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: "github-token", re: /gh[pousr]_[A-Za-z0-9]{16,}/ },
  { kind: "github-pat", re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { kind: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "openai-key", re: /\bsk-[A-Za-z0-9]{32,}/ },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20}\b/ },
  { kind: "huggingface-token", re: /\bhf_[A-Za-z0-9]{34}\b/ },
  { kind: "registry-auth-token", re: /_authToken\s*[=:]/ },
  { kind: "private-key-block", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
];

/** How much of a file is read looking for a token. */
const SCAN_BYTES = 64 * 1024;

function walkFiles(root: string, rel: string, into: string[]): void {
  let names: string[];
  try {
    names = readdirSync(join(root, rel)).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const next = rel === "" ? name : `${rel}/${name}`;
    let stat;
    try {
      stat = statSync(join(root, next));
    } catch {
      continue;
    }
    if (stat.isDirectory()) walkFiles(root, next, into);
    else if (stat.isFile()) into.push(next);
  }
}

/** Every regular file under `root`, depot-relative and sorted. */
export function depotFiles(root: string): string[] {
  const files: string[] = [];
  walkFiles(root, "", files);
  files.sort((a, b) => a.localeCompare(b, "en"));
  return files;
}

/**
 * Credential material a depot must not be carrying.
 *
 * Two passes over the same file list. The path pass catches a whole store
 * that was copied in by accident — someone's `~/.aws` swept up with a home
 * directory — and the content pass catches a token pasted into an
 * otherwise innocent config. Binary files skip the content pass: a `.deb`
 * or a `.tar.gz` will produce a byte sequence matching almost anything
 * given enough megabytes, and a scan nobody believes is a scan nobody runs.
 *
 * The finding never carries the matched bytes. A report that quoted the
 * secret would put it into the log, the doctor output and whatever issue
 * comment pastes them, which is the leak the scan exists to prevent.
 */
export function scanForCredentials(root: string): CredentialFinding[] {
  const findings: CredentialFinding[] = [];
  for (const rel of depotFiles(root)) {
    const lower = rel.toLowerCase();
    const named =
      CREDENTIAL_PATHS.find((c) => lower === c.suffix || lower.endsWith(`/${c.suffix}`)) ??
      CREDENTIAL_SUFFIXES.find((c) => lower.endsWith(c.suffix));
    if (named !== undefined) {
      findings.push({ path: rel, kind: named.kind });
      continue;
    }
    let head: Buffer;
    try {
      head = readFileSync(join(root, rel)).subarray(0, SCAN_BYTES);
    } catch {
      continue;
    }
    if (head.includes(0)) continue;
    const text = head.toString("utf8");
    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.re.test(text)) {
        findings.push({ path: rel, kind: pattern.kind });
        break;
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------- the export

/**
 * Where one locked application's bytes live in the depot. PURE.
 *
 * Under its surface, because a Windows target locks the same application
 * twice — once in WSL and once native — and two entries with one path
 * would make the second overwrite the first with an artifact that has a
 * different checksum.
 */
export function depotAppPath(app: Pick<LockedApp, "surface" | "artifact">): string {
  return `${DEPOT_APPS_DIR}/${app.surface}/${app.artifact.name}`;
}

/** Fetches one locked application's exact bytes on the connected machine. */
export type DepotFetcher = (app: LockedApp) => Promise<Uint8Array | string | null>;

/**
 * Puts one locked application on the target, from bytes the depot carries.
 *
 * The artifact is handed in rather than looked up, and that is the whole
 * difference between "the import installs from the depot" as a property
 * and as a promise: the installer is never told where the publisher's
 * copy lives, so a step that reached for the network would have to invent
 * a URL nothing gave it. The bytes have already been read out of the
 * machine-owned copy and re-hashed against the lock, so an installer that
 * simply writes them has installed exactly what was locked.
 */
export type DepotInstaller = (
  step: LockStep,
  artifact: { path: string; bytes: Buffer },
) => Promise<{ ok: boolean; detail?: string }>;

/** Signs the depot manifest, producing the bundle that travels beside it. */
export type DepotSigner = (
  manifestPath: string,
) => { ok: true; bundle: Uint8Array | string } | { ok: false; reason: string };

export interface DepotExportOptions {
  /** A resolved lock for the target being exported. */
  lock: WorkstationLock;
  /** A verified manifest package set, as red-skills-set.ts lays one out. */
  setDir: string;
  /** Where the depot is written. Replaced wholesale. */
  dest: string;
  /** ISO 8601, from the caller: this module never reads a clock. */
  exportedAt: string;
  fetch: DepotFetcher;
  verifier: SignatureVerifier;
  sign: DepotSigner;
  /** The revision an offline rollback restores, when the depot carries one. */
  previous?: DepotRevision | null;
}

export interface DepotExportReport {
  depot: OfflineDepot;
  dir: string;
  /** Every path written, in the order it was written. */
  writes: string[];
}

export type DepotExportResult =
  | { ok: true; report: DepotExportReport }
  | { ok: false; reason: string };

function identityRevision(id: PackageSetIdentity): DepotRevision {
  return {
    key: revisionKey(id),
    version: id.version,
    digest: id.digest,
    sourceCommit: id.sourceCommit,
  };
}

/**
 * Build one target's depot on a connected machine.
 *
 * Every refusal happens before the first byte lands, or as close to it as
 * the work allows, because a half-written depot is indistinguishable from
 * a complete one by the time it reaches a machine with no way to ask.
 *
 * The order is: the lock has to be a resolved lock — a fixture's checksums
 * were never computed from published bytes, and a depot built from one
 * would provision a clean machine against digests nobody verified; the
 * lock has to be complete, because a depot missing an application is a
 * workstation missing it; the package set has to verify *here*, since the
 * target cannot re-acquire it; every artifact has to hash to what the lock
 * says, which is the moment a mutable source would be caught; and nothing
 * that looks like a credential may have come along, which is checked over
 * the finished tree rather than per file so that a copied `package-set/`
 * is scanned as thoroughly as the artifacts fetched one at a time.
 */
export async function exportDepot(opts: DepotExportOptions): Promise<DepotExportResult> {
  const { lock } = opts;
  if (lock.origin !== "resolved") {
    return {
      ok: false,
      reason: `refusing to export a ${lock.origin} lock: its checksums were never computed from published bytes`,
    };
  }
  const problems = auditWorkstationLock(lock);
  if (problems.length > 0) return { ok: false, reason: problems[0] as string };
  const missing = missingFromLock(lock);
  if (missing.length > 0) {
    return { ok: false, reason: `lock is incomplete: ${missing.join(", ")}` };
  }

  const set = verifyPackageSet(opts.setDir, { verifier: opts.verifier });
  if (!set.ok) {
    return { ok: false, reason: `package set will not verify here: ${set.reason}` };
  }

  const writes: string[] = [];
  rmSync(opts.dest, { recursive: true, force: true });
  mkdirSync(opts.dest, { recursive: true });

  const lockPath = join(opts.dest, DEPOT_LOCK_NAME);
  writeFileSync(lockPath, encodeWorkstationLock(lock), "utf8");
  writes.push(lockPath);

  // Copied whole rather than re-composed: the set that travels is the set
  // that verified a moment ago, and a depot that rebuilt it would be
  // shipping a tree nobody checked the signature over.
  const setDest = join(opts.dest, DEPOT_SET_DIR);
  cpSync(opts.setDir, setDest, { recursive: true, dereference: true });
  writes.push(setDest);

  for (const app of lock.apps) {
    const bytes = await opts.fetch(app);
    if (bytes === null) {
      rmSync(opts.dest, { recursive: true, force: true });
      return {
        ok: false,
        reason: `${app.id} on ${app.surface}: ${app.artifact.name} could not be resolved from ${app.source.origin}`,
      };
    }
    if (!artifactMatches(app, bytes)) {
      rmSync(opts.dest, { recursive: true, force: true });
      return {
        ok: false,
        reason: `${app.id} on ${app.surface}: ${app.artifact.name} does not hash to the locked checksum`,
      };
    }
    const path = join(opts.dest, depotAppPath(app));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes);
    writes.push(path);
  }

  const leaked = scanForCredentials(opts.dest);
  if (leaked.length > 0) {
    rmSync(opts.dest, { recursive: true, force: true });
    const first = leaked[0] as CredentialFinding;
    return {
      ok: false,
      reason:
        `refusing to export credential material: ${first.kind} at ${first.path}` +
        (leaked.length > 1 ? ` (and ${leaked.length - 1} more)` : ""),
    };
  }

  const entries: DepotEntry[] = depotFiles(opts.dest).map((path) => {
    const bytes = readFileSync(join(opts.dest, path));
    return { path, role: roleOf(path), size: bytes.length, sha256: sha256Hex(bytes) };
  });

  const identity: Omit<OfflineDepot, "depotDigest"> = {
    schema: OFFLINE_DEPOT_SCHEMA,
    target: lock.target,
    exportedAt: opts.exportedAt,
    lockDigest: lock.lockDigest,
    packageSet: {
      active: identityRevision(set.identity),
      previous: opts.previous ?? null,
    },
    activated: [ACTIVATED_PLUGIN],
    entries,
  };
  const depot: OfflineDepot = { ...identity, depotDigest: offlineDepotDigest(identity) };

  const wrong = auditOfflineDepot(depot);
  if (wrong.length > 0) {
    rmSync(opts.dest, { recursive: true, force: true });
    return { ok: false, reason: wrong[0] as string };
  }

  const manifestPath = join(opts.dest, DEPOT_MANIFEST_NAME);
  writeFileSync(manifestPath, encodeOfflineDepot(depot), "utf8");
  writes.push(manifestPath);

  const signed = opts.sign(manifestPath);
  if (!signed.ok) {
    rmSync(opts.dest, { recursive: true, force: true });
    return { ok: false, reason: `depot manifest could not be signed: ${signed.reason}` };
  }
  const bundlePath = join(opts.dest, DEPOT_BUNDLE_NAME);
  writeFileSync(
    bundlePath,
    typeof signed.bundle === "string" ? Buffer.from(signed.bundle, "utf8") : signed.bundle,
  );
  writes.push(bundlePath);

  return { ok: true, report: { depot, dir: opts.dest, writes } };
}

/** Which part of the workstation one depot path belongs to. PURE. */
function roleOf(path: string): DepotRole {
  if (path === DEPOT_LOCK_NAME) return "lock";
  if (path.startsWith(`${DEPOT_SET_DIR}/`)) return "package-set";
  return "app";
}

// ---------------------------------------------------------------- the import

/**
 * Which gate an import failed, so a caller can say what to do about it.
 *
 * `target` is deliberately not `manifest`: a depot for another workstation
 * is a correct depot in the wrong hand, and telling an operator their
 * medium is corrupt when it is simply somebody else's is the answer that
 * gets a good depot thrown away.
 */
export type DepotFailure =
  | "absent"
  | "manifest"
  | "target"
  | "entry"
  | "signature"
  | "credential"
  | "lock"
  | "activation";

export interface DepotImportOptions {
  /** The mounted medium. Never written to. */
  depot: string;
  /** The machine's home: every write lands under it. */
  home: string;
  observed: ObservedTarget;
  verifier: SignatureVerifier;
  /** Puts one locked application on the machine, from depot-local bytes. */
  install: DepotInstaller;
  /**
   * The plugin payloads this machine carries, so the activation the depot
   * declares can be checked against what would actually be switched on.
   * Defaults to the depot's own activation, which is the case where there
   * is nothing to disagree about.
   */
  plugins?: readonly string[];
}

export interface DepotImportReport {
  target: string;
  key: string;
  /** The machine-owned copy everything was installed from. */
  path: string;
  packageSet: DepotRevision;
  previous: DepotRevision | null;
  activated: string[];
  trustedBy: string;
  install: LockInstallReport;
  ready: boolean;
  pending: string[];
  unconfigured: UnconfiguredIdentity[];
  /** Every path written under `home`. Empty on a converged second run. */
  writes: string[];
  /** True when the machine was already exactly what the depot describes. */
  converged: boolean;
}

export type DepotImportResult =
  | { ok: true; report: DepotImportReport }
  | { ok: false; failure: DepotFailure; reason: string };

/** `~/.red-skills/depots/<key>` — the machine's own copy of one depot. */
export function importedDepotDir(home: string, key: string): string {
  return join(home, ".red-skills", "depots", key);
}

/** `~/.red-skills/offline-depot.json` — what this machine imported. */
export function offlineDepotStatePath(home: string): string {
  return join(home, ".red-skills", "offline-depot.json");
}

/** One depot this machine has imported, as the state records it. */
export interface ImportedDepot {
  key: string;
  target: string;
  exportedAt: string;
  path: string;
  lockDigest: string;
  packageSet: DepotRevision;
  previous: DepotRevision | null;
  activated: string[];
  trustedBy: string;
  ready: boolean;
  pending: string[];
  unconfigured: UnconfiguredIdentity[];
}

export interface OfflineDepotState {
  schema: 1;
  imported: ImportedDepot | null;
}

const EMPTY_DEPOT_STATE: OfflineDepotState = { schema: 1, imported: null };

/**
 * What this machine says it imported, or nothing.
 *
 * An unreadable state file is no state rather than an error, for the
 * reason `readPackageSetState` treats it that way: the bytes under
 * `depots/` are the truth, and the worst an unreadable record costs is
 * one import that rewrites it.
 */
export function readOfflineDepotState(home: string): OfflineDepotState {
  const path = offlineDepotStatePath(home);
  if (!existsSync(path)) return EMPTY_DEPOT_STATE;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<OfflineDepotState>;
    if (parsed?.schema !== 1) return EMPTY_DEPOT_STATE;
    return { schema: 1, imported: parsed.imported ?? null };
  } catch {
    return EMPTY_DEPOT_STATE;
  }
}

/** The one encoding the depot state is written in. PURE. */
export function encodeOfflineDepotState(state: OfflineDepotState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * Import one depot onto a network-denied target.
 *
 * Nothing in this function or anything it calls opens a socket. That is
 * the point, and it is why the installer is injected: whatever puts bytes
 * on the machine is handed the step and the depot-local artifact, and a
 * step that decided to fetch would be a step the caller wrote, in a file
 * this one does not import.
 *
 * The gates run identity-first and cheap-first: a depot for another target
 * is not a broken depot; entries before the signature for the reason
 * `verifyPackageSet` hashes artifacts before it verifies — bytes that are
 * not what the manifest declares are wrong whoever signed them, and saying
 * "trusted" about them first is the confident-and-wrong answer; the
 * credential scan before anything is copied, because the one thing worse
 * than importing somebody's token is importing it onto a second machine.
 */
export async function importDepot(opts: DepotImportOptions): Promise<DepotImportResult> {
  const manifestPath = join(opts.depot, DEPOT_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    return { ok: false, failure: "absent", reason: `${opts.depot} carries no ${DEPOT_MANIFEST_NAME}` };
  }
  const parsed = parseOfflineDepot(readFileSync(manifestPath));
  if (!parsed.ok) return { ok: false, failure: "manifest", reason: parsed.reason };
  const { depot } = parsed;

  if (depot.target.id !== opts.observed.id) {
    return {
      ok: false,
      failure: "target",
      reason: `depot provisions ${depot.target.id}, not ${opts.observed.id}`,
    };
  }
  const here = new Set(opts.observed.surfaces);
  const absent = depot.target.surfaces.map((s) => s.id).filter((id) => !here.has(id));
  if (absent.length > 0) {
    return {
      ok: false,
      failure: "target",
      reason: `target ${opts.observed.id} has no surface ${absent.join(", ")}`,
    };
  }

  for (const entry of depot.entries) {
    const path = join(opts.depot, entry.path);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      return { ok: false, failure: "entry", reason: `declared entry is missing: ${entry.path}` };
    }
    if (bytes.length !== entry.size) {
      return { ok: false, failure: "entry", reason: `entry size mismatch: ${entry.path}` };
    }
    if (sha256Hex(bytes) !== entry.sha256) {
      return { ok: false, failure: "entry", reason: `entry checksum mismatch: ${entry.path}` };
    }
  }

  const bundlePath = join(opts.depot, DEPOT_BUNDLE_NAME);
  if (!existsSync(bundlePath)) {
    return { ok: false, failure: "signature", reason: `${DEPOT_BUNDLE_NAME} is missing` };
  }
  const signature = opts.verifier(manifestPath, bundlePath);
  if (!signature.ok) return { ok: false, failure: "signature", reason: signature.reason };

  const leaked = scanForCredentials(opts.depot);
  if (leaked.length > 0) {
    const first = leaked[0] as CredentialFinding;
    return {
      ok: false,
      failure: "credential",
      reason:
        `refusing to import credential material: ${first.kind} at ${first.path}` +
        (leaked.length > 1 ? ` (and ${leaked.length - 1} more)` : ""),
    };
  }

  const lockParse = parseWorkstationLock(readFileSync(join(opts.depot, DEPOT_LOCK_NAME)));
  if (!lockParse.ok) return { ok: false, failure: "lock", reason: lockParse.reason };
  if (lockParse.lock.lockDigest !== depot.lockDigest) {
    return {
      ok: false,
      failure: "lock",
      reason: "the depot's lock is not the lock its manifest names",
    };
  }
  // The manifest carries the target so that a cross-target medium is
  // refused before anything is read; the lock carries it because the lock
  // is what installs. Two copies of one fact, so they are checked against
  // each other rather than trusted one at a time.
  if (JSON.stringify(lockParse.lock.target) !== JSON.stringify(depot.target)) {
    return {
      ok: false,
      failure: "lock",
      reason: "the depot's lock provisions a different target from its manifest",
    };
  }
  const planned = planLockedInstall(lockParse.lock, opts.observed);
  if (!planned.ok) return { ok: false, failure: "lock", reason: planned.reason };

  // ADR 0010 and #201 agree on exactly one activated plugin, and the
  // machine's own payload list is what decides whether that is what would
  // happen here. A depot that says `dev` handed to a machine that would
  // switch on Memory is a disagreement to stop on, not to average out.
  const carried = opts.plugins ?? depot.activated;
  const wouldActivate = activatedPlugins(carried);
  if (JSON.stringify(wouldActivate) !== JSON.stringify(depot.activated)) {
    return {
      ok: false,
      failure: "activation",
      reason: `depot activates ${depot.activated.join(", ")}, this machine would activate ${wouldActivate.join(", ") || "nothing"}`,
    };
  }

  const writes: string[] = [];
  const key = depotKey(depot);
  const owned = importedDepotDir(opts.home, key);
  const ownedManifest = join(owned, DEPOT_MANIFEST_NAME);
  // Copy, never link: ADR 0011's rule for the package set holds harder for
  // a depot, whose medium is a USB stick somebody is about to unplug.
  const alreadyOwned =
    existsSync(ownedManifest) && sha256Hex(readFileSync(ownedManifest)) === sha256Hex(readFileSync(manifestPath));
  if (!alreadyOwned) {
    rmSync(owned, { recursive: true, force: true });
    mkdirSync(dirname(owned), { recursive: true });
    cpSync(opts.depot, owned, { recursive: true, dereference: true });
    writes.push(owned);
  }

  // Every step is served out of the machine's own copy, and re-hashed
  // against the lock on the way through. A step whose artifact is not
  // there, or is not what the lock says, fails as that one application
  // rather than as a corrupt medium: the entry pass above already proved
  // the medium, so a disagreement here is about this one file.
  const installer: LockInstaller = async (step) => {
    const rel = depotAppPath(step.app);
    const path = join(owned, rel);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      return { ok: false, detail: `the depot carries no ${rel}` };
    }
    if (!artifactMatches(step.app, bytes)) {
      return { ok: false, detail: `${rel} does not hash to the locked checksum` };
    }
    return opts.install(step, { path, bytes });
  };
  const installed = await installFromLock(lockParse.lock, opts.observed, installer);
  if (!installed.ok) return { ok: false, failure: "lock", reason: installed.reason };

  // A failed application is reported, not thrown: ADR 0014 asks for
  // visible, retryable partial state rather than a transaction the host
  // package managers cannot honour. An import that installed thirteen of
  // fourteen applications has done thirteen applications of good, and the
  // operator needs to know which one to retry — not to be handed a
  // refusal that also throws away the depot record they would retry from.
  const readiness = lockReadiness(planned.plan);
  const pending = installed.report.failed.map((f) => `${f.app} (${f.detail})`);
  const record: ImportedDepot = {
    key,
    target: depot.target.id,
    exportedAt: depot.exportedAt,
    path: owned,
    lockDigest: depot.lockDigest,
    packageSet: depot.packageSet.active,
    previous: depot.packageSet.previous,
    activated: depot.activated,
    trustedBy: signature.by,
    ready: pending.length === 0,
    pending,
    unconfigured: readiness.unconfigured,
  };

  const statePath = offlineDepotStatePath(opts.home);
  const encoded = encodeOfflineDepotState({ schema: 1, imported: record });
  const unchanged = existsSync(statePath) && readFileSync(statePath, "utf8") === encoded;
  if (!unchanged) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, encoded, "utf8");
    writes.push(statePath);
  }

  return {
    ok: true,
    report: {
      target: depot.target.id,
      key,
      path: owned,
      packageSet: depot.packageSet.active,
      previous: depot.packageSet.previous,
      activated: depot.activated,
      trustedBy: signature.by,
      install: installed.report,
      ready: record.ready,
      pending: record.pending,
      unconfigured: record.unconfigured,
      writes,
      converged: writes.length === 0 && installed.report.installed.length === 0,
    },
  };
}

// --------------------------------------------------------------- the report

export interface DepotDoctorReport {
  /** What was imported, and whether its machine-owned copy is still there. */
  imported: (ImportedDepot & { addressable: boolean }) | null;
}

/**
 * What doctor says about the offline depot, as data.
 *
 * The same shape as every other report here — data, then rows — because
 * the facts a person wants when two air-gapped machines disagree (which
 * depot, which set, trusted by whom, what is still pending, which accounts
 * nobody could configure without a network) are the facts a script wants,
 * and rendering them twice is how the two answers start to differ.
 */
export function offlineDepotReport(home: string): DepotDoctorReport {
  const state = readOfflineDepotState(home);
  if (state.imported === null) return { imported: null };
  return { imported: { ...state.imported, addressable: existsSync(state.imported.path) } };
}

export interface DepotDoctorRow {
  status: "ok" | "warn" | "err" | "n/a";
  detail: string;
}

/** The report as the lines `red-dev doctor` prints. PURE. */
export function offlineDepotRows(report: DepotDoctorReport): DepotDoctorRow[] {
  const imported = report.imported;
  if (imported === null) {
    return [{ status: "n/a", detail: "no offline depot has been imported on this machine" }];
  }
  const rows: DepotDoctorRow[] = [];
  rows.push({
    status: imported.addressable ? "ok" : "err",
    detail:
      `offline depot ${imported.key} for ${imported.target} — package set ${imported.packageSet.key}, ` +
      `signed by ${imported.trustedBy}, exported ${imported.exportedAt}` +
      (imported.addressable ? "" : `, and its copy at ${imported.path} is gone`),
  });
  rows.push(
    imported.ready
      ? {
          status: "ok",
          detail: `workstation is installed and verified against the depot's lock, with ${imported.activated.join(", ")} activated`,
        }
      : {
          status: "warn",
          detail: `workstation is not yet complete: ${imported.pending.join(", ")}`,
        },
  );
  // Never a failure, and said in the same breath as readiness: decision 19
  // of the spec, and the reason an air-gapped workstation is not red forever.
  for (const account of imported.unconfigured) {
    rows.push({
      status: "n/a",
      detail: `${account.app} still needs a ${account.service} account — ${account.evidence} would prove it`,
    });
  }
  return rows;
}
