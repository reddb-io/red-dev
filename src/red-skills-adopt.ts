/**
 * Adopting a Spec #185 workstation into the package set, conservatively.
 *
 * A machine provisioned by the standalone `install.sh` carries an entire
 * second RedSkills: extracted trees under `~/.red-skills/versions`, the
 * tarballs they came out of, a Git-sourced marketplace in Claude and
 * Codex, generated OpenCode/RedCode/pi surfaces recorded in their own
 * manifests, the per-version plugin copy each host kept, and the
 * release-driven companion record ADR 0014 replaced. ADR 0010 says that
 * state is adopted and backed up first, and that **obsolete caches and
 * Git-sourced ownership are removed only after the package-set source
 * and all managed surfaces verify**.
 *
 * ## Why this is not the migration that was already here
 *
 * `migrations.ts` has carried a legacy cleanup since ADR 0008, and it
 * ran ungated: a converge planned the removal and did it, in the same
 * pass, with nothing standing between the plan and the delete. On a
 * machine where the new source had not landed — no network, a refused
 * manifest, a Worker holding the activation — that took the only
 * RedSkills the machine had. The gate below is the whole difference,
 * and it is why this module exists rather than a fourth clause inside
 * that one.
 *
 * ## The order, which is the contract
 *
 *   1. **Inventory.** Everything Spec #185 owns, named, with what it
 *      costs. Nothing is removed while this is being built, and an empty
 *      inventory is what makes a second run a no-op rather than a second
 *      deletion.
 *   2. **Back up.** The state that cannot be re-derived is copied under
 *      `~/.local/state/red-dev/adoption/<stamp>` — deliberately not
 *      under `~/.local/share/red-dev`, which an uninstall removes,
 *      because a backup an uninstall takes with it is not a backup.
 *   3. **Verify.** The package set is active, all seven hosts reported
 *      and none of them blocked or failed, every companion the same.
 *      Anything short of that ends the run *here*, with nothing removed.
 *   4. **Clean up.** Only then, and only what step 1 named.
 *
 * An interrupt is safe at every point in that sequence because removal
 * is last and is the only step that takes anything: a run killed during
 * the inventory, during the backup or during verification leaves the
 * previous source exactly where it was, and the next run starts again
 * from the same inventory.
 *
 * ## What "obsolete" means, item by item
 *
 * Nothing here removes on the evidence that a path exists. Each kind
 * carries its own definition of superseded, and each one is a question
 * with an answer on disk rather than a guess:
 *
 *   - a **version tree** is superseded when `current` no longer resolves
 *     into `versions/`, which the gate has already established;
 *   - a **registration** is superseded when the host itself reports
 *     red-dev's directory source on re-read — never because a converge
 *     said it re-registered it;
 *   - a **generated path** is superseded when the legacy manifest names
 *     it and the host registry does not own it, which is exactly the
 *     output of a generator run against a tree that no longer exists;
 *   - a **plugin copy** or a **companion asset** is superseded when its
 *     version is neither active nor previous, and no host records
 *     resolving through it.
 *
 * The files the operator wrote are never in the inventory at all. A
 * registration lives inside a config file somebody else owns, so what
 * comes out of it is one entry — the rest of the file is theirs, here as
 * everywhere else in this repo.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

import { log } from "./log.ts";
import { readCompanionRegistry, retainedVersions, type CompanionOutcome } from "./red-skills-companions.ts";
import { HOST_ADAPTERS, readHostRegistry, type HostOutcome } from "./red-skills-hosts.ts";
import {
  claudeRegistration,
  codexRegistration,
  MARKETPLACE_NAME,
  registrationIsOurs,
  type MarketplaceRegistration,
} from "./red-skills-registration.ts";
import {
  formatPackageSetIdentity,
  readPackageSetState,
  redSkillsCurrentLink,
  type PackageSetIdentity,
} from "./red-skills-set.ts";

/** The companions a complete workstation converges, by the name they report. */
const COMPANION_NAMES: readonly string[] = ["runtimes", "redskilled", "herdr", "vscode", "zellij"];

/** The two hosts that keep a per-version plugin copy of their own. */
const PLUGIN_CACHE_HOSTS: readonly string[] = ["claude", "codex"];

/** The generators Spec #185 recorded in a manifest instead of a marketplace. */
const GENERATED_HOSTS: readonly string[] = ["opencode", "redcode", "pi"];

const EXACT_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

// ------------------------------------------------------------- the inventory

/**
 * One kind of Spec #185 ownership, so a report can group them and a
 * removal can ask the right question about each.
 */
export type LegacyKind =
  | "standalone-tree"
  | "standalone-tarball"
  | "git-registration"
  | "generated-host-state"
  | "companion-record"
  | "companion-asset"
  | "host-plugin-copy";

export interface LegacyItem {
  kind: LegacyKind;
  /** The directory or file this ownership is, or lives inside. */
  path: string;
  /** One phrase a person reads: a version, a repo, a host name. */
  detail: string;
  /** What removing it gives back, which is half the reason to remove it. */
  bytes: number;
  /** For the two kinds that are scoped to one host, which host. */
  host?: string;
}

export interface LegacyInventory {
  schema: 1;
  items: LegacyItem[];
  /** The sum of the above, for the one line worth reading. */
  bytes: number;
}

export interface AdoptOptions {
  /** Defaults to this user's home. Injected by the tests. */
  home?: string;
  /** Defaults to `$XDG_CONFIG_HOME`, then `<home>/.config`. */
  config?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * What the two marketplace hosts have written down.
   *
   * Read at their own boundary by default. Injected because a
   * registration is the one item here whose removal cannot be observed
   * as a path, and the test that matters is the one where a host still
   * reports Git afterwards.
   */
  registrations?: () => Promise<Record<string, MarketplaceRegistration | null>>;
  /**
   * The gate: the package set, the seven hosts and the companions.
   *
   * Defaults to what this machine has recorded, which is what a converge
   * that just ran wrote down. Injected so the criterion about a cleanup
   * that must not begin can be asserted without seven coder CLIs.
   */
  verify?: () => Promise<AdoptionVerification>;
  /** The stamp the backup is named after. Defaults to now. */
  at?: string;
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return normalise(env["HOME"] ?? env["USERPROFILE"] ?? homedir());
}

function normalise(path: string): string {
  return path.replace(/\\/g, "/");
}

function configOf(opts: AdoptOptions, home: string): string {
  const env = opts.env ?? process.env;
  return normalise(opts.config ?? env["XDG_CONFIG_HOME"] ?? join(home, ".config"));
}

/**
 * Everything Spec #185 still owns on this machine, and nothing else.
 *
 * A plan rather than a sweep, for the reason the ADR 0008 cleanup was
 * one too: the tests assert against this without deleting anything, and
 * the same list is what the backup copies and what the cleanup removes,
 * so there is no second traversal that could disagree with the first.
 */
export async function inventoryLegacyWorkstation(
  opts: AdoptOptions = {},
): Promise<LegacyInventory> {
  const home = normalise(opts.home ?? homeOf(opts.env ?? process.env));
  const config = configOf(opts, home);
  const keep = new Set(retainedVersions(home));

  const items = [
    ...standaloneTrees(home),
    ...standaloneTarballs(home),
    ...(await gitRegistrations(home, opts)),
    ...GENERATED_HOSTS.flatMap((host) => generatedHostState(home, config, host)),
    ...companionRecords(home),
    ...companionAssets(home, keep),
    ...PLUGIN_CACHE_HOSTS.flatMap((host) => hostPluginCopies(home, host, keep)),
  ];
  return { schema: 1, items, bytes: items.reduce((sum, item) => sum + item.bytes, 0) };
}

/**
 * The extracted trees under `~/.red-skills/versions`.
 *
 * Real directories only, and only ones carrying the two markers the
 * standalone installer leaves — a `.upstream` stamp beside a marketplace
 * manifest. A link there is what ADR 0008 left pointing into mise's
 * installs and costs nothing; a directory without the markers was put
 * there by something this module does not understand, which is not the
 * same as something it may delete.
 */
function standaloneTrees(home: string): LegacyItem[] {
  const versions = join(home, ".red-skills", "versions");
  const out: LegacyItem[] = [];
  for (const name of listing(versions)) {
    const path = join(versions, name);
    const stat = statOf(path);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (!existsSync(join(path, ".upstream"))) continue;
    if (!existsSync(join(path, ".claude-plugin", "marketplace.json"))) continue;
    out.push({ kind: "standalone-tree", path, detail: name, bytes: treeBytes(path) });
  }
  return out;
}

/**
 * The tarballs `~/.red-skills/cache` kept after unpacking each one.
 *
 * The directory itself is not an item. It is where the standalone
 * installer downloads to, and on a machine still running that installer
 * an absent cache directory is a thing to recreate rather than a thing
 * to have — the cleanup prunes it only once it is empty.
 */
function standaloneTarballs(home: string): LegacyItem[] {
  const cache = join(home, ".red-skills", "cache");
  const out: LegacyItem[] = [];
  for (const name of listing(cache)) {
    if (!name.endsWith(".tar.gz")) continue;
    const path = join(cache, name);
    const stat = statOf(path);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) continue;
    out.push({ kind: "standalone-tarball", path, detail: name, bytes: stat.size });
  }
  return out;
}

/**
 * A marketplace registration that is not the one red-dev declares.
 *
 * Both spellings count. A `github`/`git` source is the one `install.sh`
 * writes wherever it runs; a `directory` source pinned at
 * `versions/<v>` is the *other* Spec #185 shape — correct on the day it
 * was written and frozen for good after it, because nothing moved the
 * directory it names. `registrationIsOurs` already draws that line for
 * the converge and the drift check, so it draws it here too rather than
 * being restated with a third definition.
 */
async function gitRegistrations(home: string, opts: AdoptOptions): Promise<LegacyItem[]> {
  const read = opts.registrations ?? defaultRegistrations;
  const current = redSkillsCurrentLink(home);
  const out: LegacyItem[] = [];
  for (const [host, registration] of Object.entries(await read(home))) {
    if (registration === null) continue;
    if (registrationIsOurs(registration, current)) continue;
    out.push({
      kind: "git-registration",
      path: registrationFile(home, host),
      detail: `${registration.kind}: ${registration.source ?? MARKETPLACE_NAME}`,
      bytes: 0,
      host,
    });
  }
  return out;
}

async function defaultRegistrations(
  home: string,
): Promise<Record<string, MarketplaceRegistration | null>> {
  return {
    claude: await claudeRegistration(home),
    codex: await codexRegistration(home),
  };
}

function registrationFile(home: string, host: string): string {
  return host === "claude"
    ? join(home, ".claude", "plugins", "known_marketplaces.json")
    : join(home, ".codex", "config.toml");
}

/**
 * The paths a generator wrote that the host registry does not own.
 *
 * The manifest is the claim. OpenCode, RedCode and pi have no
 * marketplace to ask, so the installer that created their surface wrote
 * down what it created — and that list, intersected against what red-dev
 * recorded owning when it reconciled the same host, is the only
 * defensible answer to "which of these files is left over". A path the
 * new record owns is the *current* surface sitting at the same address
 * and is never an item.
 *
 * The manifest itself joins them when every path it names is superseded
 * and the registry does not own the manifest either: at that point it is
 * a record of a tree that no longer exists.
 */
function generatedHostState(home: string, config: string, host: string): LegacyItem[] {
  const owned = ownedPaths(home, host);
  const out: LegacyItem[] = [];
  for (const manifest of manifestCandidates(home, config, host)) {
    if (!existsSync(manifest)) continue;
    const listed = manifestPaths(manifest);
    const superseded = listed.filter((path) => !owned.has(path) && existsSync(path));
    for (const path of superseded) {
      out.push({
        kind: "generated-host-state",
        path,
        detail: `${host}: generated by the standalone installer`,
        bytes: treeBytes(path),
        host,
      });
    }
    if (superseded.length === listed.length && listed.length > 0 && !owned.has(manifest)) {
      out.push({
        kind: "generated-host-state",
        path: manifest,
        detail: `${host}: the manifest recording them`,
        bytes: statOf(manifest)?.size ?? 0,
        host,
      });
    }
  }
  return out;
}

/** Where a generator writes down what it created, in the two usual places. */
function manifestCandidates(home: string, config: string, host: string): string[] {
  return [
    join(config, host, "redskills-install-manifest.txt"),
    join(home, `.${host}`, "redskills-install-manifest.txt"),
  ];
}

/** The absolute paths one manifest names, blank lines dropped. */
function manifestPaths(manifest: string): string[] {
  try {
    return readFileSync(manifest, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(normalise);
  } catch {
    return [];
  }
}

/** What red-dev recorded owning in one host, as path keys. */
function ownedPaths(home: string, host: string): Set<string> {
  const record = readHostRegistry(home).hosts[host];
  const out = new Set<string>();
  for (const entry of record?.owned ?? []) {
    if (entry.kind === "path") out.add(normalise(entry.path));
    else if (entry.kind === "field" || entry.kind === "block") out.add(normalise(entry.file));
  }
  return out;
}

/**
 * The release-driven companion record, once the registry has replaced it.
 *
 * ADR 0014 moved the extension and the herdr plugin out of a GitHub
 * release and into the package set, and the new walk writes its own
 * record. Until it has, the old file is the only thing that knows what
 * this machine installed and which editors took it — so it is an item
 * exactly when the companion registry covers every entry in it, and not
 * one second earlier.
 */
function companionRecords(home: string): LegacyItem[] {
  const path = join(home, ".local", "share", "red-dev", "red-skills-extensions.json");
  if (!existsSync(path)) return [];
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // Unreadable is not evidence that it is spent. Left alone, and the
    // next run asks again.
    return [];
  }
  const entries = Object.keys(record);
  if (entries.length === 0) return [];
  const registry = readCompanionRegistry(home).companions;
  if (!entries.every((name) => registry[name] !== undefined)) return [];
  return [
    {
      kind: "companion-record",
      path,
      detail: `superseded by the companion registry for ${entries.join(", ")}`,
      bytes: statOf(path)?.size ?? 0,
    },
  ];
}

/**
 * Downloaded `.vsix` artifacts beyond the active and previous revisions.
 *
 * The retention rule ADR 0010 states, applied to the one cache the
 * release path filled and nothing ever swept. `retainedVersions` is the
 * machine's own answer to "active plus previous", so this cannot drift
 * from what the package-set state actually holds.
 */
function companionAssets(home: string, keep: Set<string>): LegacyItem[] {
  const dir = join(home, ".local", "share", "red-dev", "red-skills-assets");
  const out: LegacyItem[] = [];
  for (const name of listing(dir)) {
    const version = versionIn(name);
    if (version !== null && keep.has(version)) continue;
    const path = join(dir, name);
    const stat = statOf(path);
    if (!stat || stat.isSymbolicLink()) continue;
    out.push({
      kind: "companion-asset",
      path,
      detail: version ?? name,
      bytes: stat.isDirectory() ? treeBytes(path) : stat.size,
    });
  }
  return out;
}

/**
 * One host's per-version plugin copies, beyond active plus previous.
 *
 * Two protections, and both are the reason this is not a `rm -rf` of the
 * cache directory. A copy whose version the package-set state still
 * retains stays, because that is the revision the machine is on or the
 * one a rollback restores. A copy the host records as installed stays
 * whatever its version, because a copy something resolves through is not
 * history — it is the plugin, and removing it would break the host this
 * adoption just verified.
 */
function hostPluginCopies(home: string, host: string, keep: Set<string>): LegacyItem[] {
  const installed = installedPaths(home, host);
  if (installed === null) return [];

  const root = join(home, `.${host}`, "plugins", "cache", MARKETPLACE_NAME);
  const out: LegacyItem[] = [];
  for (const plugin of listing(root)) {
    const pluginDir = join(root, plugin);
    for (const name of listing(pluginDir)) {
      if (!EXACT_VERSION.test(name)) continue;
      if (keep.has(name)) continue;
      const path = join(pluginDir, name);
      if (installed.has(normalise(path))) continue;
      const stat = statOf(path);
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
      out.push({
        kind: "host-plugin-copy",
        path,
        detail: `${host}: ${plugin} ${name}`,
        bytes: treeBytes(path),
        host,
      });
    }
  }
  return out;
}

/**
 * The copies one host records as installed, by path.
 *
 * Claude writes the install path of every plugin it carries, which makes
 * "is anything resolving through this directory" a question with an
 * answer. A file that is there and cannot be parsed answers null and the
 * whole host is left alone — an unreadable record is not evidence that
 * nothing is installed. Codex records that a plugin is enabled and not
 * where it put it, so it has nothing to read back and the retention rule
 * above is what covers it.
 */
function installedPaths(home: string, host: string): Set<string> | null {
  if (host !== "claude") return new Set<string>();
  const path = join(home, ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(path)) return new Set<string>();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      plugins?: Record<string, { installPath?: unknown }[]>;
    };
    const out = new Set<string>();
    for (const entries of Object.values(parsed.plugins ?? {})) {
      for (const entry of entries ?? []) {
        if (typeof entry?.installPath === "string") out.add(normalise(entry.installPath));
      }
    }
    return out;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- the gate

/**
 * What has to be true before anything is removed.
 *
 * Three facts, all of them observed rather than assumed: the package set
 * `current` resolves, what the seven host adapters reported, and what
 * the five companions reported.
 */
export interface AdoptionVerification {
  /** The set `current` names, or null when this machine resolves none. */
  active: PackageSetIdentity | null;
  hosts: readonly HostOutcome[];
  companions: readonly CompanionOutcome[];
}

export type AdoptionGate = { ok: true; witness: string } | { ok: false; reason: string };

/**
 * Does the new workstation stand on its own yet? PURE.
 *
 * A host that is `absent` passes: that is a machine which does not have
 * gemini, not a host red-dev failed to wire, and the seven-host promise
 * is about the ones that exist. A host that was never *reported* does
 * not pass — an unreported surface is one nothing checked, and counting
 * silence as success is precisely how an ungated cleanup justified
 * itself.
 */
export function adoptionGate(verification: AdoptionVerification): AdoptionGate {
  if (verification.active === null) {
    return { ok: false, reason: "no package set is active — there is nothing to adopt onto" };
  }

  const reported = new Set(verification.hosts.map((h) => h.host));
  const unreported = HOST_ADAPTERS.map((a) => a.name).filter((name) => !reported.has(name));
  if (unreported.length > 0) {
    return { ok: false, reason: `nothing verified ${unreported.join(", ")}` };
  }
  const stuck = verification.hosts.filter((h) => h.status === "blocked" || h.status === "failed");
  if (stuck.length > 0) {
    return { ok: false, reason: `not reconciled into ${stuck.map((h) => h.host).join(", ")}` };
  }

  const seen = new Set<string>(verification.companions.map((c) => c.companion));
  const missing = COMPANION_NAMES.filter((name) => !seen.has(name));
  if (missing.length > 0) {
    return { ok: false, reason: `nothing verified ${missing.join(", ")}` };
  }
  const refused = verification.companions.filter(
    (c) => c.status === "blocked" || c.status === "failed",
  );
  if (refused.length > 0) {
    return { ok: false, reason: `companions did not converge: ${refused.map((c) => c.companion).join(", ")}` };
  }

  return {
    ok: true,
    witness: `${formatPackageSetIdentity(verification.active)} across ${verification.hosts.length} hosts and ${verification.companions.length} companions`,
  };
}

/** What this machine has recorded, which is what a converge just wrote. */
async function recordedVerification(home: string): Promise<AdoptionVerification> {
  const state = readPackageSetState(home);
  const active = state.revisions.find((r) => r.key === state.active) ?? null;
  const hosts = readHostRegistry(home).hosts;
  const companions = readCompanionRegistry(home).companions;
  return {
    active: active
      ? { version: active.version, digest: active.digest, sourceCommit: active.sourceCommit }
      : null,
    // A recorded host is one a reconciliation verified and wrote down;
    // one with no record is unreported, which the gate refuses.
    hosts: Object.keys(hosts).map((host) => ({ host, status: "current" as const })),
    companions: Object.keys(companions).map((companion) => ({
      companion: companion as CompanionOutcome["companion"],
      status: "current" as const,
    })),
  };
}

// --------------------------------------------------------------- the backup

/** `~/.local/state/red-dev/adoption` — deliberately not under `share`. */
export function adoptionBackupRoot(home: string): string {
  return join(normalise(home), ".local", "state", "red-dev", "adoption");
}

export interface AdoptionBackup {
  /** The directory this run wrote, named after the instant it started. */
  path: string;
  /** The items whose bytes are in it. */
  copied: LegacyItem[];
  /** The items recorded by identity rather than copied, and why. */
  recorded: LegacyItem[];
}

/**
 * Copy what cannot be re-derived, record what can.
 *
 * Every kind is copied except the extracted version trees, and that
 * exception is the one judgement call in this module worth stating
 * plainly: a tree is a published tarball unpacked a second time, the
 * tarball beside it *is* copied, and duplicating a gigabyte in order to
 * reclaim a gigabyte would reclaim nothing. So a tree is recorded — its
 * path, its version and its size — and restoring one means unpacking the
 * tarball that is in the backup with it.
 *
 * Layout mirrors the machine: `files/<path relative to home>`. A backup
 * that flattened names would be one nobody could put back.
 */
export function backupLegacyWorkstation(
  home: string,
  inventory: LegacyInventory,
  at: string,
): AdoptionBackup {
  const path = join(adoptionBackupRoot(home), at);
  const copied: LegacyItem[] = [];
  const recorded: LegacyItem[] = [];

  for (const item of inventory.items) {
    if (item.kind === "standalone-tree") {
      recorded.push(item);
      continue;
    }
    const dest = join(path, "files", relative(normalise(home), normalise(item.path)));
    try {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(item.path, dest, { recursive: true, dereference: false });
      copied.push(item);
    } catch {
      // One unreadable file is not a reason to abandon the backup of
      // everything beside it. It stays in the inventory, and the
      // cleanup below refuses to remove an item the backup does not
      // hold — so an item that could not be copied is one that is kept.
    }
  }

  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "inventory.json"),
    `${JSON.stringify({ schema: 1, at, items: inventory.items, recorded }, null, 2)}\n`,
  );
  return { path, copied, recorded };
}

// -------------------------------------------------------------- the removal

export interface AdoptionRemoval {
  item: LegacyItem;
  /** Why this one stayed. Present exactly on the items that did. */
  reason: string;
}

/**
 * `clean` is a machine with nothing left to adopt — the answer a second
 * run gives, and the shape of "zero drift". `held` is the gate refusing:
 * the inventory and the backup stand, and nothing was removed. `adopted`
 * removed what it named.
 */
export type AdoptionOutcome = "clean" | "adopted" | "held";

export interface Adoption {
  outcome: AdoptionOutcome;
  /** One sentence saying why, including on the happy path. */
  reason: string;
  inventory: LegacyInventory;
  /** Where the backup went, or null when there was nothing to back up. */
  backup: string | null;
  removed: LegacyItem[];
  /** Items deliberately left, each with the reason it survived. */
  kept: AdoptionRemoval[];
  /** What removing them gave back. */
  bytes: number;
}

/** `~/.local/share/red-dev/red-skills-adoption.json` — red-dev's own record. */
export function adoptionRecordPath(home: string): string {
  return join(normalise(home), ".local", "share", "red-dev", "red-skills-adoption.json");
}

export interface AdoptionRecord {
  schema: 1;
  at: string;
  outcome: AdoptionOutcome;
  backup: string | null;
  /** Exactly what red-dev took, which is the only thing an uninstall may. */
  removed: LegacyItem[];
}

export function readAdoptionRecord(home: string): AdoptionRecord | null {
  const path = adoptionRecordPath(home);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AdoptionRecord>;
    return parsed?.schema === 1 && Array.isArray(parsed.removed) ? (parsed as AdoptionRecord) : null;
  } catch {
    return null;
  }
}

/**
 * Adopt this machine, or say which step stopped short of it.
 *
 * The four phases in order, with the gate between the third and the
 * fourth. Nothing before the gate removes anything, which is what makes
 * every interrupt above it survivable, and the gate's refusal is
 * reported as `held` rather than as a failure: a machine that has not
 * finished converging is not broken, it is a machine to run again.
 */
export async function adoptLegacyWorkstation(opts: AdoptOptions = {}): Promise<Adoption> {
  const home = normalise(opts.home ?? homeOf(opts.env ?? process.env));
  const at = opts.at ?? nowStamp();
  const inventory = await inventoryLegacyWorkstation({ ...opts, home });

  if (inventory.items.length === 0) {
    return {
      outcome: "clean",
      reason: "no Spec #185 ownership is left on this machine",
      inventory,
      backup: null,
      removed: [],
      kept: [],
      bytes: 0,
    };
  }

  const backup = backupLegacyWorkstation(home, inventory, at);
  const held = new Set(backup.copied.concat(backup.recorded).map((item) => item.path));

  const verification = await (opts.verify ?? (() => recordedVerification(home)))();
  const gate = adoptionGate(verification);
  if (!gate.ok) {
    // The whole point of the module. The backup stands, the inventory
    // stands, and the previous source is exactly where it was.
    writeAdoptionRecord(home, { schema: 1, at, outcome: "held", backup: backup.path, removed: [] });
    return {
      outcome: "held",
      reason: `nothing was removed: ${gate.reason}`,
      inventory,
      backup: backup.path,
      removed: [],
      kept: inventory.items.map((item) => ({ item, reason: gate.reason })),
      bytes: 0,
    };
  }

  const registrations = await (opts.registrations ?? defaultRegistrations)(home);
  const current = redSkillsCurrentLink(home);
  const removed: LegacyItem[] = [];
  const kept: AdoptionRemoval[] = [];

  for (const item of inventory.items) {
    if (!held.has(item.path)) {
      kept.push({ item, reason: "the backup does not hold it" });
      continue;
    }
    if (item.kind === "git-registration") {
      const now = registrations[item.host ?? ""] ?? null;
      if (!registrationIsOurs(now, current)) {
        kept.push({ item, reason: `${item.host} still records a ${now?.kind ?? "missing"} source` });
        continue;
      }
      // The entry is gone because the host replaced it, which is the
      // only mechanism either CLI offers. Recorded as removed because
      // the ownership is what was obsolete, not the file it lived in.
      removed.push(item);
      continue;
    }

    try {
      rmSync(item.path, { recursive: true, force: true });
    } catch {
      kept.push({ item, reason: "it could not be removed" });
      continue;
    }
    if (existsSync(item.path)) {
      kept.push({ item, reason: "it is still there" });
      continue;
    }
    removed.push(item);
  }

  pruneEmptyStandaloneRoots(home);

  const bytes = removed.reduce((sum, item) => sum + item.bytes, 0);
  writeAdoptionRecord(home, { schema: 1, at, outcome: "adopted", backup: backup.path, removed });
  return {
    outcome: "adopted",
    reason: `adopted onto ${gate.witness}`,
    inventory,
    backup: backup.path,
    removed,
    kept,
    bytes,
  };
}

function writeAdoptionRecord(home: string, record: AdoptionRecord): void {
  const path = adoptionRecordPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Take the two standalone directories once they hold nothing.
 *
 * Only when empty, and never `~/.red-skills` itself: the package set
 * lives under it, and a cleanup that reached one level higher would
 * remove the source it just verified.
 */
function pruneEmptyStandaloneRoots(home: string): void {
  for (const name of ["versions", "cache"]) {
    const dir = join(home, ".red-skills", name);
    if (!existsSync(dir)) continue;
    if (listing(dir).length > 0) continue;
    try {
      // `recursive` on a directory this has just proved is empty, because
      // `rmSync` refuses a directory without it — the flag is how node
      // spells "remove a directory", not a licence to remove a tree.
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // An empty directory left behind costs nothing.
    }
  }
}

// --------------------------------------------------------------- the report

/** One line per item, in the voice the rest of a converge speaks. */
export function announceAdoption(adoption: Adoption): void {
  if (adoption.outcome === "clean") {
    log.skip(`red-skills: ${adoption.reason}`);
    return;
  }
  if (adoption.outcome === "held") {
    log.skip(`red-skills adoption: ${adoption.reason}`);
    log.plain(`       ${adoption.inventory.items.length} item(s) backed up to ${adoption.backup}`);
    return;
  }
  for (const item of adoption.removed) log.plain(`       removed ${item.path} (${item.detail})`);
  for (const { item, reason } of adoption.kept) log.skip(`kept ${item.path}: ${reason}`);
  log.ok(`red-skills: ${adoption.reason}`);
}

// --------------------------------------------------------------- the helpers

function listing(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function statOf(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** The exact version inside a file name, or null when there is none. */
function versionIn(name: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(name)?.[1] ?? null;
}

/**
 * What one tree occupies, following nothing.
 *
 * Walked rather than shelled out to `du`, which does not exist on every
 * target this runs on, and counted with lstat so a link inside the tree
 * contributes its own size instead of the size of what it names.
 */
function treeBytes(path: string): number {
  const stat = statOf(path);
  if (!stat) return 0;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
  let total = 0;
  for (const name of listing(path)) total += treeBytes(join(path, name));
  return total;
}

/** Now, to the second, in a form that is also a directory name. */
function nowStamp(): string {
  return `${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}Z`;
}
