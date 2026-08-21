/**
 * The RedSkills package set: one tree, one identity, verified before it moves.
 *
 * Until now RedSkills reached this machine as four independently
 * resolved mise entries — the core payload plus one npm package per
 * plugin — and the layout step (`red-skills-core.ts`, which this file
 * retires) pointed `~/.red/skills/current` at the bare core tree mise
 * had installed. Two things were wrong with that, and both were only
 * visible on a machine that had actually converged: the core package
 * carries the marketplace manifests but no `plugins/` for them to name,
 * and no `.red/config.yaml` for the OpenCode generator to read, so a
 * Directory marketplace registered from `current` had nothing to install
 * and the opencode/redcode refresh died at "config not found". The
 * standalone installer never had either problem because it composes the
 * tree — core, `plugins/<name>`, `dist/<plugin>.bundle` — from the same
 * packages, pinned to one version, and points `current` at the result.
 *
 * ADR 0010 names the fix: **one package set**, a complete tree with one
 * identity, is the only thing `current` may name. This module is the
 * half of that decision red-dev owns — what a set is, how a candidate is
 * verified before anything on the machine resolves through it, and what
 * the machine keeps afterwards.
 *
 * ## Two ways a candidate arrives
 *
 * A **composed** set is what real machines have today: red-dev takes the
 * core and every manifest-declared plugin from mise's installs tree, at
 * the highest version present in *all* of them, and copies them into
 * one self-contained tree with the shape the standalone installer has
 * always produced. Versions that do not agree — a core published minutes
 * before its plugins, a plugin pruned under the core — are a candidate
 * that is refused, and refusing it is the whole point: the four packages
 * were never four things, and a machine that resolves a core at one
 * version and a plugin at another has an identity nothing can vouch for.
 * A composed set is `unsigned`; nothing published signs it yet.
 *
 * A **manifest** set is a directory carrying the `red.package-set.v1`
 * manifest RedSkills publishes with every release, its cosign bundle,
 * the artifacts the manifest declares, and the workstation tree to
 * activate. Today that directory is a fixture or a depot; once
 * reddb-io/red-skills#3977 publishes the complete set and #203 acquires
 * it, it is what every machine resolves. It verifies to `trusted`, and a
 * machine that has resolved a trusted set never accepts an unsigned one
 * again — stripping the manifest must not be a downgrade anybody can
 * perform.
 *
 * ## The contract is theirs, mirrored here exactly
 *
 * The manifest rules below — key order, sorted unique basenames, one
 * source commit for every artifact, the digest over the identity bytes,
 * the canonical encoding — are `scripts/verify-package-set.mjs` in the
 * red-skills repository, transcribed rather than reinterpreted. There is
 * deliberately no field the publisher does not emit: a `targets` list
 * would be rejected by their verifier and sit outside their signature,
 * so a schema this module does not know is refused as incompatible
 * metadata rather than tolerated. The manifest does not yet cover the
 * workstation tree beside it — that is the publishing side's slice — so
 * `trusted` here means "the release identity signed exactly these
 * artifacts, and they are the bytes on disk", and doctor says so.
 *
 * ## Verification happens before the pointer moves
 *
 * `~/.red/skills/current` is what every consumer on this machine reads —
 * the agent hosts, the marketplace registration, the host census, the
 * WSL rescue shim. Moving it is the one irreversible act here, and it
 * happens last: a candidate is parsed, hashed, checked against the trust
 * root and only then copied into its own immutable directory; `current`
 * moves onto that directory, `previous` onto the one it replaced, and
 * the state file records both. A candidate that fails any gate leaves
 * the machine exactly as it was — which is the whole difference between
 * a check and a reassurance.
 *
 * ## Copies, not links
 *
 * ADR 0008 linked the per-version directory into mise's install tree so
 * it would stay in step with mise. An immutable revision with a recorded
 * identity does not need to stay in step with anything, and links cost
 * more than they save here: the `bin/*.mjs` shims resolve `../dist/`
 * through their real path, so a linked `bin/` finds the core's `dist/`
 * and never the plugin bundles; the OpenCode generator writes its output
 * into `<tree>/dist/opencode`, which through a link is a write into a
 * mise-owned tree; `mise prune` collects the version `previous` would
 * roll back to; and on Windows a file symlink needs a privilege a
 * junction does not. A set is therefore a plain copy, about 25 MB, and
 * the machine keeps two of them. Only `current` and `previous` are
 * links — a junction on Windows, a symlink everywhere else.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import trustedRootFile from "../vendor/sigstore/trusted_root.embedded" with { type: "file" };

import { redSkillsRoot } from "./red-skills-root.ts";
import { sha256Hex } from "./checksum.ts";
import { log } from "./log.ts";
import { miseToolBin } from "./mise-config.ts";
import { miseInstallRoot } from "./mise-config.ts";
import type { Platform } from "./platform.ts";
import {
  activatedPlugins,
  REDSKILLS_PLUGIN_PREFIX,
  redSkillsPluginNames,
} from "./red-skills-plugins.ts";

// ------------------------------------------------------------- the names

/**
 * The backend-qualified name the manifest declares and mise resolves.
 *
 * Duplicated as a literal in manifest.ts rather than imported from
 * here: manifest.ts is what mise-config.ts projects, and this module
 * reads mise-config.ts, so an import would close a cycle around a
 * top-level `const`. A test pins the two spellings against each other,
 * which is the cheap half of the trade.
 *
 * Deliberately not `github:`. That backend scores release assets to put
 * a single executable on PATH, and what is installed here is a tree of
 * payloads, shims and companion artifacts rather than one binary.
 */
export const REDSKILLS_CORE_SPEC = "npm:@reddb-io/red-skills";

/** The short name [tool_alias] exposes, and the one people type. */
export const REDSKILLS_CORE_ALIAS = "red-skills";

/** How npm nests the core inside the install prefix mise hands it. */
const CORE_PACKAGE = "@reddb-io/red-skills";

/** The manifest RedSkills publishes beside every release's assets. */
export const SET_MANIFEST_NAME = "package-set.manifest.json";

/** Its cosign bundle: signature, certificate and log entry in one file. */
export const SET_BUNDLE_NAME = "package-set.manifest.sigstore.json";

/** The one schema this module knows. Anything else is refused. */
/**
 * The schema a published set declares, and the one before it.
 *
 * red-skills 4.0 extended the manifest: `version`, `channel` and
 * `targets` joined the identity the whole-set digest is taken over
 * (reddb-io/red-skills#4005 — a depot is target-specific, so the set has
 * to *say* what it was built for rather than leave the reader to guess).
 * red-dev transcribed v1 and refused every 4.x set on every machine with
 * `manifest shape or key order is not canonical`, which reads like a
 * corrupt download and is in fact a contract that moved.
 *
 * Both are accepted. v2 is what a release publishes now; v1 is what is
 * already on disk on every machine provisioned before today, and
 * refusing to *read* one would retire a verified set that is still the
 * best thing the machine has. Neither is tolerated loosely: each is the
 * publisher's own `scripts/verify-package-set.mjs` for that schema,
 * transcribed, and a manifest is measured against exactly the one it
 * declares.
 */
export const PACKAGE_SET_SCHEMA_V1 = "red.package-set.v1";
export const PACKAGE_SET_SCHEMA_V2 = "red.package-set.v2";

/** What `createPackageSetManifest` emits and a release publishes. */
export const PACKAGE_SET_SCHEMA = PACKAGE_SET_SCHEMA_V2;

/** The channels a set may declare, from the publisher's verifier. */
export const PACKAGE_SET_CHANNELS = ["stable", "canary", "next", "pinned"] as const;

/** The targets a set may declare, from the publisher's verifier. */
export const PACKAGE_SET_TARGETS = ["linux-x64", "windows-x64"] as const;

/**
 * How many revisions a machine keeps.
 *
 * Two, from ADR 0010: the active one and the one it would roll back to.
 * A third is a revision nothing can reach through either pointer, which
 * is how a gigabyte of superseded trees accumulated under the old layout.
 */
export const REDSKILLS_SET_RETENTION = 2;

/**
 * Who may sign a package set: the red-skills release workflow, on main
 * or on a version tag. Copied verbatim from the verifier the release
 * ships (`scripts/verify-package-set.mjs`), because two spellings of
 * the same identity are two things that can disagree about who
 * published what.
 */
export const REDSKILLS_RELEASE_IDENTITY =
  "^https://github\\.com/reddb-io/red-skills/\\.github/workflows/red-publish\\.yml@refs/heads/main$" +
  "|^https://github\\.com/reddb-io/red-skills/\\.github/workflows/red-publish\\.yml@refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+$";

/** The OIDC issuer a GitHub Actions identity is minted by. */
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

// ---------------------------------------------------------- the manifest

/** One artifact the manifest declares, and the bytes it must have. */
export interface PackageSetArtifact {
  /** One local basename; the file lives beside the manifest's artifacts. */
  name: string;
  /** Always the manifest's own commit — a mixed set is not a set. */
  sourceCommit: string;
  size: number;
  sha256: string;
}

/**
 * What a published package set says about itself: `red.package-set.v1`.
 *
 * Every field except `wholeSetDigest` is an input to `wholeSetDigest`,
 * so the manifest cannot describe one set and identify another.
 */
export interface PackageSetManifest {
  schema: string;
  /** The commit the whole set was built from, as 40 hex characters. */
  sourceCommit: string;
  /** v2 only: the release version, as semver. */
  version?: string;
  /** v2 only: one of PACKAGE_SET_CHANNELS. */
  channel?: string;
  /** v2 only: what the set was built for, sorted and unique. */
  targets?: string[];
  /** Sorted by name, unique. */
  artifacts: PackageSetArtifact[];
  wholeSetDigest: string;
}

/**
 * The fields declared in the order the canonical encoding needs them.
 *
 * `JSON.stringify` drops a key whose value is undefined, so one shape
 * serialises both schemas: a v1 manifest carries no version, channel or
 * targets and its bytes are exactly what they always were.
 */
function manifestIdentity(m: Pick<PackageSetManifest, "schema" | "sourceCommit" | "version" | "channel" | "targets" | "artifacts">) {
  return {
    schema: m.schema,
    sourceCommit: m.sourceCommit,
    version: m.version,
    channel: m.channel,
    targets: m.targets,
    artifacts: m.artifacts,
  };
}

/** The three facts that name one revision anywhere. */
export interface PackageSetIdentity {
  version: string;
  digest: string;
  /** Empty for a composed set: npm packages carry no commit. */
  sourceCommit: string;
}

const MANIFEST_KEYS_V1 = ["schema", "sourceCommit", "artifacts", "wholeSetDigest"] as const;
const MANIFEST_KEYS_V2 = [
  "schema",
  "sourceCommit",
  "version",
  "channel",
  "targets",
  "artifacts",
  "wholeSetDigest",
] as const;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const ARTIFACT_KEYS = ["name", "sourceCommit", "size", "sha256"] as const;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** The bytes the whole-set digest is taken over. PURE. */
export function packageSetIdentityBytes(
  m: Pick<PackageSetManifest, "schema" | "sourceCommit" | "version" | "channel" | "targets" | "artifacts">,
): string {
  return `${JSON.stringify(manifestIdentity(m))}\n`;
}

/** The digest a manifest must declare for its own contents. PURE. */
export function packageSetDigest(
  m: Pick<PackageSetManifest, "schema" | "sourceCommit" | "version" | "channel" | "targets" | "artifacts">,
): string {
  return sha256Hex(packageSetIdentityBytes(m));
}

/** The one encoding a manifest is allowed to have on disk. PURE. */
export function encodePackageSet(m: PackageSetManifest): string {
  return `${JSON.stringify(m, null, 2)}\n`;
}

/**
 * Build a manifest over artifacts already hashed. PURE.
 *
 * What the release does, so a test — or a depot export — can produce a
 * set this module accepts without a second opinion about the encoding.
 */
export function createPackageSetManifest(
  sourceCommit: string,
  artifacts: readonly Omit<PackageSetArtifact, "sourceCommit">[],
  /**
   * The v2 fields. Omitted, this builds a v1 manifest — which is what an
   * offline depot exported before today still contains, and what a test
   * that says nothing about version or targets means.
   */
  release?: { version: string; channel: string; targets: readonly string[] },
): PackageSetManifest {
  const declared: PackageSetArtifact[] = [...artifacts]
    .map((a) => ({ name: a.name, sourceCommit, size: a.size, sha256: a.sha256 }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  const identity = manifestIdentity({
    schema: release ? PACKAGE_SET_SCHEMA_V2 : PACKAGE_SET_SCHEMA_V1,
    sourceCommit,
    ...(release
      ? {
          version: release.version,
          channel: release.channel,
          targets: [...release.targets].sort((a, b) => a.localeCompare(b, "en")),
        }
      : {}),
    artifacts: declared,
  });
  return { ...identity, wholeSetDigest: packageSetDigest(identity) };
}

export type ManifestParse =
  | { ok: true; manifest: PackageSetManifest }
  | { ok: false; reason: string };

function sameKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected)
  );
}

/**
 * A manifest out of its bytes, or why these bytes are not one. PURE.
 *
 * Every rule here is the publisher's own verifier, transcribed: the key
 * order, the sorted unique basenames, the per-artifact commit, the
 * digest over the identity bytes, and finally that the bytes on disk are
 * exactly the canonical encoding. Checked rather than cast, because the
 * manifest is the one input here that arrives from outside the machine,
 * and `as` would turn a malformed field into an install that verifies
 * nothing while reporting that it did.
 */
export function parsePackageSetManifest(bytes: Uint8Array | string): ManifestParse {
  const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "manifest is not valid JSON" };
  }
  // The schema decides which shape is canonical, so it is read before
  // the shape is judged: measuring a v2 manifest against v1's key list
  // reports "not canonical" about a manifest that is perfectly canonical
  // for what it declares, which is what every 4.x set was told.
  const declared = (raw as Record<string, unknown> | null)?.["schema"];
  if (declared !== PACKAGE_SET_SCHEMA_V1 && declared !== PACKAGE_SET_SCHEMA_V2) {
    // Named with the cure. A publisher that moves the schema forward
    // makes every older red-dev refuse every set it publishes, and the
    // machine reading this message is the one that cannot tell a new
    // contract from a corrupt download. This red-dev knows these two.
    return {
      ok: false,
      reason:
        `unsupported manifest schema: ${String(declared)} — ` +
        `this red-dev reads ${PACKAGE_SET_SCHEMA_V1} and ${PACKAGE_SET_SCHEMA_V2}, so update red-dev`,
    };
  }
  const v2 = declared === PACKAGE_SET_SCHEMA_V2;
  if (!sameKeys(raw, v2 ? MANIFEST_KEYS_V2 : MANIFEST_KEYS_V1)) {
    return { ok: false, reason: "manifest shape or key order is not canonical" };
  }
  const sourceCommit = raw["sourceCommit"];
  if (typeof sourceCommit !== "string" || !HEX40.test(sourceCommit)) {
    return { ok: false, reason: "manifest source commit is invalid" };
  }
  let version: string | undefined;
  let channel: string | undefined;
  let targets: string[] | undefined;
  if (v2) {
    const declaredVersion = raw["version"];
    if (typeof declaredVersion !== "string" || !SEMVER.test(declaredVersion)) {
      return { ok: false, reason: "manifest version is invalid" };
    }
    version = declaredVersion;

    const declaredChannel = raw["channel"];
    if (typeof declaredChannel !== "string" || !PACKAGE_SET_CHANNELS.includes(declaredChannel as never)) {
      return { ok: false, reason: `manifest channel is not a known channel: ${String(declaredChannel)}` };
    }
    channel = declaredChannel;

    const declaredTargets = raw["targets"];
    if (!Array.isArray(declaredTargets) || declaredTargets.length === 0) {
      return { ok: false, reason: "manifest must declare at least one target" };
    }
    let priorTarget = "";
    for (const target of declaredTargets) {
      if (typeof target !== "string" || !PACKAGE_SET_TARGETS.includes(target as never)) {
        return { ok: false, reason: `manifest declares an unknown target: ${String(target)}` };
      }
      if (priorTarget && priorTarget.localeCompare(target, "en") >= 0) {
        return { ok: false, reason: "targets must be unique and sorted" };
      }
      priorTarget = target;
    }
    targets = declaredTargets as string[];
  }

  const list = raw["artifacts"];
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, reason: "manifest must declare at least one artifact" };
  }
  const wholeSetDigest = raw["wholeSetDigest"];
  if (typeof wholeSetDigest !== "string" || !HEX64.test(wholeSetDigest)) {
    return { ok: false, reason: "whole-set digest is invalid" };
  }

  const artifacts: PackageSetArtifact[] = [];
  let prior = "";
  for (const entry of list) {
    if (!sameKeys(entry, ARTIFACT_KEYS)) {
      return { ok: false, reason: "artifact shape or key order is not canonical" };
    }
    const name = entry["name"];
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name === "." ||
      name === ".." ||
      basename(name) !== name
    ) {
      return { ok: false, reason: "artifact name must be one local basename" };
    }
    if (prior && prior.localeCompare(name, "en") >= 0) {
      return { ok: false, reason: "artifact names must be unique and sorted" };
    }
    prior = name;
    if (entry["sourceCommit"] !== sourceCommit) {
      return { ok: false, reason: `artifact ${name} belongs to a different source commit` };
    }
    const size = entry["size"];
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      return { ok: false, reason: `artifact ${name} has an invalid size` };
    }
    const sha256 = entry["sha256"];
    if (typeof sha256 !== "string" || !HEX64.test(sha256)) {
      return { ok: false, reason: `artifact ${name} has an invalid checksum` };
    }
    artifacts.push({ name, sourceCommit, size, sha256 });
  }

  const manifest: PackageSetManifest = {
    schema: declared,
    sourceCommit,
    ...(version !== undefined ? { version } : {}),
    ...(channel !== undefined ? { channel } : {}),
    ...(targets !== undefined ? { targets } : {}),
    artifacts,
    wholeSetDigest,
  };
  if (packageSetDigest(manifest) !== wholeSetDigest) {
    return { ok: false, reason: "whole-set digest does not match the manifest identity" };
  }
  if (encodePackageSet(manifest) !== text) {
    return { ok: false, reason: "manifest bytes are not canonical" };
  }
  return { ok: true, manifest };
}

// ---------------------------------------------------------------- the trust

/**
 * Whether the machine believes a set was published by whom it says.
 *
 * Three answers rather than a boolean, because the middle one is the
 * state every machine is in today: `unsigned` is a composed set, which
 * nothing published signs yet, and it is a fact to report rather than a
 * verdict to act on. `untrusted` is a manifest whose signature is
 * missing or does not verify, and that is refused.
 */
export type TrustVerdict =
  | { kind: "trusted"; by: string }
  | { kind: "untrusted"; reason: string }
  | { kind: "unsigned"; reason: string };

/**
 * Does this bundle sign these manifest bytes, and by the identity we expect?
 *
 * Injected so the gates above it can be tested without a signer, and
 * so the one test that does sign can hand in a key-based verifier. The
 * default is cosign, below.
 */
export type SignatureVerifier = (
  manifestPath: string,
  bundlePath: string,
) => { ok: true; by: string } | { ok: false; reason: string };

export interface CosignOptions {
  /** The binary. Defaults to `cosign` on PATH — the mise entry puts it there. */
  cosignBin?: string;
  /** Who may have signed. Defaults to the red-skills release workflow. */
  identityRegexp?: string;
  issuer?: string;
  /**
   * The Sigstore trust root handed to cosign, or null to let cosign
   * fetch one through TUF (online only). Defaults to the vendored root,
   * materialised under the red-dev config directory.
   */
  trustedRoot?: string | null;
  home?: string;
}

/**
 * The argv one keyless verification runs. PURE.
 *
 * `--offline`: everything the check needs is in the bundle and the trust
 * root, so cosign must not reach for the network — an air-gapped depot
 * import is the case this exists for. cosign 3 deprecates the flag in
 * favour of the same behaviour by default and only warns; cosign 2
 * still needs it.
 */
export function cosignVerifyArgv(
  manifestPath: string,
  bundlePath: string,
  opts: { cosignBin: string; identityRegexp: string; issuer: string; trustedRoot: string | null },
): string[] {
  return [
    opts.cosignBin,
    "verify-blob",
    "--offline",
    "--bundle",
    bundlePath,
    "--certificate-identity-regexp",
    opts.identityRegexp,
    "--certificate-oidc-issuer",
    opts.issuer,
    ...(opts.trustedRoot ? ["--trusted-root", opts.trustedRoot] : []),
    manifestPath,
  ];
}

/** `~/.config/red-dev/sigstore/trusted_root.json` — the vendored root, on disk. */
export function trustedRootPath(home: string): string {
  return join(home, ".config", "red-dev", "sigstore", "trusted_root.json");
}

/**
 * Put the vendored trust root where cosign can read it.
 *
 * The embedded asset lives inside the binary's own filesystem, which
 * cosign — a separate process — cannot open, so it is written out once
 * and rewritten only when the vendored bytes change. The write is
 * compare-then-write for the same reason everything here is: a converge
 * that rewrites an unchanged file is a converge claiming work.
 */
export function materialiseTrustedRoot(home: string): string {
  const path = trustedRootPath(home);
  const bytes = readFileSync(trustedRootFile);
  const existing = readIfPresent(path);
  if (existing === null || !existing.equals(bytes)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  return path;
}

/** The verifier every real machine uses: cosign, keyless, offline. */
export function cosignVerifier(opts: CosignOptions = {}): SignatureVerifier {
  return (manifestPath, bundlePath) => {
    // The mise copy by path first: cosign is a declared tool, and the
    // converge that installs it needs it in the very next item, before
    // any shell has re-read $PATH. See miseToolBin.
    const cosignBin = opts.cosignBin ?? miseToolBin("cosign") ?? "cosign";
    const trustedRoot =
      opts.trustedRoot === undefined
        ? materialiseTrustedRoot(opts.home ?? homeOf(process.env))
        : opts.trustedRoot;
    const argv = cosignVerifyArgv(manifestPath, bundlePath, {
      cosignBin,
      identityRegexp: opts.identityRegexp ?? REDSKILLS_RELEASE_IDENTITY,
      issuer: opts.issuer ?? GITHUB_OIDC_ISSUER,
      trustedRoot,
    });
    const result = spawnSync(argv[0] as string, argv.slice(1), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) {
      return { ok: false, reason: `signature verifier could not run: ${result.error.message}` };
    }
    if (result.status !== 0) {
      // cosign's own reason is the only thing that separates "wrong
      // signer", "tampered manifest" and "could not reach the trust
      // root"; swallowing it leaves a bare "invalid" in the log.
      const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").pop() ?? "";
      return { ok: false, reason: `manifest signature is invalid${detail ? `: ${detail}` : ""}` };
    }
    return { ok: true, by: "red-skills release workflow (sigstore)" };
  };
}

// --------------------------------------------------------- the verification

/** Which gate a candidate failed, so a caller can say what to do about it. */
export type SetFailure =
  | "absent"
  | "manifest"
  | "artifact"
  | "signature"
  | "tree"
  | "skew"
  | "payload"
  | "downgrade"
  // The last two are the acquisition's (red-skills-acquire.ts) rather
  // than the verifier's: a set is refused the same way and recorded in
  // the same state file whether it was composed from mise, imported
  // from a depot, or downloaded — so it has one vocabulary, and doctor
  // has one line to print it with.
  | "cross-commit"
  | "network";

export type SetVerification =
  | {
      ok: true;
      manifest: PackageSetManifest;
      identity: PackageSetIdentity;
      trust: { kind: "trusted"; by: string };
      /** The workstation tree the set carries, to be activated. */
      tree: string;
      /**
       * The verified artifacts beside it.
       *
       * Not everything a release publishes belongs in the tree — the
       * VS Code extension, the verifier, the checksums stay in
       * `artifacts/` (see overlaysIntoTree in red-skills-acquire.ts).
       * Named here so activation can take them along; a set that
       * arrived without them is a set whose companions have nothing to
       * install from.
       */
      artifacts: string;
    }
  | { ok: false; failure: SetFailure; reason: string };

/** Where a manifest set keeps its artifacts: flat, beside the manifest. */
export function setArtifactsDir(dir: string): string {
  return join(dir, "artifacts");
}

/** Where a manifest set keeps the workstation tree it activates. */
export function setTreeDir(dir: string): string {
  return join(dir, "tree");
}

/**
 * Verify one manifest set, in the order the gates have to run.
 *
 * Parse — which recomputes the digest and checks the canonical bytes —
 * then every artifact, then the signature, then that there is a tree to
 * activate. Artifacts before the signature deliberately: a manifest
 * whose artifacts are not the bytes it declares is wrong whoever signed
 * it, and reporting "trusted" about it first would be the confident-
 * and-wrong answer this whole module exists to avoid.
 *
 * Nothing here writes, so a caller may verify a candidate without
 * committing the machine to it — which is what makes "the pointer moves
 * only after verification" a property of the code rather than a habit.
 */
export function verifyPackageSet(
  dir: string,
  opts: { verifier: SignatureVerifier },
): SetVerification {
  const manifestPath = join(dir, SET_MANIFEST_NAME);
  const bytes = readIfPresent(manifestPath);
  if (bytes === null) {
    return { ok: false, failure: "absent", reason: `${SET_MANIFEST_NAME} is not there` };
  }

  const parsed = parsePackageSetManifest(bytes);
  if (!parsed.ok) return { ok: false, failure: "manifest", reason: parsed.reason };
  const { manifest } = parsed;

  const artifacts = setArtifactsDir(dir);
  for (const artifact of manifest.artifacts) {
    const path = join(artifacts, artifact.name);
    const stat = statOf(path);
    if (stat === null || !stat.isFile()) {
      return { ok: false, failure: "artifact", reason: `declared artifact is missing: ${artifact.name}` };
    }
    if (stat.size !== artifact.size) {
      return { ok: false, failure: "artifact", reason: `artifact size mismatch: ${artifact.name}` };
    }
    if (sha256Hex(readFileSync(path)) !== artifact.sha256) {
      return { ok: false, failure: "artifact", reason: `artifact checksum mismatch: ${artifact.name}` };
    }
  }

  const bundlePath = join(dir, SET_BUNDLE_NAME);
  if (!existsSync(bundlePath)) {
    return { ok: false, failure: "signature", reason: `${SET_BUNDLE_NAME} is missing` };
  }
  const signature = opts.verifier(manifestPath, bundlePath);
  if (!signature.ok) return { ok: false, failure: "signature", reason: signature.reason };

  const tree = setTreeDir(dir);
  const version = versionOfTree(tree);
  if (version === null) {
    return { ok: false, failure: "tree", reason: "the set carries no workstation tree with a package.json" };
  }

  return {
    ok: true,
    manifest,
    identity: { version, digest: manifest.wholeSetDigest, sourceCommit: manifest.sourceCommit },
    trust: { kind: "trusted", by: signature.by },
    tree,
    artifacts: setArtifactsDir(dir),
  };
}

// ------------------------------------------------------------ composition

/** Where mise keeps the installed versions of one tool. */
export function miseInstallDirName(entry: { spec: string; alias?: string }): string {
  if (entry.alias) return entry.alias;
  const colon = entry.spec.indexOf(":");
  if (colon < 0) return entry.spec;
  const backend = entry.spec.slice(0, colon);
  const name = entry.spec.slice(colon + 1).replace(/^@/, "").replace(/[@/]/g, "-");
  return `${backend}-${name}`;
}

/** `<installs>/red-skills` — the core's versions. */
export function coreInstallsDir(installsRoot: string): string {
  return join(installsRoot, miseInstallDirName({ spec: REDSKILLS_CORE_SPEC, alias: REDSKILLS_CORE_ALIAS }));
}

/** `<installs>/red-skills-<name>` — one plugin's versions. */
export function pluginInstallsDir(installsRoot: string, name: string): string {
  return join(
    installsRoot,
    miseInstallDirName({ spec: `${REDSKILLS_PLUGIN_PREFIX}${name}`, alias: `red-skills-${name}` }),
  );
}

/** The package tree inside one installed version of a tool. */
export function payloadDir(installsDir: string, version: string, pkg: string): string {
  return join(installsDir, version, "node_modules", pkg);
}

const EXACT_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * The versions a *set* may carry, which is one more shape than mise's
 * install directories have.
 *
 * ADR 0010's `next` channel is the prereleases: a machine following it
 * activates a tree whose package.json says `3.20.0-next.1`, and a
 * pattern that only admits `x.y.z` would refuse it as "no workstation
 * tree" — a refusal about the version number wearing the clothes of a
 * refusal about the payload. Deliberately not used for mise's installs
 * tree above, where the exact-version rule is what tells a version
 * apart from the `latest` and `3.18` selector links beside it.
 */
const SET_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The exact versions mise has installed of one tool, oldest first.
 *
 * Exact `x.y.z` directories only. mise writes `latest`, `3` and `3.18`
 * beside them as symlinks into whichever exact version each selector
 * resolved to; counting those would make the answer depend on which
 * selectors this machine happened to ask for. Sorted segment by segment
 * rather than lexically, so 3.10.0 comes after 3.9.0 — the ordering bug
 * that only shows up two years in.
 */
export function installedVersions(installsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(installsDir);
  } catch {
    return [];
  }
  return names
    .map((name) => EXACT_VERSION.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .filter((m) => statOf(join(installsDir, m[0]))?.isSymbolicLink() === false)
    .map((m) => ({ name: m[0], parts: [Number(m[1]), Number(m[2]), Number(m[3])] as const }))
    .sort((a, b) => a.parts[0] - b.parts[0] || a.parts[1] - b.parts[1] || a.parts[2] - b.parts[2])
    .map((v) => v.name);
}

/** The newest exact version, or null when none is installed. */
export function installedCoreVersion(installsDir: string): string | null {
  return installedVersions(installsDir).at(-1) ?? null;
}

/** What mise has, read as one candidate rather than as four tools. */
export type MiseCandidate =
  | {
      kind: "ready";
      version: string;
      core: string;
      plugins: Record<string, string>;
      /**
       * Tools that have something newer than `version`, and the newest
       * they have.
       *
       * A composed set is the version present in *every* tool, so one
       * package left behind holds the whole set there. That is the right
       * answer and it used to be a silent one: on 2026-08-19 the core
       * was at 3.22.0, the three plugin packages at 3.19.5 because a
       * release-age gate had held them, and the machine composed 3.19.5
       * and said nothing about the four months of core it was declining
       * to use. Named here so the converge can say which package is
       * holding the set, which is the one fact that makes it fixable.
       */
      behind: { tool: string; newest: string }[];
    }
  /** Every tool is installed, but no single version is present in all of them. */
  | { kind: "skew"; versions: Record<string, string[]> }
  /** Some tool has not been installed at all yet — mid-converge, not a fault. */
  | { kind: "incomplete"; missing: string[] }
  /** Every core mise has is a payload that cannot compose a set. */
  | { kind: "unusable"; reason: string }
  | { kind: "none" };

/**
 * What a core payload must carry for the tree composed from it to serve
 * every consumer: the two marketplace manifests the Claude and Codex
 * registrations read, the shims, and the generators the OpenCode/RedCode
 * and Pi refreshes run. Relative to the core package root.
 *
 * Checked before anything is composed, because a payload from before
 * the package set (the npm package carried none of these until 3.19)
 * composes a tree that *looks* complete and then fails at every host —
 * and mise's release-age policy makes such a payload the one it
 * resolves for days after a release. Refusing keeps `current` on the
 * tree that works.
 */
export const CORE_PAYLOAD_CONTRACT: readonly string[] = [
  "package.json",
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
  "bin",
  "scripts/install-opencode.sh",
  "scripts/install-pi.sh",
];

/** What a core payload is missing to compose a set, or nothing. PURE over the tree. */
export function corePayloadGaps(core: string): string[] {
  return CORE_PAYLOAD_CONTRACT.filter((rel) => !existsSync(join(core, rel)));
}

/**
 * The one version to compose, or why there is none.
 *
 * The highest version present in *all* the required tools, never each
 * tool's own newest: mise resolves four `latest` selectors on four
 * schedules, and a core published minutes before its plugins is the
 * ordinary case rather than the odd one. A tool with nothing installed
 * yet is `incomplete` — the first converge installs them one row at a
 * time and asks after every row — and is answered quietly; every tool
 * present with no version in common is `skew`, and is refused out loud.
 */
export function candidateFromMise(installsRoot: string, plugins: readonly string[]): MiseCandidate {
  const dirs: Record<string, string> = { [REDSKILLS_CORE_ALIAS]: coreInstallsDir(installsRoot) };
  for (const name of plugins) dirs[`red-skills-${name}`] = pluginInstallsDir(installsRoot, name);

  const versions: Record<string, string[]> = {};
  const missing: string[] = [];
  const unusable: string[] = [];
  for (const [tool, dir] of Object.entries(dirs)) {
    const pkg = tool === REDSKILLS_CORE_ALIAS ? CORE_PACKAGE : `@reddb-io/${tool}`;
    let present = installedVersions(dir).filter((v) => existsSync(join(payloadDir(dir, v, pkg), "package.json")));
    if (tool === REDSKILLS_CORE_ALIAS) {
      // Only a core that can compose a set counts as a version of the
      // core; one that cannot is remembered so the refusal can say why.
      const usable = present.filter((v) => corePayloadGaps(payloadDir(dir, v, pkg)).length === 0);
      unusable.push(...present.filter((v) => !usable.includes(v)));
      if (present.length > 0 && usable.length === 0) {
        const newest = present.at(-1) as string;
        const gaps = corePayloadGaps(payloadDir(dir, newest, pkg));
        return {
          kind: "unusable",
          reason:
            `core ${newest} carries no ${gaps.join(", ")} — a payload from before the ` +
            "package set cannot compose one (mise resolves a release only after its " +
            "minimum release age; the newer core is not there yet)",
        };
      }
      present = usable;
    }
    versions[tool] = present;
    if (present.length === 0) missing.push(tool);
  }
  if (missing.length === Object.keys(dirs).length) return { kind: "none" };
  if (missing.length > 0) return { kind: "incomplete", missing };

  const common = (versions[REDSKILLS_CORE_ALIAS] ?? []).filter((v) =>
    Object.values(versions).every((list) => list.includes(v)),
  );
  const version = common.at(-1);
  if (version === undefined) return { kind: "skew", versions };

  const behind: { tool: string; newest: string }[] = [];
  for (const [tool, list] of Object.entries(versions)) {
    const newest = list.at(-1);
    if (newest !== undefined && newest !== version) behind.push({ tool, newest });
  }

  const out: Record<string, string> = {};
  for (const name of plugins) {
    out[name] = payloadDir(pluginInstallsDir(installsRoot, name), version, `@reddb-io/red-skills-${name}`);
  }
  return {
    kind: "ready",
    version,
    behind,
    core: payloadDir(coreInstallsDir(installsRoot), version, CORE_PACKAGE),
    plugins: out,
  };
}

/**
 * The host-activation config the OpenCode generator reads.
 *
 * Not a repository `.red/` — that stays `/red-setup`'s alone — and it
 * enables nothing inside any project. It is the ADR 0067 opt-in gate
 * for the plugins the composed set carries, written once beside the
 * tree, exactly as the standalone installer writes it. PURE.
 *
 * Every plugin the set carries gets a row, and only the activated ones
 * get a true. That distinction is the whole of Spec #201's "every payload
 * is installed, `dev` is activated": omitting the others would make
 * switching one on a download again, and enabling them would start Memory
 * and Brain acting on a machine because they were in the tarball. The
 * generators read these flags, which is how the three hosts red-dev does
 * not hand a plugin list to are held to the same activation as the four
 * it does.
 */
export function hostActivationConfig(
  plugins: readonly string[],
  activated: readonly string[] = plugins,
): string {
  const lines = [
    "# Written by red-dev: activation flags for the host-install generator",
    "# (opencode-host) over the composed RedSkills package set. Not a",
    "# repository config — /red-setup owns those, and this file enables",
    "# nothing inside any project.",
    "plugins:",
  ];
  for (const name of plugins) {
    lines.push(`  ${name}:`, `    enabled: ${activated.includes(name)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Compose one self-contained tree at `dest`, from what mise installed.
 *
 * The shape is the standalone installer's, chosen for that reason
 * rather than invented: the core at the root, each plugin package under
 * `plugins/<name>`, every file of each plugin's `dist/` beside the
 * core's own so the `bin/` shims and the bundles that lazily load an
 * asset next to themselves both find what they resolve, and the
 * activation config. A runtime plugin whose package carries no bundle
 * is a package that cannot be launched, and is refused before anything
 * is written.
 */
export function composeSet(
  candidate: Extract<MiseCandidate, { kind: "ready" }>,
  dest: string,
): { ok: true } | { ok: false; reason: string } {
  const gaps = corePayloadGaps(candidate.core);
  if (gaps.length > 0) {
    return { ok: false, reason: `core ${candidate.version} carries no ${gaps.join(", ")}` };
  }
  for (const [name, dir] of Object.entries(candidate.plugins)) {
    const dist = join(dir, "dist");
    if (existsSync(dist) && !existsSync(join(dist, `${name}.bundle.min.mjs`))) {
      return { ok: false, reason: `plugin ${name} carries a dist/ without ${name}.bundle.min.mjs` };
    }
  }

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(candidate.core, dest, { recursive: true, dereference: true });
  mkdirSync(join(dest, "plugins"), { recursive: true });
  mkdirSync(join(dest, "dist"), { recursive: true });
  for (const [name, dir] of Object.entries(candidate.plugins)) {
    cpSync(dir, join(dest, "plugins", name), { recursive: true, dereference: true });
    const dist = join(dir, "dist");
    for (const file of listing(dist)) {
      const stat = statOf(join(dist, file));
      if (stat?.isFile()) cpSync(join(dist, file), join(dest, "dist", file), { dereference: true });
    }
  }
  const config = join(dest, ".red", "config.yaml");
  if (!existsSync(config)) {
    mkdirSync(dirname(config), { recursive: true });
    const carried = Object.keys(candidate.plugins);
    writeFileSync(config, hostActivationConfig(carried, activatedPlugins(carried)), "utf8");
  }
  restoreScriptModes(dest);
  return { ok: true };
}

/**
 * Make the generators runnable again.
 *
 * An npm tarball drops the executable bit on `scripts/*.sh`, and the
 * host refresh spawns `<tree>/scripts/install-opencode.sh` directly —
 * which is EACCES on a tree copied straight out of a package. The
 * standalone installer runs them under `bash` for the same reason. This
 * is red-dev's own copy, so the bit is put back where it belongs; on
 * Windows the mode is meaningless and the call is harmless.
 */
function restoreScriptModes(tree: string): void {
  const scripts = join(tree, "scripts");
  for (const name of listing(scripts)) {
    if (!name.endsWith(".sh")) continue;
    const path = join(scripts, name);
    if (statOf(path)?.isFile()) {
      try {
        chmodSync(path, 0o755);
      } catch {
        // A filesystem that refuses modes gives the same answer it gave
        // the tarball; the host refresh will say so.
      }
    }
  }
}

/**
 * The content digest of one tree: every file's path and bytes. PURE
 * over the tree.
 *
 * Sorted, path-and-hash per line, so two trees with the same files are
 * the same digest whichever order the filesystem lists them in, and any
 * plugin file, companion artifact or shim that differs makes a
 * different one. Symlinks are hashed by their target text; there should
 * be none in a composed set, and one that appears is part of the
 * identity rather than invisible to it.
 *
 * `skip` is how a development checkout leaves out what is not its
 * content — its `.git`, its `node_modules` — without a second walk that
 * would be free to hash a tree differently from this one.
 */
export function treeDigest(root: string, opts: { skip?: (rel: string) => boolean } = {}): string {
  const lines: string[] = [];
  const skip = opts.skip ?? (() => false);
  const walk = (dir: string, rel: string): void => {
    for (const name of listing(dir)) {
      const path = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      if (skip(relPath)) continue;
      const stat = statOf(path);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        lines.push(`${relPath}\0link:${sha256Hex(readlinkOf(path))}`);
      } else if (stat.isDirectory()) {
        walk(path, relPath);
      } else if (stat.isFile()) {
        lines.push(`${relPath}\0${sha256Hex(readFileSync(path))}`);
      }
    }
  };
  walk(root, "");
  lines.sort();
  return sha256Hex(`${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------- the state

/** One revision this machine holds, active or retained for a rollback. */
export interface PackageSetRevision {
  /** `<version>+<digest12>` — the directory's name and the state's key. */
  key: string;
  version: string;
  digest: string;
  /** Empty for a composed set, and for a checkout that is not clean at a commit. */
  sourceCommit: string;
  /** `checkout` is a development tree staged by red-dev, never a release. */
  kind: "composed" | "manifest" | "checkout";
  trust: "trusted" | "unsigned";
  /** The immutable directory this revision is addressable through. */
  path: string;
}

/** Why the last candidate was not activated, kept so doctor can say. */
export interface PackageSetRefusal {
  failure: SetFailure;
  reason: string;
}

export interface PackageSetState {
  schema: 1;
  /** The revision `current` names, by key. */
  active: string | null;
  /** Newest first, capped at REDSKILLS_SET_RETENTION. */
  revisions: PackageSetRevision[];
  refused: PackageSetRefusal | null;
  /**
   * A verified revision on disk that `current` does not name yet.
   *
   * ADR 0010's Workers rule: an update that arrives while Workers are
   * running stages the complete revision and leaves the machine on the
   * one it is working against. Recorded rather than kept in the process
   * that staged it, because the activation happens in a later run —
   * after the Worker finishes — and a staged revision nothing wrote
   * down would have to be acquired a second time to be activated, which
   * is the reacquisition the criterion forbids.
   */
  staged: PackageSetRevision | null;
}

const EMPTY_STATE: PackageSetState = {
  schema: 1,
  active: null,
  revisions: [],
  refused: null,
  staged: null,
};

/** `~/.red/skills/package-set.json` — what the machine believes it has. */
export function packageSetStatePath(home: string): string {
  return join(redSkillsRoot(home), "package-set.json");
}

/**
 * The recorded state, or an empty one.
 *
 * An unreadable state file is treated as no state rather than as an
 * error: the pointers on disk are the truth, and the worst this costs
 * is one converge that rewrites a record it could not read.
 */
export function readPackageSetState(home: string): PackageSetState {
  const bytes = readIfPresent(packageSetStatePath(home));
  if (bytes === null) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as Partial<PackageSetState>;
    if (parsed?.schema !== 1 || !Array.isArray(parsed.revisions)) return EMPTY_STATE;
    return {
      schema: 1,
      active: typeof parsed.active === "string" ? parsed.active : null,
      revisions: parsed.revisions,
      refused: parsed.refused ?? null,
      // Absent in every state file written before staging existed, and
      // that is the same fact as "nothing is staged" rather than a
      // reason to discard a record this build can otherwise read.
      staged: parsed.staged ?? null,
    };
  } catch {
    return EMPTY_STATE;
  }
}

/**
 * How a revision is keyed, and therefore how its directory is named.
 *
 * Version plus the head of the digest: two sets that differ in any
 * payload differ here, and the same set installed twice is the same
 * name — which is what makes a re-converge a no-op instead of a second
 * copy.
 */
export function revisionKey(id: PackageSetIdentity): string {
  return `${id.version}+${id.digest.slice(0, 12)}`;
}

const REVISION_KEY = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\+[0-9a-f]{12}$/;

/** `3.19.5+3fcba9589ff0@626a284` — one line naming one set. PURE. */
export function formatPackageSetIdentity(id: PackageSetIdentity): string {
  const commit = id.sourceCommit ? `@${id.sourceCommit.slice(0, 7)}` : "";
  return `${revisionKey(id)}${commit}`;
}

// --------------------------------------------------------------- the layout

/** `~/.red/skills/sets/<key>` — one immutable revision, addressable by name. */
export function redSkillsSetDir(home: string, key: string): string {
  return join(redSkillsRoot(home), "sets", key);
}

/** `~/.red/skills/current` — the stable pointer everything else reads. */
export function redSkillsCurrentLink(home: string): string {
  return join(redSkillsRoot(home), "current");
}

/** `~/.red/skills/previous` — the revision a rollback restores. */
export function redSkillsPreviousLink(home: string): string {
  return join(redSkillsRoot(home), "previous");
}

/**
 * The link flavour this platform can create without asking for rights.
 *
 * "junction" on Windows and "dir" everywhere else. Node ignores the type
 * argument on POSIX, so the distinction only ever bites on the one
 * platform where it matters — and there the wrong answer is not
 * cosmetic: a "dir" symlink needs SeCreateSymbolicLinkPrivilege, which
 * an unprivileged account only has with developer mode on.
 */
export function directoryLinkType(
  platform: NodeJS.Platform = process.platform,
): "junction" | "dir" {
  return platform === "win32" ? "junction" : "dir";
}

// -------------------------------------------------------------- the converge

export interface PackageSetConvergeOptions {
  /** Defaults to this user's home. Injected by the tests. */
  home?: string;
  /**
   * A manifest set to verify and activate. When given, mise is not
   * consulted — this is what a depot import or a fixture hands in.
   */
  source?: string;
  /**
   * A development checkout's staged tree, activated as an unsigned
   * `checkout` revision. There is no manifest and no signature to verify
   * — a working tree publishes neither — so the caller
   * (src/red-skills-checkout.ts) has already established the identity
   * from the content, and this is only the activation.
   */
  checkout?: { tree: string; identity: PackageSetIdentity };
  /** Defaults to mise's installs root. */
  installsRoot?: string;
  /** The plugins the composed set must carry. Defaults to the manifest's. */
  plugins?: readonly string[];
  platform?: NodeJS.Platform;
  /** The red-dev platform, used only to derive the plugin set. */
  manifestPlatform?: Platform;
  /** Defaults to cosign. */
  verifier?: SignatureVerifier;
  /**
   * Verify and stage the revision directory, but leave `current` where
   * it is. Reserved for the update that must not change the active set
   * under running Workers (ADR 0010); the caller decides when.
   */
  stageOnly?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface PackageSetConverge {
  /** False when the machine was already in this state. */
  changed: boolean;
  /**
   * Every path this converge wrote, in order.
   *
   * Empty is the assertion an idempotent converge is worth making: a
   * second run that rewrites the pointer everything stats is a run that
   * reports work it did not do.
   */
  writes: string[];
  /** The identity `current` names once this returns, or null. */
  active: PackageSetIdentity | null;
  /** What the machine holds, newest first: the active one and its rollback. */
  retained: PackageSetRevision[];
  /** Why the candidate was refused, or null when it was not. */
  refused: PackageSetRefusal | null;
  /**
   * The revision staged and awaiting activation, or null.
   *
   * Non-null exactly when this converge verified a revision it was told
   * not to activate. `active` still names what the machine resolves, so
   * the two together are the whole answer to "what is this machine on,
   * and what is it about to be on".
   */
  staged: PackageSetIdentity | null;
  current: string;
  /** The immutable directory `current` resolves to, or null. */
  revisionDir: string | null;
}

/**
 * Install and activate the one package set this machine should resolve.
 *
 * The order is the contract: find the candidate, verify it, copy it
 * under its own immutable name, then move `current`, then record the
 * state, then retire whatever is now past the retention. A refusal
 * returns before any of the others and answers with the state the
 * machine already had — so a refused set is indistinguishable, on disk,
 * from a converge that never ran, except for the one line in the state
 * file that lets doctor say why.
 */
export function convergeRedSkillsPackageSet(
  opts: PackageSetConvergeOptions = {},
): PackageSetConverge {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homeOf(env);
  const platform = opts.platform ?? process.platform;
  const state = readPackageSetState(home);
  const current = redSkillsCurrentLink(home);

  const unchanged = (): PackageSetConverge => ({
    changed: false,
    writes: [],
    active: activeIdentity(state),
    retained: state.revisions,
    refused: state.refused,
    staged: identityOf(state.staged),
    current,
    revisionDir: activeRevision(state)?.path ?? null,
  });

  const refuse = (failure: SetFailure, reason: string): PackageSetConverge => {
    log.err(`red-skills package set refused (${failure}): ${reason}`);
    log.plain("       current is unchanged — the machine keeps the set it already resolves");
    const writes = recordRefusal(home, state, { failure, reason });
    return { ...unchanged(), changed: writes.length > 0, writes, refused: { failure, reason } };
  };

  const activeTrusted = activeRevision(state)?.trust === "trusted";

  // A checkout, before the two acquisitions, and deliberately not
  // subject to the downgrade guard below: that guard exists so an
  // unsigned set nobody asked for cannot displace a verified one, and a
  // checkout is the one candidate somebody asked for by name. The
  // verified revision it displaces stays retained as the rollback.
  if (opts.checkout !== undefined) {
    const { tree, identity } = opts.checkout;
    if (!existsSync(join(tree, "package.json"))) {
      return refuse("tree", `the staged checkout at ${tree} carries no workstation tree`);
    }
    const key = revisionKey(identity);
    const path = redSkillsSetDir(home, key);
    return activate(
      home,
      platform,
      state,
      { key, ...identity, kind: "checkout", trust: "unsigned", path },
      () => copyTree(tree, path),
      opts.stageOnly === true,
    );
  }

  if (opts.source !== undefined) {
    const verifier = opts.verifier ?? cosignVerifier({ home });
    const verification = verifyPackageSet(opts.source, { verifier });
    if (!verification.ok) return refuse(verification.failure, verification.reason);
    const key = revisionKey(verification.identity);
    const path = redSkillsSetDir(home, key);
    return activate(
      home,
      platform,
      state,
      {
        key,
        version: verification.identity.version,
        digest: verification.identity.digest,
        sourceCommit: verification.identity.sourceCommit,
        kind: "manifest",
        trust: "trusted",
        path,
      },
      () => copySet(verification.tree, verification.artifacts, path),
      opts.stageOnly === true,
    );
  }

  const installsRoot = opts.installsRoot ?? miseInstallRoot(env);
  const plugins = opts.plugins ?? redSkillsPluginNames(opts.manifestPlatform ?? platformOf(platform));
  const candidate = candidateFromMise(installsRoot, plugins);
  if (candidate.kind === "none") return unchanged();
  if (candidate.kind === "incomplete") {
    // Mid-converge: the rows install one at a time and ask after each.
    return unchanged();
  }
  if (candidate.kind === "unusable") return refuse("payload", candidate.reason);
  if (candidate.kind === "skew") {
    const detail = Object.entries(candidate.versions)
      .map(([tool, list]) => `${tool} ${list.length > 0 ? list.join(",") : "none"}`)
      .join("; ");
    return refuse("skew", `no version is installed for every RedSkills tool (${detail})`);
  }
  // Said before anything is composed, because it is true whether or not
  // the composition then goes ahead: the set this machine is about to
  // resolve is older than what one of its packages already holds.
  if (candidate.behind.length > 0) {
    const held = candidate.behind.map((b) => `${b.tool} has ${b.newest}`).join(", ");
    log.warn(
      `red-skills: composing ${candidate.version} — the version every package shares (${held})`,
    );
    log.plain("       upgrade the packages that lag, or the set stays here");
  }

  if (activeTrusted) {
    return refuse(
      "downgrade",
      "this machine resolves a verified package set, and an unsigned composed one cannot replace it",
    );
  }

  // Compose into a staging directory first, because the key — and so
  // the directory's final name — is the digest of what was composed.
  const staging = redSkillsSetDir(home, `.tmp-${candidate.version}`);
  const composed = composeSet(candidate, staging);
  if (!composed.ok) {
    rmSync(staging, { recursive: true, force: true });
    return refuse("artifact", composed.reason);
  }
  const identity: PackageSetIdentity = {
    version: candidate.version,
    digest: treeDigest(staging),
    sourceCommit: "",
  };
  const key = revisionKey(identity);
  const path = redSkillsSetDir(home, key);
  return activate(
    home,
    platform,
    state,
    { key, ...identity, kind: "composed", trust: "unsigned", path },
    () => {
      if (existsSync(path)) {
        rmSync(staging, { recursive: true, force: true });
      } else {
        renameSync(staging, path);
      }
    },
    opts.stageOnly === true,
  );
}

/**
 * The converge step that belongs after a mise install.
 *
 * Keyed on the spec and silent for every other tool, so the provider in
 * providers.ts stays one call site wide instead of growing a table of
 * per-tool afterthoughts. Fires for the core and for every plugin
 * package: whichever of the four moved, the set they compose has.
 */
export function convergeSetAfterMise(
  spec: string,
  opts: PackageSetConvergeOptions = {},
): PackageSetConverge | null {
  if (spec !== REDSKILLS_CORE_SPEC && !spec.startsWith(REDSKILLS_PLUGIN_PREFIX)) return null;
  return convergeRedSkillsPackageSet(opts);
}

/**
 * Activate the revision a previous run staged, acquiring nothing.
 *
 * The other half of ADR 0010's Workers rule. The staged revision was
 * verified when it was staged — the signature was checked, the tree was
 * copied under its immutable name — and none of that is worth doing
 * twice. So this reads the record, confirms the directory is still
 * there, and performs the one step staging left out: moving `current`.
 *
 * `null` when nothing is staged, which is the ordinary case and not a
 * failure: a machine with no pending revision is a machine that is
 * already on the one it should be on.
 */
export function activateStagedPackageSet(
  opts: Pick<PackageSetConvergeOptions, "home" | "platform" | "env"> = {},
): PackageSetConverge | null {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homeOf(env);
  const platform = opts.platform ?? process.platform;
  const state = readPackageSetState(home);
  const staged = state.staged;
  if (staged === null) return null;

  // The directory is the revision. One that is gone — retired by a
  // converge that overtook it, removed by hand — cannot be activated,
  // and saying so is better than pointing `current` at nothing.
  if (!existsSync(staged.path)) {
    const reason = `the staged revision ${formatPackageSetIdentity(staged)} is recorded but its tree is gone`;
    log.err(`red-skills package set refused (tree): ${reason}`);
    const writes = writeState(home, { ...state, staged: null, refused: { failure: "tree", reason } });
    return {
      changed: writes.length > 0,
      writes,
      active: activeIdentity(state),
      retained: state.revisions,
      refused: { failure: "tree", reason },
      staged: null,
      current: redSkillsCurrentLink(home),
      revisionDir: activeRevision(state)?.path ?? null,
    };
  }

  return activate(home, platform, state, staged, () => {}, false);
}

/**
 * Activate a revision this machine already retains, acquiring nothing.
 *
 * The rollback's half of the move `activateStagedPackageSet` makes
 * forwards, and it exists for the same reason: the revision was verified
 * when it arrived, its tree is still under its immutable name, and the
 * one step left is moving `current`. A rollback that re-acquired the
 * revision it is rolling back to would need the network — which is the
 * one thing the machine being rolled back may not have.
 *
 * `null` when this machine retains no such revision, which the caller
 * has to distinguish from a refusal: nothing to roll back to is not the
 * same fact as a rollback that could not be performed.
 */
export function activateRetainedPackageSet(
  key: string,
  opts: Pick<PackageSetConvergeOptions, "home" | "platform" | "env"> = {},
): PackageSetConverge | null {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homeOf(env);
  const platform = opts.platform ?? process.platform;
  const state = readPackageSetState(home);
  const revision = state.revisions.find((r) => r.key === key) ?? null;
  if (revision === null) return null;

  // Recorded and gone: the same failure a staged revision has, and the
  // same answer. Pointing `current` at a directory that is not there
  // would break the machine in the act of repairing it.
  if (!existsSync(revision.path)) {
    const reason = `the retained revision ${formatPackageSetIdentity(revision)} is recorded but its tree is gone`;
    log.err(`red-skills package set refused (tree): ${reason}`);
    const writes = recordRefusal(home, state, { failure: "tree", reason });
    return {
      changed: writes.length > 0,
      writes,
      active: activeIdentity(state),
      retained: state.revisions,
      refused: { failure: "tree", reason },
      staged: identityOf(state.staged),
      current: redSkillsCurrentLink(home),
      revisionDir: activeRevision(state)?.path ?? null,
    };
  }

  return activate(home, platform, state, revision, () => {}, false);
}

/**
 * Point the machine at one verified revision, writing only what differs.
 *
 * Every write is recorded and every one of them is conditional. That is
 * what makes a second converge free: the revision directory is already
 * there, `current` already resolves to it, `previous` already names the
 * rollback and the state file already says so, so there is nothing left
 * to do and nothing is touched.
 */
function activate(
  home: string,
  platform: NodeJS.Platform,
  state: PackageSetState,
  revision: PackageSetRevision,
  materialise: () => void,
  stageOnly: boolean,
): PackageSetConverge {
  const writes: string[] = [];
  const current = redSkillsCurrentLink(home);
  const previous = redSkillsPreviousLink(home);

  // The revision directory, which is an immutable name over immutable
  // contents. One that exists is used as it stands: two converges that
  // agree on the name cannot disagree about what is inside.
  const existed = existsSync(revision.path);
  materialise();
  if (!existed) writes.push(revision.path);

  const retained = [
    { ...revision },
    ...state.revisions.filter((r) => r.key !== revision.key),
  ].slice(0, REDSKILLS_SET_RETENTION);
  const rollback = retained[1] ?? null;

  if (stageOnly) {
    // Staged, and reported as such: the directory is there, the state
    // file does not name it active, and `current` was not touched.
    //
    // The one thing that *is* recorded is which revision was staged.
    // Activation happens in a later process — the run that finds the
    // Workers finished — and it must not have to acquire the revision
    // again to perform it. Written through the same conditional write
    // as everything else, so staging the revision that is already
    // staged is free.
    // A revision that is already active is not staged: the machine is
    // on it, and recording it as pending would make doctor promise an
    // activation that has nothing to activate.
    const pending = revision.key === state.active ? null : { ...revision };
    log.ok(
      pending === null
        ? `red-skills package set ${formatPackageSetIdentity(revision)} is already active`
        : `red-skills package set ${formatPackageSetIdentity(revision)} staged at ${revision.path}`,
    );
    writes.push(...writeState(home, { ...state, staged: pending }));
    return {
      changed: writes.length > 0,
      writes,
      active: activeIdentity(state),
      retained: state.revisions,
      refused: state.refused,
      staged: identityOf(pending),
      current,
      revisionDir: activeRevision(state)?.path ?? null,
    };
  }

  // Only here, and only now: everything above verified, and this is the
  // one path every consumer on the machine reads.
  if (!resolvesTo(current, revision.path)) {
    if (!linkDirectory(revision.path, current, platform)) {
      return {
        changed: writes.length > 0,
        writes,
        active: activeIdentity(state),
        retained: state.revisions,
        refused: state.refused,
        staged: identityOf(state.staged),
        current,
        revisionDir: null,
      };
    }
    writes.push(current);
  }

  if (rollback === null) {
    // Nothing to roll back to. A stale `previous` from an earlier machine
    // state would name a revision this state does not retain.
    if (statOf(previous) !== null) {
      removeLink(previous);
      writes.push(previous);
    }
  } else if (!resolvesTo(previous, rollback.path)) {
    if (linkDirectory(rollback.path, previous, platform)) writes.push(previous);
  }

  // `staged: null`, always. Whatever was pending is either the revision
  // just activated or one this activation has overtaken, and in both
  // cases there is no longer an activation waiting on a Worker.
  const desired: PackageSetState = {
    schema: 1,
    active: revision.key,
    revisions: retained,
    refused: null,
    staged: null,
  };
  writes.push(...writeState(home, desired));
  writes.push(...retire(home, retained));

  if (writes.length > 0) {
    log.ok(
      `red-skills package set ${formatPackageSetIdentity(revision)} (${revision.trust}) — current -> ${revision.path}`,
    );
  }

  return {
    changed: writes.length > 0,
    writes,
    active: { version: revision.version, digest: revision.digest, sourceCommit: revision.sourceCommit },
    retained,
    refused: null,
    staged: null,
    current,
    revisionDir: revision.path,
  };
}

/** The identity of a recorded revision, or null. PURE. */
function identityOf(revision: PackageSetRevision | null): PackageSetIdentity | null {
  return revision === null
    ? null
    : { version: revision.version, digest: revision.digest, sourceCommit: revision.sourceCommit };
}

/** Write the state file, if it differs. Returns the paths written. */
function writeState(home: string, state: PackageSetState): string[] {
  const desired = `${JSON.stringify(state, null, 2)}\n`;
  const path = packageSetStatePath(home);
  if (readIfPresent(path)?.toString("utf8") === desired) return [];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, desired, "utf8");
  return [path];
}

/** Record why a candidate was refused, without touching anything else. */
function recordRefusal(home: string, state: PackageSetState, refusal: PackageSetRefusal): string[] {
  return writeState(home, { ...state, refused: refusal });
}

/**
 * The same record, for a refusal that happened before a candidate ever
 * reached the converge.
 *
 * The acquisition refuses earlier than this module can: assets that
 * belong to another commit, a release with no signature beside its
 * manifest, a remote that could not be read. Those are the answer to
 * the same question doctor asks — "why is this machine not on the
 * revision it was told to be on" — so they are written to the same
 * field rather than to a log line that scrolls away.
 */
export function recordPackageSetRefusal(home: string, refusal: PackageSetRefusal): string[] {
  return recordRefusal(home, readPackageSetState(home), refusal);
}

/**
 * Drop the revision directories past the retention, and nothing else.
 *
 * Only directories named like a revision under `sets/`, plus a staging
 * directory an interrupted converge left behind. `versions/` belongs to
 * the standalone installer and the retention module; the one thing
 * touched there is a dangling link the old layout left pointing into a
 * mise tree that has since been pruned.
 */
function retire(home: string, retained: readonly PackageSetRevision[]): string[] {
  const keep = new Set(retained.map((r) => realpathOrSelf(r.path)));
  const removed: string[] = [];
  const sets = join(redSkillsRoot(home), "sets");
  for (const name of listing(sets)) {
    const path = join(sets, name);
    if (keep.has(realpathOrSelf(path))) continue;
    if (!REVISION_KEY.test(name) && !name.startsWith(".tmp-")) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  const versions = join(redSkillsRoot(home), "versions");
  for (const name of listing(versions)) {
    const path = join(versions, name);
    const stat = statOf(path);
    if (!stat?.isSymbolicLink() || existsSync(path)) continue;
    removeLink(path);
    removed.push(path);
  }
  return removed;
}

/**
 * Give the active set the artifacts it was activated without.
 *
 * A machine already on a revision never reaches activation — the
 * acquisition short-circuits on the commit, which is right and is what
 * makes an up-to-date machine cost one `ls-remote`. But a set copied
 * before activation carried `artifacts/` has no extension to install
 * from, and would keep not having one for as long as it stayed on that
 * revision: the machine is *correct* and permanently unable to do one
 * thing, which is the worst shape a bug can take.
 *
 * So the short-cut repairs before it returns. Nothing else is touched,
 * and a set that already has its artifacts is not written to at all —
 * this answers null on every run but the first.
 */
export function healSetArtifacts(home: string, commit: string): string | null {
  const state = readPackageSetState(home);
  const active = state.revisions.find((r) => r.key === state.active);
  if (!active || active.kind !== "manifest") return null;

  const into = setArtifactsDir(active.path);
  if (existsSync(into)) return null;

  const from = setArtifactsDir(join(redSkillsRoot(home), "candidates", commit));
  if (!existsSync(from)) return null;

  try {
    cpSync(from, into, { recursive: true, dereference: true });
  } catch {
    // A set that cannot be repaired is the set it already was.
    return null;
  }
  return into;
}

/** Copy one tree into an immutable directory, atomically by name. */
function copyTree(from: string, to: string): void {
  if (existsSync(to)) return;
  const staging = join(dirname(to), `.tmp-${basename(to)}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, staging, { recursive: true, dereference: true });
  restoreScriptModes(staging);
  renameSync(staging, to);
}

/**
 * A published set is its tree *and* the artifacts that never enter it.
 *
 * ADR 0011 calls a package set "a self-contained copy with one
 * identity", and this is where that stopped being true: activation took
 * the tree and left `artifacts/` behind in the candidate. Everything the
 * hosts need lives in the tree, so nothing complained — but the VS Code
 * extension does not. The `.vsix` is deliberately kept out of the tree
 * (`overlaysIntoTree`), the companion looks for it under the active
 * set, and the two halves have therefore never met: the extension could
 * not install from a published set on any machine.
 *
 * Copied under the tree as `artifacts/`, which is where
 * `setArtifactsDir` already says a set keeps them, so the set a
 * companion is handed answers for its own contents.
 */
function copySet(tree: string, artifacts: string, to: string): void {
  if (existsSync(to)) {
    // The set is already here, from before activation carried artifacts
    // across. Repaired in place rather than left broken until the next
    // release: without this the fix helps only machines that have yet
    // to acquire the revision, and every machine already on one stays
    // unable to install the extension for as long as it stays there.
    //
    // Adding the directory does not touch the tree, and a published
    // set's identity is its manifest's digest over the declared
    // artifacts — not a digest of this directory — so the revision this
    // names is the same revision afterwards.
    const into = setArtifactsDir(to);
    if (!existsSync(into) && existsSync(artifacts)) {
      cpSync(artifacts, into, { recursive: true, dereference: true });
    }
    return;
  }
  const staging = join(dirname(to), `.tmp-${basename(to)}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(tree, staging, { recursive: true, dereference: true });
  if (existsSync(artifacts)) {
    cpSync(artifacts, setArtifactsDir(staging), { recursive: true, dereference: true });
  }
  restoreScriptModes(staging);
  renameSync(staging, to);
}

// --------------------------------------------------------------- the report

export interface SetDoctorReport {
  active: {
    version: string;
    digest: string;
    sourceCommit: string;
    kind: "composed" | "manifest" | "checkout";
    trust: "trusted" | "unsigned";
    path: string;
  } | null;
  /** Newest first: the active revision and the one a rollback restores. */
  retained: (PackageSetRevision & {
    /** False when the revision is recorded and its tree is no longer there. */
    addressable: boolean;
  })[];
  refused: PackageSetRefusal | null;
  /**
   * A complete revision on disk that `current` does not name yet.
   *
   * Non-null is the whole visible half of the Workers rule: the update
   * ran, the revision verified, and the machine deliberately stayed
   * where it was. `addressable` is false when the tree behind the
   * record is gone, which is the one way a pending activation can
   * become a thing that will never happen.
   */
  staged: (PackageSetRevision & { addressable: boolean }) | null;
}

/**
 * What doctor says about the package set, as data.
 *
 * A JSON report rather than lines, because the facts a person needs
 * when two machines disagree — which digest, from which commit, trusted
 * by whom, with what to roll back to, and why the last candidate was
 * turned away — are also the facts a script needs, and rendering them
 * twice is how the two answers start to differ.
 */
export function redSkillsSetReport(home: string): SetDoctorReport {
  const state = readPackageSetState(home);
  const active = activeRevision(state);
  return {
    active: active
      ? {
          version: active.version,
          digest: active.digest,
          sourceCommit: active.sourceCommit,
          kind: active.kind,
          trust: active.trust,
          path: active.path,
        }
      : null,
    retained: state.revisions.map((r) => ({ ...r, addressable: existsSync(r.path) })),
    refused: state.refused,
    staged: state.staged ? { ...state.staged, addressable: existsSync(state.staged.path) } : null,
  };
}

export interface SetDoctorRow {
  status: "ok" | "warn" | "err" | "n/a";
  detail: string;
}

/** How each kind of revision is named in a report. PURE. */
const SET_KIND_LABEL: Record<PackageSetRevision["kind"], string> = {
  composed: "composed from mise",
  manifest: "published set",
  checkout: "development checkout",
};

/** The report as the lines `red-dev doctor` prints. PURE. */
export function redSkillsSetRows(report: SetDoctorReport): SetDoctorRow[] {
  const rows: SetDoctorRow[] = [];
  if (report.active === null) {
    rows.push({ status: "n/a", detail: "no RedSkills package set is active on this machine" });
  } else {
    const a = report.active;
    rows.push({
      status: a.trust === "trusted" ? "ok" : "warn",
      detail:
        `${formatPackageSetIdentity(a)} — ${SET_KIND_LABEL[a.kind]}, ` +
        (a.trust === "trusted"
          ? "signature verified over the declared artifacts"
          : a.kind === "checkout"
            ? "unsigned (a development checkout is not a release, and `red-dev red-skills sync` advances it)"
            : "unsigned (nothing published signs a composed set yet)"),
    });
    const rollback = report.retained[1];
    if (!rollback) {
      rows.push({ status: "n/a", detail: "no previous revision to roll back to yet" });
    } else {
      rows.push({
        status: rollback.addressable ? "ok" : "warn",
        detail: rollback.addressable
          ? `rollback available: ${formatPackageSetIdentity(rollback)}`
          : `rollback revision ${formatPackageSetIdentity(rollback)} is recorded but gone`,
      });
    }
  }
  if (report.staged) {
    // A warning rather than an error: nothing is wrong with a machine
    // that held an activation back, but "staged" is not "installed" and
    // a report that said `ok` would read as the latter.
    rows.push({
      status: report.staged.addressable ? "warn" : "err",
      detail: report.staged.addressable
        ? `${formatPackageSetIdentity(report.staged)} is staged and pending — ` +
          "activated by the next converge that finds no Worker running"
        : `staged revision ${formatPackageSetIdentity(report.staged)} is recorded but its tree is gone`,
    });
  }
  if (report.refused) {
    // A `downgrade` refusal is the machine working, not failing: an
    // unsigned composed set is being kept away from a verified one. It
    // reported as `err` beside real problems, so a correct machine
    // showed a red line on every doctor — and a doctor that cries about
    // the thing it is supposed to do is a doctor people stop reading.
    //
    // Every other refusal keeps `err`. A signature that did not verify,
    // a tree that would not extract, a manifest whose schema this build
    // cannot read: those are conditions somebody has to act on.
    const declined = report.refused.failure === "downgrade";
    rows.push({
      status: declined ? "n/a" : "err",
      detail: declined
        ? `held back the last candidate: ${report.refused.reason}`
        : `last candidate refused (${report.refused.failure}): ${report.refused.reason}`,
    });
  }
  return rows;
}

// -------------------------------------------------------------- the helpers

function activeRevision(state: PackageSetState): PackageSetRevision | null {
  return state.revisions.find((r) => r.key === state.active) ?? null;
}

function activeIdentity(state: PackageSetState): PackageSetIdentity | null {
  const active = activeRevision(state);
  return active
    ? { version: active.version, digest: active.digest, sourceCommit: active.sourceCommit }
    : null;
}

/** The version a tree's package.json declares, or null. */
function versionOfTree(tree: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(tree, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && SET_VERSION.test(parsed.version) ? parsed.version : null;
  } catch {
    return null;
  }
}

/** A Platform-shaped answer from a bare node platform string. */
function platformOf(platform: NodeJS.Platform): Platform {
  return {
    os: platform === "win32" ? "windows" : "linux",
    distro: null,
    version: null,
    codename: null,
    env: platform === "win32" ? "windows" : "desktop",
    arch: process.arch === "arm64" ? "arm64" : "x64",
    caps: { apt: false, gui: false, systemd: false, winget: false, flatpak: false },
  } as Platform;
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

function readIfPresent(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function readlinkOf(path: string): string {
  try {
    return readlinkSync(path);
  } catch {
    return path;
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function listing(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
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
 *
 * On POSIX the swap is a new link renamed over the old one, so no
 * reader ever sees `current` absent. A junction cannot be renamed over
 * another, so Windows removes and recreates.
 */
function linkDirectory(target: string, path: string, platform: NodeJS.Platform): boolean {
  const existing = statOf(path);
  if (existing && existing.isDirectory() && !existing.isSymbolicLink()) {
    log.warn(`red-skills: ${path} is a real directory, not a link — leaving it alone`);
    return false;
  }

  mkdirSync(dirname(path), { recursive: true });
  if (platform === "win32") {
    if (existing) removeLink(path);
    symlinkSync(target, path, directoryLinkType(platform));
    return true;
  }
  const staging = join(dirname(path), `.${basename(path)}.tmp`);
  rmSync(staging, { force: true });
  symlinkSync(target, staging, directoryLinkType(platform));
  renameSync(staging, path);
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
