/**
 * The releases the lock fixtures were written from.
 *
 * A resolution on a connected machine asks a registry per application;
 * this asks a table, so the same code path produces the same bytes every
 * time it runs and the two committed locks beside this file can be
 * asserted rather than eyeballed. That is the whole point of a fixture
 * lock: `resolveWorkstationLock` is exercised end to end with nothing
 * mocked except the one thing that needs a network.
 *
 * The versions are plausible and the checksums are not real — they are
 * `sha256("fixture:<id>@<version>:<artifact>")`, which is why the locks
 * generated from this table carry `origin: "fixture"` and are refused by
 * `installFromLock`. A digest nobody computed from published bytes must
 * never be able to authorise an installation, and the way to guarantee
 * that is for the fixture to be unable to lie about where it came from.
 *
 * Artifact names follow each publisher's own convention, because the
 * source URLs in the lock are built from them: npm's tarball naming,
 * GitHub's release asset names, Debian's `name_version_arch.deb`.
 */

import { sha256Hex } from "../../checksum.ts";
import type {
  LockSurface,
  ReleaseResolver,
  ResolvedRelease,
  WorkstationApp,
} from "../../workstation-lock.ts";

/** One row: the version, and the artifact name on each kind of surface. */
export interface FixtureRelease {
  version: string;
  /** The artifact a surface takes. Windows differs wherever the shape does. */
  artifact: (surface: LockSurface) => string;
}

const same = (name: string) => () => name;

export const FIXTURE_RELEASES: Record<string, FixtureRelease> = {
  "claude-code": {
    version: "2.0.36",
    artifact: same("claude-code-2.0.36-linux-x64.tar.gz"),
  },
  codex: { version: "0.55.0", artifact: same("codex-0.55.0.tgz") },
  gemini: { version: "0.14.2", artifact: same("gemini-cli-0.14.2.tgz") },
  herdr: { version: "0.9.4", artifact: same("herdr-0.9.4-linux-x64.tar.gz") },
  hermes: { version: "1.2.0", artifact: same("hermes-1.2.0-linux-x64.tar.gz") },
  mise: {
    version: "2026.8.3",
    artifact: (surface) =>
      surface.os === "windows" ? "mise-v2026.8.3-windows-x64.zip" : "mise_2026.8.3_amd64.deb",
  },
  node: { version: "24.7.0", artifact: same("node-v24.7.0-linux-x64.tar.xz") },
  opencode: { version: "1.18.18", artifact: same("opencode-ai-1.18.18.tgz") },
  pi: { version: "0.65.3", artifact: same("pi-coding-agent-0.65.3.tgz") },
  python: { version: "3.13.5", artifact: same("Python-3.13.5.tar.xz") },
  "red-dev": {
    version: "1.0.56",
    artifact: (surface) =>
      surface.os === "windows" ? "red-dev-windows-x64.exe" : "red-dev-linux-x64",
  },
  redcode: { version: "1.4.2", artifact: same("redcode-linux-x64.tar.gz") },
  vscode: {
    version: "1.104.2",
    artifact: (surface) =>
      surface.os === "windows" ? "VSCodeSetup-x64-1.104.2.exe" : "code_1.104.2-1_amd64.deb",
  },
  zellij: {
    version: "0.44.3-red.2",
    artifact: same("zellij-x86_64-unknown-linux-musl.tar.gz"),
  },
};

/** The checksum a fixture artifact has, derived from what it names. PURE. */
export function fixtureChecksum(id: string, version: string, artifact: string): string {
  return sha256Hex(`fixture:${id}@${version}:${artifact}`);
}

/**
 * What the revisions before the current one shipped, where they differ.
 *
 * A rollback needs more than one lock to be a rollback at all, and the
 * honest shape of "the revision before this one" is not a whole second
 * table: real workstations move a handful of applications at a time and
 * leave the rest exactly where they were. So a generation is an override
 * over the table above — generation 0 is it — and everything a
 * generation does not name is deliberately identical, which is what
 * makes a restored version worth asserting: the ones that moved moved
 * back, and the ones that did not were not touched.
 *
 * The artifact names follow the versions, because a publisher's asset
 * name carries the version wherever the publisher puts one in. That is
 * also what keeps the fixture checksums distinct per generation, so a
 * rollback that restored the wrong bytes cannot hash to the right ones.
 */
export const FIXTURE_RELEASE_HISTORY: Record<number, Record<string, string>> = {
  1: {
    "claude-code": "2.0.35",
    codex: "0.54.0",
    "red-dev": "1.0.55",
    vscode: "1.104.1",
    zellij: "0.44.3-red.1",
  },
  2: {
    "claude-code": "2.0.34",
    codex: "0.53.0",
    "red-dev": "1.0.54",
    vscode: "1.103.4",
    zellij: "0.44.2-red.1",
  },
};

/**
 * The release table as it stood `generation` revisions ago. PURE.
 *
 * Generation 0 is `FIXTURE_RELEASES` itself, and an unknown generation
 * is too: a caller asking for a revision nobody wrote down gets the
 * current one rather than a table with holes in it.
 */
export function fixtureReleasesAt(generation: number): Record<string, FixtureRelease> {
  const overrides = FIXTURE_RELEASE_HISTORY[generation] ?? {};
  const out: Record<string, FixtureRelease> = {};
  for (const [id, release] of Object.entries(FIXTURE_RELEASES)) {
    const version = overrides[id];
    out[id] =
      version === undefined
        ? release
        : {
            version,
            // The publisher's own name, with its version moved back. An
            // artifact that carries no version is unchanged, and its
            // checksum still differs because the checksum is taken over
            // the version as well as the name.
            artifact: (surface) => release.artifact(surface).split(release.version).join(version),
          };
  }
  return out;
}

/** A resolver over one generation of the table above. PURE. */
export function fixtureResolverAt(generation: number): ReleaseResolver {
  const table = fixtureReleasesAt(generation);
  return async (app: WorkstationApp, surface: LockSurface): Promise<ResolvedRelease> => {
    const release = table[app.id];
    if (release === undefined) throw new Error(`no fixture release for ${app.id}`);
    const name = release.artifact(surface);
    return {
      version: release.version,
      artifact: { name, sha256: fixtureChecksum(app.id, release.version, name) },
    };
  };
}

/** A resolver over the table above, for tests and depot rehearsals. */
export const fixtureResolver: ReleaseResolver = fixtureResolverAt(0);
