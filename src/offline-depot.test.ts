/**
 * What a depot has to refuse, and what it has to survive.
 *
 * A depot is the one input an air-gapped workstation has, carried on a
 * medium nobody can re-fetch from. So the cases here are the ones where
 * being wrong is unrecoverable: a manifest whose digest was computed over
 * something else, an artifact edited on the way, a signature that covers
 * different bytes, a depot for the other target, somebody's `~/.aws`
 * swept into the tarball, and an activation that would switch on the
 * three payloads Spec #201 says must ship dormant.
 *
 * The happy paths are asserted from the same side an operator sees: the
 * export writes a depot that parses, every entry it declares is on disk
 * with the declared bytes, and a second import over an already-provisioned
 * machine writes nothing at all.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sha256Hex } from "./checksum.ts";

import {
  cleanUbuntu,
  rehearsalArtifact,
  rehearsalFetcher,
  rehearsalLock,
  rehearsalPackageSet,
  rehearsalSigner,
  rehearsalVerifier,
  signatureBundle,
  UBUNTU,
} from "./fixtures/offline-depot/rehearsal.ts";
import {
  auditOfflineDepot,
  depotAppPath,
  DEPOT_BUNDLE_NAME,
  DEPOT_LOCK_NAME,
  DEPOT_MANIFEST_NAME,
  DEPOT_SET_DIR,
  encodeOfflineDepot,
  exportDepot,
  importDepot,
  importedDepotDir,
  isDepotPath,
  offlineDepotDigest,
  offlineDepotReport,
  offlineDepotRows,
  offlineDepotStatePath,
  OFFLINE_DEPOT_SCHEMA,
  parseOfflineDepot,
  scanForCredentials,
  type DepotInstaller,
  type OfflineDepot,
} from "./offline-depot.ts";
import { SET_MANIFEST_NAME } from "./red-skills-set.ts";
import { encodeWorkstationLock, workstationTarget, type ObservedTarget } from "./workstation-lock.ts";

const AT = "2026-08-19T00:00:00Z";

function scratch(name: string): string {
  return mkdtempSync(join(tmpdir(), `red-depot-${name}-`));
}

/** A connected machine's inputs: a verified set and a resolved lock. */
async function connected(): Promise<{ setDir: string; dest: string; lock: Awaited<ReturnType<typeof rehearsalLock>> }> {
  const root = scratch("export");
  return {
    setDir: rehearsalPackageSet(join(root, "set")),
    dest: join(root, "depot"),
    lock: await rehearsalLock(AT),
  };
}

/** The whole export, as the rehearsal runs it. */
async function exportRehearsal(): Promise<{ dir: string; depot: OfflineDepot }> {
  const { setDir, dest, lock } = await connected();
  const exported = await exportDepot({
    lock,
    setDir,
    dest,
    exportedAt: AT,
    fetch: rehearsalFetcher,
    verifier: rehearsalVerifier,
    sign: rehearsalSigner,
  });
  if (!exported.ok) throw new Error(`export refused: ${exported.reason}`);
  return { dir: exported.report.dir, depot: exported.report.depot };
}

/** An installer that records what it was handed and writes a receipt. */
function recordingInstaller(root: string): {
  install: DepotInstaller;
  seen: { app: string; surface: string; version: string; from: string; bytes: string }[];
} {
  const seen: { app: string; surface: string; version: string; from: string; bytes: string }[] = [];
  const install: DepotInstaller = async (step, artifact) => {
    seen.push({
      app: step.app.id,
      surface: step.app.surface,
      version: step.app.version,
      from: artifact.path,
      bytes: artifact.bytes.toString("utf8"),
    });
    const receipt = join(root, step.app.surface, `${step.app.id}.installed`);
    mkdirSync(join(root, step.app.surface), { recursive: true });
    writeFileSync(receipt, `${step.app.version}\n`);
    return { ok: true };
  };
  return { install, seen };
}

/** The same machine once the lock's applications are all at their versions. */
function provisioned(lock: Awaited<ReturnType<typeof rehearsalLock>>): ObservedTarget {
  return {
    ...cleanUbuntu(),
    installed: lock.apps.map((app) => ({ id: app.id, surface: app.surface, version: app.version })),
  };
}

// ------------------------------------------------------------ the manifest

describe("the depot manifest", () => {
  test("the digest covers every field, and the encoding is the one on disk", async () => {
    const { dir, depot } = await exportRehearsal();
    expect(depot.schema).toBe(OFFLINE_DEPOT_SCHEMA);
    expect(auditOfflineDepot(depot)).toEqual([]);
    expect(readFileSync(join(dir, DEPOT_MANIFEST_NAME), "utf8")).toBe(encodeOfflineDepot(depot));

    const moved: OfflineDepot = { ...depot, exportedAt: "2026-08-20T00:00:00Z" };
    expect(offlineDepotDigest(moved)).not.toBe(depot.depotDigest);
    expect(auditOfflineDepot(moved)).toContain("depot digest does not match the depot contents");
  });

  test("it parses back, and refuses bytes that are not the canonical encoding", async () => {
    const { depot } = await exportRehearsal();
    const parsed = parseOfflineDepot(encodeOfflineDepot(depot));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.depot).toEqual(depot);

    const compact = parseOfflineDepot(`${JSON.stringify(depot)}\n`);
    expect(compact.ok).toBe(false);
    if (!compact.ok) expect(compact.reason).toBe("depot manifest bytes are not the canonical encoding");
  });

  test("an entry path that escapes the depot is not a path", () => {
    expect(isDepotPath("apps/ubuntu-24.04-x64/codex-0.55.0.tgz")).toBe(true);
    for (const bad of ["", "/etc/passwd", "../secrets", "apps/../../x", "C:/x", "apps\\x", "apps//x"]) {
      expect(isDepotPath(bad)).toBe(false);
    }
  });

  test("a depot that would switch on more than dev is refused", async () => {
    const { depot } = await exportRehearsal();
    for (const activated of [[], ["dev", "memory"], ["memory"]]) {
      const wrong = { ...depot, activated };
      expect(auditOfflineDepot({ ...wrong, depotDigest: offlineDepotDigest(wrong) })).toContain(
        `depot activates ${activated.join(", ") || "nothing"}, not dev`,
      );
    }
  });

  test("a depot missing its lock, its set manifest or its applications is refused", async () => {
    const { depot } = await exportRehearsal();
    const without = (drop: (path: string) => boolean, reason: string) => {
      const entries = depot.entries.filter((e) => !drop(e.path));
      const trimmed = { ...depot, entries };
      expect(auditOfflineDepot({ ...trimmed, depotDigest: offlineDepotDigest(trimmed) })).toContain(reason);
    };
    without((p) => p === DEPOT_LOCK_NAME, `depot carries no ${DEPOT_LOCK_NAME}`);
    without(
      (p) => p === `${DEPOT_SET_DIR}/${SET_MANIFEST_NAME}`,
      `depot carries no ${DEPOT_SET_DIR}/${SET_MANIFEST_NAME}`,
    );
    without((p) => p.startsWith("apps/"), "depot carries no application artifacts");
  });
});

// ---------------------------------------------------------- the credentials

describe("the credential scan", () => {
  test("a depot the export produced carries nothing recognisable", async () => {
    const { dir } = await exportRehearsal();
    expect(scanForCredentials(dir)).toEqual([]);
  });

  test("credential stores are found by where they are, tokens by what they look like", () => {
    const root = scratch("creds");
    const write = (rel: string, bytes: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), bytes);
    };
    mkdirSync(join(root, "home", ".aws"), { recursive: true });
    mkdirSync(join(root, "home", ".ssh"), { recursive: true });
    write("home/.aws/credentials", "[default]\n");
    write("home/.ssh/id_ed25519", "not really a key\n");
    write("home/.npmrc", "registry=https://registry.npmjs.org/\n");
    write("notes.txt", "the token is ghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
    write("deploy.yaml", "key: |\n  -----BEGIN RSA PRIVATE KEY-----\n");
    write("readme.md", "nothing to see here\n");

    const found = scanForCredentials(root);
    expect(found.map((f) => `${f.path} ${f.kind}`).sort()).toEqual([
      "deploy.yaml private-key-block",
      "home/.aws/credentials aws-credentials",
      "home/.npmrc npmrc",
      "home/.ssh/id_ed25519 private-key",
      "notes.txt github-token",
    ]);
    // The finding names the recogniser and the path, never the secret:
    // a report that quoted it would put it in the log and the ticket.
    for (const finding of found) expect(JSON.stringify(finding)).not.toContain("ghp_");
    rmSync(root, { recursive: true, force: true });
  });

  test("binary artifacts are not scanned for tokens", () => {
    const root = scratch("binary");
    writeFileSync(join(root, "artifact.tgz"), Buffer.from([0x1f, 0x8b, 0x00, 0x41, 0x4b, 0x49, 0x41]));
    expect(scanForCredentials(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

// --------------------------------------------------------------- the export

describe("exporting a depot", () => {
  test("it writes the lock, the set and one artifact per locked application", async () => {
    const { dir, depot } = await exportRehearsal();
    const lock = await rehearsalLock(AT);
    expect(depot.target).toEqual(workstationTarget(UBUNTU)!);
    expect(depot.lockDigest).toBe(lock.lockDigest);
    expect(depot.activated).toEqual(["dev"]);
    expect(depot.packageSet.active.version).toBe("3.20.0");
    expect(depot.packageSet.previous).toBeNull();

    for (const app of lock.apps) {
      const entry = depot.entries.find((e) => e.path === depotAppPath(app));
      expect(entry).toBeDefined();
      expect(readFileSync(join(dir, depotAppPath(app)), "utf8")).toBe(rehearsalArtifact(app));
    }
    // Every declared byte is on the medium, exactly as declared.
    for (const entry of depot.entries) {
      expect(readFileSync(join(dir, entry.path)).length).toBe(entry.size);
    }
    expect(readFileSync(join(dir, DEPOT_LOCK_NAME), "utf8")).toBe(encodeWorkstationLock(lock));
  });

  test("a fixture lock is refused: nobody computed its checksums from published bytes", async () => {
    const { setDir, dest } = await connected();
    const exported = await exportDepot({
      lock: await rehearsalLock(AT, "fixture"),
      setDir,
      dest,
      exportedAt: AT,
      fetch: rehearsalFetcher,
      verifier: rehearsalVerifier,
      sign: rehearsalSigner,
    });
    expect(exported.ok).toBe(false);
    if (!exported.ok) expect(exported.reason).toContain("refusing to export a fixture lock");
  });

  test("an artifact that does not hash to the lock stops the export", async () => {
    const { setDir, dest, lock } = await connected();
    const exported = await exportDepot({
      lock,
      setDir,
      dest,
      exportedAt: AT,
      fetch: async (app) => (app.id === "codex" ? "something else entirely" : rehearsalArtifact(app)),
      verifier: rehearsalVerifier,
      sign: rehearsalSigner,
    });
    expect(exported.ok).toBe(false);
    if (!exported.ok) expect(exported.reason).toContain("does not hash to the locked checksum");
  });

  test("an input that cannot be resolved stops the export", async () => {
    const { setDir, dest, lock } = await connected();
    const exported = await exportDepot({
      lock,
      setDir,
      dest,
      exportedAt: AT,
      fetch: async (app) => (app.id === "zellij" ? null : rehearsalArtifact(app)),
      verifier: rehearsalVerifier,
      sign: rehearsalSigner,
    });
    expect(exported.ok).toBe(false);
    if (!exported.ok) expect(exported.reason).toContain("could not be resolved");
  });

  test("a package set that will not verify here cannot be carried away", async () => {
    const { setDir, dest, lock } = await connected();
    const exported = await exportDepot({
      lock,
      setDir,
      dest,
      exportedAt: AT,
      fetch: rehearsalFetcher,
      verifier: () => ({ ok: false, reason: "no such signer" }),
      sign: rehearsalSigner,
    });
    expect(exported.ok).toBe(false);
    if (!exported.ok) expect(exported.reason).toContain("package set will not verify here");
  });

  test("credential material in the set stops the export, and leaves nothing behind", async () => {
    const { setDir, dest, lock } = await connected();
    mkdirSync(join(setDir, "tree", ".aws"), { recursive: true });
    writeFileSync(join(setDir, "tree", ".aws", "credentials"), "[default]\n");
    const exported = await exportDepot({
      lock,
      setDir,
      dest,
      exportedAt: AT,
      fetch: rehearsalFetcher,
      verifier: rehearsalVerifier,
      sign: rehearsalSigner,
    });
    expect(exported.ok).toBe(false);
    if (!exported.ok) expect(exported.reason).toContain("refusing to export credential material");
    expect(scanForCredentials(dest)).toEqual([]);
  });
});

// --------------------------------------------------------------- the import

describe("importing a depot", () => {
  test("a clean target installs every locked application from depot-local bytes", async () => {
    const { dir } = await exportRehearsal();
    const home = scratch("home");
    const machine = scratch("machine");
    const lock = await rehearsalLock(AT);
    const { install, seen } = recordingInstaller(machine);

    const imported = await importDepot({
      depot: dir,
      home,
      observed: cleanUbuntu(),
      verifier: rehearsalVerifier,
      install,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    expect(imported.report.install.installed).toHaveLength(lock.apps.length);
    expect(imported.report.install.failed).toEqual([]);
    expect(imported.report.ready).toBe(true);
    expect(imported.report.activated).toEqual(["dev"]);
    expect(imported.report.trustedBy).toBe("red-dev depot rehearsal");

    // Machine-owned storage, not the medium: the stick can be unplugged.
    const owned = importedDepotDir(home, imported.report.key);
    expect(imported.report.path).toBe(owned);
    for (const record of seen) expect(record.from.startsWith(owned)).toBe(true);
    for (const app of lock.apps) {
      const record = seen.find((r) => r.app === app.id);
      expect(record?.bytes).toBe(rehearsalArtifact(app));
    }

    // The seven coder CLIs, and the companions beside them.
    const installed = new Set(seen.map((r) => r.app));
    for (const id of ["claude-code", "codex", "gemini", "hermes", "opencode", "pi", "redcode"]) {
      expect(installed.has(id)).toBe(true);
    }
    for (const id of ["mise", "red-dev", "node", "python", "herdr", "zellij", "vscode"]) {
      expect(installed.has(id)).toBe(true);
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(machine, { recursive: true, force: true });
  });

  test("a second import over a provisioned machine writes nothing", async () => {
    const { dir } = await exportRehearsal();
    const home = scratch("home");
    const machine = scratch("machine");
    const lock = await rehearsalLock(AT);

    const first = await importDepot({
      depot: dir,
      home,
      observed: cleanUbuntu(),
      verifier: rehearsalVerifier,
      install: recordingInstaller(machine).install,
    });
    expect(first.ok).toBe(true);

    const again = recordingInstaller(machine);
    const second = await importDepot({
      depot: dir,
      home,
      observed: provisioned(lock),
      verifier: rehearsalVerifier,
      install: again.install,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.report.writes).toEqual([]);
    expect(second.report.converged).toBe(true);
    expect(second.report.install.installed).toEqual([]);
    expect(second.report.install.present).toHaveLength(lock.apps.length);
    expect(again.seen).toEqual([]);
    rmSync(home, { recursive: true, force: true });
    rmSync(machine, { recursive: true, force: true });
  });

  test("a depot for another target is refused as identity, not as corruption", async () => {
    const { dir } = await exportRehearsal();
    const home = scratch("home");
    const elsewhere: ObservedTarget = { ...cleanUbuntu(), id: "windows-11-x64+wsl-ubuntu-24.04" };
    const imported = await importDepot({
      depot: dir,
      home,
      observed: elsewhere,
      verifier: rehearsalVerifier,
      install: recordingInstaller(home).install,
    });
    expect(imported.ok).toBe(false);
    if (!imported.ok) {
      expect(imported.failure).toBe("target");
      expect(imported.reason).toContain("depot provisions ubuntu-24.04-x64");
    }
    rmSync(home, { recursive: true, force: true });
  });

  test("an artifact edited on the medium is refused before anything is installed", async () => {
    const { dir } = await exportRehearsal();
    const home = scratch("home");
    const lock = await rehearsalLock(AT);
    const victim = lock.apps.find((app) => app.id === "claude-code")!;
    writeFileSync(join(dir, depotAppPath(victim)), "tampered\n");

    const { install, seen } = recordingInstaller(home);
    const imported = await importDepot({
      depot: dir,
      home,
      observed: cleanUbuntu(),
      verifier: rehearsalVerifier,
      install,
    });
    expect(imported.ok).toBe(false);
    if (!imported.ok) {
      expect(imported.failure).toBe("entry");
      expect(imported.reason).toContain(depotAppPath(victim));
    }
    expect(seen).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });

  test("a signature that covers other bytes is refused", async () => {
    const { dir } = await exportRehearsal();
    const home = scratch("home");
    writeFileSync(join(dir, DEPOT_BUNDLE_NAME), signatureBundle("some other manifest"));
    const imported = await importDepot({
      depot: dir,
      home,
      observed: cleanUbuntu(),
      verifier: rehearsalVerifier,
      install: recordingInstaller(home).install,
    });
    expect(imported.ok).toBe(false);
    if (!imported.ok) expect(imported.failure).toBe("signature");
    rmSync(home, { recursive: true, force: true });
  });

  test("credential material on the medium is refused before it reaches a second machine", async () => {
    const { dir, depot } = await exportRehearsal();
    const home = scratch("home");
    // Declared, so the entry pass passes and the scan is what stops it.
    const path = "apps/ubuntu-24.04-x64/.netrc";
    writeFileSync(join(dir, path), "machine example.com login me password secret\n");
    const bytes = "machine example.com login me password secret\n";
    const entries = [
      ...depot.entries,
      { path, role: "app" as const, size: Buffer.byteLength(bytes), sha256: sha256Hex(bytes) },
    ].sort((a, b) => a.path.localeCompare(b.path, "en"));
    const restated = { ...depot, entries };
    writeFileSync(
      join(dir, DEPOT_MANIFEST_NAME),
      encodeOfflineDepot({ ...restated, depotDigest: offlineDepotDigest(restated) }),
    );
    writeFileSync(join(dir, DEPOT_BUNDLE_NAME), signatureBundle(readFileSync(join(dir, DEPOT_MANIFEST_NAME))));

    const imported = await importDepot({
      depot: dir,
      home,
      observed: cleanUbuntu(),
      verifier: rehearsalVerifier,
      install: recordingInstaller(home).install,
    });
    expect(imported.ok).toBe(false);
    if (!imported.ok) {
      expect(imported.failure).toBe("credential");
      expect(imported.reason).toContain("netrc");
    }
    rmSync(home, { recursive: true, force: true });
  });

  test("a machine that would activate more than the depot says stops the import", async () => {
    const { dir } = await exportRehearsal();
    const home = scratch("home");
    const imported = await importDepot({
      depot: dir,
      home,
      observed: cleanUbuntu(),
      verifier: rehearsalVerifier,
      install: recordingInstaller(home).install,
      plugins: ["memory", "brain"],
    });
    expect(imported.ok).toBe(false);
    if (!imported.ok) {
      expect(imported.failure).toBe("activation");
      expect(imported.reason).toContain("this machine would activate nothing");
    }
    rmSync(home, { recursive: true, force: true });
  });
});

// --------------------------------------------------------------- the report

describe("what doctor says", () => {
  test("a machine with no depot says so, and is not an error", () => {
    const home = scratch("empty");
    expect(offlineDepotReport(home).imported).toBeNull();
    const rows = offlineDepotRows(offlineDepotReport(home));
    expect(rows).toEqual([
      { status: "n/a", detail: "no offline depot has been imported on this machine" },
    ]);
    rmSync(home, { recursive: true, force: true });
  });

  test("an imported depot reports its trust, its readiness and the accounts still to configure", async () => {
    const { dir } = await exportRehearsal();
    const home = scratch("home");
    await importDepot({
      depot: dir,
      home,
      observed: cleanUbuntu(),
      verifier: rehearsalVerifier,
      install: recordingInstaller(home).install,
    });
    const report = offlineDepotReport(home);
    expect(report.imported?.addressable).toBe(true);
    expect(report.imported?.ready).toBe(true);

    const rows = offlineDepotRows(report);
    expect(rows[0]?.status).toBe("ok");
    expect(rows[0]?.detail).toContain("signed by red-dev depot rehearsal");
    expect(rows[1]?.status).toBe("ok");
    expect(rows[1]?.detail).toContain("dev activated");
    // Every unconfigured account is a line, and none of them is a failure.
    expect(rows.slice(2).every((row) => row.status === "n/a")).toBe(true);
    expect(rows.length).toBeGreaterThan(2);
    expect(readFileSync(offlineDepotStatePath(home), "utf8")).toContain("\"schema\": 1");
    rmSync(home, { recursive: true, force: true });
  });
});
