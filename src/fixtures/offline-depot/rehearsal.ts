/**
 * The connected machine an offline depot is rehearsed from.
 *
 * Every input a real export takes from the network is a table or a
 * temporary directory here, and nothing else about the export changes:
 * `exportDepot` runs its own refusals, hashes its own artifacts and signs
 * its own manifest over these bytes exactly as it would over a publisher's.
 * That is what makes the rehearsal evidence rather than decoration — the
 * one thing substituted is the thing that needs a network.
 *
 * Two substitutions, and both are named rather than hidden:
 *
 *   - the **artifacts** are the fixture lock's, so an artifact's bytes are
 *     literally the string its checksum was derived from
 *     (`src/fixtures/workstation-lock/releases.ts`). A lock resolved from
 *     that table with `origin: "resolved"` is installable, which is what
 *     lets the whole import path run; a lock resolved with `origin:
 *     "fixture"` is not, which is what `exportDepot` is asserted to refuse.
 *   - the **signature** is a digest binding rather than cosign keyless.
 *     The production verifier is `cosignVerifier` with the vendored
 *     Sigstore trust root and `--offline`, which needs a real key and a
 *     real bundle; the rehearsal signer binds the bundle to the manifest
 *     bytes, so tampering with the manifest still fails verification and
 *     the gate is exercised rather than stubbed out.
 *
 * The package set is a manifest set on disk in the layout
 * `src/red-skills-set.ts` verifies, carrying the artifact names RedSkills
 * v3.20.0 publishes: the four plugin payloads, the marketplace manifests,
 * the generators, the extension, the herdr plugin and the dashboards.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "../../checksum.ts";
import {
  createPackageSetManifest,
  encodePackageSet,
  SET_BUNDLE_NAME,
  SET_MANIFEST_NAME,
  type SignatureVerifier,
} from "../../red-skills-set.ts";
import type { DepotFetcher, DepotSigner } from "../../offline-depot.ts";
import {
  resolveWorkstationLock,
  workstationTarget,
  type LockOrigin,
  type LockedApp,
  type ObservedTarget,
  type WorkstationLock,
} from "../../workstation-lock.ts";
import { fixtureResolverAt } from "../workstation-lock/releases.ts";

/** The one target Spec #201's first depot provisions. */
export const UBUNTU = "ubuntu-24.04-x64";

/** The RedSkills release the depot carries. */
export const REHEARSAL_SET_VERSION = "3.20.0";

/** The commit that release was built from, as the manifest declares it. */
export const REHEARSAL_SET_COMMIT = "626a28473edeee992fcf6425dedbca84448343fd";

/**
 * The complete workstation package set, by artifact name.
 *
 * The set v3.20.0 ships: the four plugin payloads, the marketplace
 * manifests every host registers from, the three generators that build a
 * host's own wiring, the two host bundles, the extension, the herdr
 * plugin and the zellij dashboard. Their contents are one line each —
 * the depot verifies bytes, and a rehearsal that carried twenty-five
 * megabytes would verify the same bytes more slowly.
 */
export const REHEARSAL_SET_ARTIFACTS: Record<string, string> = setArtifacts(REHEARSAL_SET_VERSION);

/**
 * The same table, for one release of the set. PURE.
 *
 * A rollback needs two package sets that differ, and the honest way for
 * two releases of one set to differ is the version they carry: the
 * extension's `.vsix` is named after it, `tree/package.json` declares it,
 * and the whole-set digest is taken over both. So a generation is the
 * version, and everything else about the layout is deliberately the same.
 */
export function setArtifacts(version: string): Record<string, string> {
  return {
    "plugin-dev.payload.tgz": "// dev payload\n",
    "plugin-memory.payload.tgz": "// memory payload\n",
    "plugin-brain.payload.tgz": "// brain payload\n",
    "plugin-internal.payload.tgz": "// internal payload\n",
    "marketplace-manifests.tgz": "// marketplace manifests\n",
    "build-gemini-extension.mjs": "// gemini extension generator\n",
    "install-hermes-skills.mjs": "// hermes skills generator\n",
    "expand-package-set.mjs": "// package set expander\n",
    "workstation-package-set.mjs": "// workstation package set\n",
    "opencode-host.generated.tgz": "// opencode host\n",
    "gemini-extension.tgz": "// gemini extension\n",
    "zellij-dashboard.tgz": "// zellij dashboard\n",
    "herdr-plugin.tgz": "// herdr plugin\n",
    "dev.bundle.min.mjs": "// dev bundle\n",
    [`vscode-extension-red-skills-${version}.vsix`]: `// vsix ${version}\n`,
  };
}

/**
 * A verified manifest set at `dest`, in the layout the verifier reads.
 *
 * Manifest, signature bundle, `artifacts/` and the `tree/` that gets
 * activated — the same four things `verifyPackageSet` walks, so the
 * export's "this set verifies here" gate is a real gate.
 *
 * `release` names which one: a rollback rehearsal builds two or three of
 * these and needs them to be genuinely different sets, which they are —
 * the version reaches the manifest's artifacts, the tree's package.json
 * and therefore the whole-set digest the identity is taken from.
 */
export function rehearsalPackageSet(dest: string, release: SetRelease = {}): string {
  const version = release.version ?? REHEARSAL_SET_VERSION;
  const commit = release.commit ?? REHEARSAL_SET_COMMIT;
  mkdirSync(join(dest, "artifacts"), { recursive: true });
  const declared = Object.entries(setArtifacts(version)).map(([name, bytes]) => {
    writeFileSync(join(dest, "artifacts", name), bytes);
    return { name, size: Buffer.byteLength(bytes), sha256: sha256Hex(bytes) };
  });
  const manifest = createPackageSetManifest(commit, declared);
  writeFileSync(join(dest, SET_MANIFEST_NAME), encodePackageSet(manifest));
  writeFileSync(
    join(dest, SET_BUNDLE_NAME),
    signatureBundle(readFileSync(join(dest, SET_MANIFEST_NAME))),
  );

  const tree = join(dest, "tree");
  mkdirSync(join(tree, "bin"), { recursive: true });
  mkdirSync(join(tree, "plugins", "dev", "skills"), { recursive: true });
  mkdirSync(join(tree, "scripts"), { recursive: true });
  mkdirSync(join(tree, ".red"), { recursive: true });
  writeFileSync(
    join(tree, "package.json"),
    `${JSON.stringify({ name: "@reddb-io/red-skills", version })}\n`,
  );
  writeFileSync(join(tree, "bin", "red-skills-redskilled.mjs"), "// redskilled\n");
  writeFileSync(join(tree, "plugins", "dev", "skills", "SKILL.md"), "# dev\n");
  writeFileSync(join(tree, "scripts", "install-opencode.sh"), "#!/bin/bash\n", { mode: 0o644 });
  return dest;
}

/** Which release of the set to build. Defaults to the one the depot carries. */
export interface SetRelease {
  version?: string;
  commit?: string;
}

/** The exact bytes the lock's checksum for one application was taken over. */
export function rehearsalArtifact(app: LockedApp): string {
  return `fixture:${app.id}@${app.version}:${app.artifact.name}`;
}

/**
 * What a connected machine would have fetched, without fetching.
 *
 * Returns the bytes whose sha256 is the checksum the resolver wrote down,
 * so `exportDepot`'s per-artifact comparison is a real comparison — hand
 * it an application the table does not describe and the export refuses.
 */
export const rehearsalFetcher: DepotFetcher = async (app) => rehearsalArtifact(app);

/** The bundle bytes that bind a signature to one manifest's contents. */
export function signatureBundle(manifest: Uint8Array | string): string {
  return `${JSON.stringify({ schema: 1, sha256: sha256Hex(manifest) }, null, 2)}\n`;
}

/** The rehearsal's stand-in for cosign's signer. */
export const rehearsalSigner: DepotSigner = (manifestPath) => ({
  ok: true,
  bundle: signatureBundle(readFileSync(manifestPath)),
});

/**
 * The rehearsal's stand-in for `cosignVerifier`.
 *
 * Recomputes the binding, so a manifest edited after signing fails here
 * exactly as it would fail a real keyless verification — which is the
 * property the import's ordering depends on.
 */
export const rehearsalVerifier: SignatureVerifier = (manifestPath, bundlePath) => {
  let bundle: unknown;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  } catch {
    return { ok: false, reason: "signature bundle is not valid JSON" };
  }
  const expected = sha256Hex(readFileSync(manifestPath));
  if (
    bundle === null ||
    typeof bundle !== "object" ||
    (bundle as { sha256?: unknown }).sha256 !== expected
  ) {
    return { ok: false, reason: "signature does not cover these manifest bytes" };
  }
  return { ok: true, by: "red-dev depot rehearsal" };
};

/**
 * A lock for the Ubuntu target, resolved through the fixture table.
 *
 * `generation` is how many revisions back to resolve: 0 is the current
 * table, and anything `FIXTURE_RELEASE_HISTORY` names is the workstation
 * as it stood before that. Two generations of one target are what makes a
 * rollback assertable — the versions that moved are named, and the ones
 * that did not are identical in both locks.
 */
export async function rehearsalLock(
  at: string,
  origin: LockOrigin = "resolved",
  generation = 0,
): Promise<WorkstationLock> {
  const target = workstationTarget(UBUNTU);
  if (target === null) throw new Error(`no such target: ${UBUNTU}`);
  const resolved = await resolveWorkstationLock(
    target,
    at,
    fixtureResolverAt(generation),
    origin,
  );
  if (!resolved.ok) throw new Error(`resolution refused: ${resolved.reason}`);
  return resolved.lock;
}

/** A clean Ubuntu 24.04 target: the surfaces, and nothing installed. */
export function cleanUbuntu(): ObservedTarget {
  const target = workstationTarget(UBUNTU);
  if (target === null) throw new Error(`no such target: ${UBUNTU}`);
  return {
    id: target.id,
    surfaces: target.surfaces.map((s) => s.id),
    installed: [],
    authenticated: [],
  };
}
