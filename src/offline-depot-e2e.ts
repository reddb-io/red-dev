/**
 * The Ubuntu 24 offline journey, end to end, in one function.
 *
 * Spec #201's first depot criterion is a sentence about two machines: a
 * connected one exports, a clean network-denied one imports, and the
 * second converge changes nothing. Nothing about that is provable by
 * reading either half on its own — the export looks fine until an import
 * finds an artifact it cannot hash, and the import looks fine until it is
 * run twice. So the journey is one function that both `bun test` and
 * `bun run e2e:offline-ubuntu24` call, and it returns the checks it made
 * rather than printing them, so the two callers cannot disagree about
 * what passed.
 *
 * ## What is real here, and what is rehearsed
 *
 * Real: every line of src/offline-depot.ts, src/workstation-lock.ts and
 * src/red-skills-set.ts that the journey touches. The manifest is built,
 * signed, parsed and digest-checked; every artifact is hashed on the way
 * out and again on the way in; the lock is resolved through
 * `resolveWorkstationLock`, audited, planned and installed; the depot is
 * copied into machine-owned storage and served from there; the credential
 * scan walks the finished medium.
 *
 * Rehearsed, and named rather than hidden: the publisher's bytes come
 * from the fixture table rather than from npm and GitHub, the signature
 * is a digest binding rather than cosign keyless with the vendored trust
 * root, and the installer writes a receipt instead of running `apt` and
 * `mise`. Those three are exactly the parts that need a network, a
 * signing identity or root — which is to say, exactly the parts a
 * hermetic run cannot have. What the journey therefore proves is that the
 * depot contract holds; putting `.deb` files on a real machine is the
 * installer's own journey.
 *
 * ## Egress is denied, and the denial is observed
 *
 * The import half runs with `globalThis.fetch` replaced by a stub that
 * records the attempt and throws. If any code under `importDepot` reached
 * for the network the journey would fail with the URL it asked for,
 * instead of passing on a laptop that happened to be online. This catches
 * JavaScript egress and not a spawned process opening its own socket —
 * a real air-gapped run is the network's job, and the check says which of
 * the two it is.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanUbuntu,
  rehearsalArtifact,
  rehearsalFetcher,
  rehearsalLock,
  rehearsalPackageSet,
  rehearsalSigner,
  rehearsalVerifier,
  UBUNTU,
} from "./fixtures/offline-depot/rehearsal.ts";
import {
  DEPOT_MANIFEST_NAME,
  exportDepot,
  importDepot,
  importedDepotDir,
  offlineDepotReport,
  offlineDepotRows,
  parseOfflineDepot,
  scanForCredentials,
  type DepotInstaller,
} from "./offline-depot.ts";
import { ACTIVATED_PLUGIN } from "./red-skills-plugins.ts";
import {
  REQUIRED_WORKSTATION_APPS,
  type ObservedApp,
  type ObservedTarget,
} from "./workstation-lock.ts";

/** The seven managed coder hosts of ADR 0010, as the lock names them. */
export const CODER_CLIS = [
  "claude-code",
  "codex",
  "gemini",
  "hermes",
  "opencode",
  "pi",
  "redcode",
] as const;

/** The companions a complete workstation carries beside the CLIs. */
export const COMPANIONS = ["herdr", "mise", "node", "python", "red-dev", "vscode", "zellij"] as const;

/** One thing the journey asserted, and whether it held. */
export interface JourneyCheck {
  name: string;
  ok: boolean;
  /** One sentence, always — including when it passed. */
  detail: string;
}

export interface JourneyResult {
  ok: boolean;
  checks: JourneyCheck[];
  /** Kept when `keep` was asked for, so a failure can be looked at. */
  root: string | null;
}

export interface JourneyOptions {
  /** Where the two machines are built. Defaults to a temporary directory. */
  root?: string;
  /** The export instant. Fixed by default: a journey never reads a clock. */
  at?: string;
  /** Leave the directories behind for inspection. */
  keep?: boolean;
}

/**
 * A `fetch` that cannot succeed, and remembers being asked.
 *
 * Installed for the whole import half rather than asserted afterwards,
 * because "nothing reached the network" is only worth checking if
 * reaching for it would have failed — on a connected laptop an
 * unguarded run proves nothing at all.
 */
function denyEgress(): { attempts: string[]; restore: () => void } {
  const attempts: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    attempts.push(url);
    throw new Error(`network egress is blocked on this target: ${url}`);
  }) as unknown as typeof fetch;
  return { attempts, restore: () => { globalThis.fetch = original; } };
}

/**
 * Run the whole journey and report what held.
 *
 * Every check is recorded rather than thrown, so one failure does not
 * hide the six behind it: an operator reading a red run wants the whole
 * shape of what broke, and a journey that stops at the first `expect`
 * makes them re-run it once per fact.
 */
export async function runUbuntu24OfflineJourney(
  opts: JourneyOptions = {},
): Promise<JourneyResult> {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "red-depot-journey-"));
  const at = opts.at ?? "2026-08-19T00:00:00Z";
  const checks: JourneyCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): boolean => {
    checks.push({ name, ok, detail });
    return ok;
  };
  const finish = (): JourneyResult => {
    if (!opts.keep) rmSync(root, { recursive: true, force: true });
    return { ok: checks.every((c) => c.ok), checks, root: opts.keep ? root : null };
  };

  // ---------------------------------------------------- the connected machine
  const setDir = rehearsalPackageSet(join(root, "connected", "package-set"));
  const depotDir = join(root, "medium", "depot");
  const lock = await rehearsalLock(at);

  const exported = await exportDepot({
    lock,
    setDir,
    dest: depotDir,
    exportedAt: at,
    fetch: rehearsalFetcher,
    verifier: rehearsalVerifier,
    sign: rehearsalSigner,
  });
  if (!check("export", exported.ok, exported.ok ? `depot exported for ${lock.target.id}` : exported.reason)) {
    return finish();
  }
  if (!exported.ok) return finish();
  const depot = exported.report.depot;

  const parsed = parseOfflineDepot(readFileSync(join(depotDir, DEPOT_MANIFEST_NAME)));
  check(
    "manifest",
    parsed.ok && parsed.depot.depotDigest === depot.depotDigest,
    parsed.ok
      ? `signed manifest ${depot.depotDigest.slice(0, 12)} names ${depot.entries.length} entries for ${depot.target.id}`
      : parsed.reason,
  );
  check(
    "lock",
    depot.lockDigest === lock.lockDigest && lock.apps.length === REQUIRED_WORKSTATION_APPS.length,
    `the depot's lock digest is ${lock.lockDigest.slice(0, 12)} over ${lock.apps.length} exact versions`,
  );
  const unhashed = depot.entries.filter(
    (entry) => !/^[0-9a-f]{64}$/.test(entry.sha256) || entry.size < 0,
  );
  check(
    "checksums",
    unhashed.length === 0,
    unhashed.length === 0
      ? `every one of ${depot.entries.length} entries carries an exact sha256`
      : `${unhashed.length} entries carry no usable checksum`,
  );

  // ------------------------------------------------- the network-denied target
  const home = join(root, "target", "home");
  const observed = cleanUbuntu();
  const installed: ObservedApp[] = [];
  const fromDepot: string[] = [];

  const install: DepotInstaller = async (step, artifact) => {
    if (artifact.bytes.toString("utf8") !== rehearsalArtifact(step.app)) {
      return { ok: false, detail: "the artifact is not the one the lock names" };
    }
    fromDepot.push(artifact.path);
    installed.push({ id: step.app.id, surface: step.app.surface, version: step.app.version });
    return { ok: true };
  };

  const egress = denyEgress();
  let imported;
  try {
    imported = await importDepot({
      depot: depotDir,
      home,
      observed,
      verifier: rehearsalVerifier,
      install,
    });
  } finally {
    egress.restore();
  }
  if (
    !check(
      "import",
      imported.ok,
      imported.ok ? `imported depot ${imported.report.key} into machine-owned storage` : imported.reason,
    )
  ) {
    return finish();
  }
  if (!imported.ok) return finish();
  const report = imported.report;

  check(
    "offline",
    egress.attempts.length === 0,
    egress.attempts.length === 0
      ? "the import made no JavaScript network request; a spawned process is the network's job to deny"
      : `the import reached for ${egress.attempts.join(", ")}`,
  );

  const owned = importedDepotDir(home, report.key);
  const outside = fromDepot.filter((path) => !path.startsWith(owned));
  check(
    "machine-owned",
    report.path === owned && outside.length === 0 && fromDepot.length === lock.apps.length,
    outside.length === 0
      ? `all ${fromDepot.length} applications installed from the machine's own copy of the depot`
      : `${outside.length} applications were installed from outside ${owned}`,
  );

  const have = new Set(installed.map((app) => app.id));
  const missingClis = CODER_CLIS.filter((id) => !have.has(id));
  check(
    "coder-clis",
    missingClis.length === 0,
    missingClis.length === 0
      ? `all seven coder CLIs installed: ${CODER_CLIS.join(", ")}`
      : `missing ${missingClis.join(", ")}`,
  );
  const missingCompanions = COMPANIONS.filter((id) => !have.has(id));
  check(
    "companions",
    missingCompanions.length === 0,
    missingCompanions.length === 0
      ? `mise, red-dev, the runtimes, the daemon, Herdr, Zellij and VS Code installed from depot-local content`
      : `missing ${missingCompanions.join(", ")}`,
  );

  check(
    "activation",
    report.activated.length === 1 && report.activated[0] === ACTIVATED_PLUGIN,
    `${report.activated.join(", ")} is activated in the coder hosts, and nothing else is`,
  );
  check(
    "package-set",
    report.packageSet.digest.length === 64 && report.packageSet.key.startsWith(report.packageSet.version),
    `every surface verifies package set ${report.packageSet.key}`,
  );

  const leaked = scanForCredentials(owned);
  check(
    "credentials",
    leaked.length === 0,
    leaked.length === 0
      ? "no recognised cloud token, auth store or key material was transported"
      : `${leaked.map((f) => `${f.kind} at ${f.path}`).join("; ")}`,
  );

  // -------------------------------------------------------- the second converge
  const provisioned: ObservedTarget = { ...observed, installed };
  const secondEgress = denyEgress();
  let second;
  try {
    second = await importDepot({
      depot: depotDir,
      home,
      observed: provisioned,
      verifier: rehearsalVerifier,
      install: async () => ({ ok: false, detail: "a converged machine must install nothing" }),
    });
  } finally {
    secondEgress.restore();
  }
  if (!check("second-converge", second.ok, second.ok ? "the second converge verified the whole depot again" : second.reason)) {
    return finish();
  }
  if (!second.ok) return finish();
  check(
    "zero-drift",
    second.report.writes.length === 0 && second.report.converged && second.report.install.installed.length === 0,
    second.report.writes.length === 0
      ? `the second converge wrote nothing and found all ${second.report.install.present.length} applications present`
      : `the second converge wrote ${second.report.writes.length} paths`,
  );

  const rows = offlineDepotRows(offlineDepotReport(home));
  const unhealthy = rows.filter((row) => row.status === "err" || row.status === "warn");
  check(
    "doctor",
    unhealthy.length === 0 && rows.length > 0,
    unhealthy.length === 0
      ? `doctor reports ${rows.length} healthy lines, including the accounts nobody can configure without a network`
      : unhealthy.map((row) => row.detail).join("; "),
  );

  return finish();
}

/** The journey as lines, for the command that runs it. PURE. */
export function journeyLines(result: JourneyResult): string[] {
  const lines = result.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name} — ${c.detail}`);
  lines.push(
    result.ok
      ? `\nubuntu-24.04-x64 offline depot journey: ${result.checks.length} checks passed`
      : `\nubuntu-24.04-x64 offline depot journey: ${result.checks.filter((c) => !c.ok).length} of ${result.checks.length} checks failed`,
  );
  return lines;
}

/** The target this journey provisions, named once. */
export const JOURNEY_TARGET = UBUNTU;
