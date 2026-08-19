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
interface FixtureRelease {
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

/** A resolver over the table above, for tests and depot rehearsals. */
export const fixtureResolver: ReleaseResolver = async (
  app: WorkstationApp,
  surface: LockSurface,
): Promise<ResolvedRelease> => {
  const release = FIXTURE_RELEASES[app.id];
  if (release === undefined) throw new Error(`no fixture release for ${app.id}`);
  const name = release.artifact(surface);
  return {
    version: release.version,
    artifact: { name, sha256: fixtureChecksum(app.id, release.version, name) },
  };
};
