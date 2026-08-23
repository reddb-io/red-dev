/**
 * Installs from before red-dev's standard, retired on the way past.
 *
 * A publisher moving mechanism leaves a copy behind, and the copy is not
 * inert: on the workstation that prompted this file, an npm
 * `@reddb-io/redcode@0.8.1` from before RedCode moved to GitHub releases
 * sat at PATH position 7 while the release red-dev installed sat at 28,
 * so three upgrades in a row reported `ok … v0.11.0` and the machine
 * kept running 0.8.1.
 *
 * `src/shadow-repair.ts` catches that at the moment of updating. This
 * catches it at the moment of installing, across every host at once,
 * which is where a person expects a machine to be put in order.
 *
 * ## Why this cannot loop
 *
 * The constraint that shapes everything here: **red-dev's own previous
 * installation is never legacy.** A retirement that treated it as one
 * would back up the same configuration and remove the same binary on
 * every run, forever, and the second run would be indistinguishable
 * from the first.
 *
 * So legacy is defined against the mechanism the catalog uses *now*:
 * the copy at that mechanism's own location is canonical, and only a
 * copy somewhere else can be retired. After one pass the canonical copy
 * is the only one left, the next pass finds nothing, and nothing is
 * backed up or removed. Idempotence is a property of the definition
 * rather than of a ledger that has to be kept honest.
 *
 * ## What it is willing to remove
 *
 * The same three confirmations `shadow-repair` requires: the host is not
 * installed by npm today, the leftover lives in a node `lib/node_modules`
 * tree, and npm's global list holds that package. Everything else is
 * reported with its path and left where it is.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { log } from "./log.ts";
import type { AgentSpec } from "./agents.ts";
import type { Platform } from "./platform.ts";
import { checkShadow, npmPackageOf } from "./shadow-repair.ts";

/** One copy of a host's command that the current mechanism does not own. */
export interface LegacyCopy {
  cmd: string;
  label: string;
  /** The leftover, resolved through links. */
  path: string;
  /** The npm package it belongs to, when it belongs to one. */
  owner: string | null;
  /** red-dev placed this itself, under a mechanism it no longer uses. */
  ours: boolean;
  /** Where the mechanism in use today would have put it. */
  canonical: string;
}

/**
 * Where the mechanism in use today places this host. PURE.
 *
 * Null for the mechanisms that place nothing of their own — npm, winget
 * and the Store each own their resolution, and a vendor's installer puts
 * its binary where the vendor decided. Those hosts have no canonical
 * path red-dev can name, so they are not examined: without a canonical
 * copy there is nothing to call the others legacy *against*, and
 * guessing would be the loop this file exists to avoid.
 */
export function canonicalPath(
  a: AgentSpec,
  method: string | null,
  bin: string,
  os: Platform["os"],
  shim?: string | null,
): string | null {
  if (a.cmd.length === 0) return null;
  // A host we publish: mise placed it, and its shim is where the name
  // is answered from. Null when mise has not placed it yet, because a
  // canonical copy that does not exist cannot make the others legacy.
  if (method === "mise") return shim ?? null;
  if (method !== "github-release") return null;
  return `${bin}/${a.cmd}${os === "windows" ? ".exe" : ""}`;
}

/**
 * A copy red-dev itself placed under a mechanism it no longer uses. PURE.
 *
 * The retirement will not remove what it cannot attribute, which is
 * right for a binary somebody else installed and wrong for one red-dev
 * wrote at a path it chose. A host that moved from a GitHub release to
 * mise leaves exactly one such file — `<bin>/<cmd>` — and leaving it
 * there means the old version keeps answering, which is the failure
 * this whole file exists for.
 */
export function ourOwnLeftover(
  a: AgentSpec,
  path: string,
  bin: string,
  os: Platform["os"],
): boolean {
  if (a.release === undefined || a.cmd.length === 0) return false;
  const placed = `${bin}/${a.cmd}${os === "windows" ? ".exe" : ""}`;
  return path.replace(/\\/g, "/") === placed.replace(/\\/g, "/");
}

export interface LegacyScanOptions {
  hosts: readonly AgentSpec[];
  platform: Platform;
  /** Where a release-installed host is placed on this machine. */
  bin: string;
  /** The install method the catalog uses today, per host. */
  method: (a: AgentSpec) => string | null;
  /** Every path on PATH answering to a name, in PATH order. */
  lookup: (cmd: string) => string[];
  /** The packages npm's global tree holds. */
  npmGlobals: ReadonlySet<string>;
  /** mise's shim for one host, when there is one. */
  shim?: (cmd: string) => string | null;
}

/** Every copy of a host that the mechanism in use today does not own. */
export function findLegacyCopies(opts: LegacyScanOptions): LegacyCopy[] {
  const out: LegacyCopy[] = [];
  for (const a of opts.hosts) {
    const canonical = canonicalPath(
      a,
      opts.method(a),
      opts.bin,
      opts.platform.os,
      opts.shim?.(a.cmd) ?? null,
    );
    if (canonical === null) continue;

    const seen = new Set<string>();
    for (const candidate of opts.lookup(a.cmd)) {
      const check = checkShadow(candidate, canonical);
      // Not resolvable, or the same file as the canonical one — which is
      // what red-dev's own previous installation always is.
      if (!check.shadowed || check.running === null) continue;
      if (seen.has(check.running)) continue;
      seen.add(check.running);

      const owner = npmPackageOf(check.running);
      out.push({
        cmd: a.cmd,
        label: a.label,
        path: check.running,
        owner: owner !== null && opts.npmGlobals.has(owner) ? owner : null,
        ours: ourOwnLeftover(a, check.running, opts.bin, opts.platform.os),
        canonical,
      });
    }
  }
  return out;
}

/**
 * Copy one host's declared configuration aside, once.
 *
 * Files only, and missing ones are not an error — see the note on
 * `AgentSpec.configFiles` about the gigabytes this deliberately does
 * not touch. Returns what was actually written.
 */
export function backupAgentConfig(a: AgentSpec, home: string, into: string): string[] {
  const written: string[] = [];
  for (const rel of a.configFiles ?? []) {
    const from = join(home, rel);
    if (!existsSync(from)) continue;
    const to = join(into, a.key, rel);
    try {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      written.push(to);
    } catch {
      // A configuration that cannot be copied must not stop the
      // retirement: the file stays where it is either way, and the
      // removal below touches a binary, never a config.
    }
  }
  return written;
}

export interface Retirement {
  cmd: string;
  outcome: "retired" | "reported";
  reason: string;
  /** Configuration copied aside before anything was removed. */
  backedUp: string[];
}

export interface RetireOptions extends LegacyScanOptions {
  home: string;
  /** Where configuration is copied. One directory per run. */
  backupDir: string;
  npm: string | null;
  mise: string | null;
  run: (argv: string[]) => Promise<number>;
  /** The host record, by command, for its configuration list. */
  specOf: (cmd: string) => AgentSpec | undefined;
}

/**
 * Retire everything the mechanism in use today does not own.
 *
 * Backs up before removing and only for a host something is actually
 * removed from, which is the second half of why this does not loop: a
 * machine already in order writes nothing at all.
 */
export async function retireLegacyInstalls(opts: RetireOptions): Promise<Retirement[]> {
  const found = findLegacyCopies(opts);
  const out: Retirement[] = [];

  for (const copy of found) {
    // A file red-dev wrote itself, at a path red-dev chose, under a
    // mechanism it has since left. Nobody else's software, and the one
    // leftover the attribution rule below would otherwise refuse to
    // touch on a machine where it is the whole problem.
    if (copy.ours) {
      const spec = opts.specOf(copy.cmd);
      const backedUp = spec ? backupAgentConfig(spec, opts.home, opts.backupDir) : [];
      log.warn(`${copy.label}: retiring ${copy.path}, which red-dev placed before it moved to mise`);
      try {
        rmSync(copy.path, { force: true });
      } catch (err) {
        out.push({
          cmd: copy.cmd,
          outcome: "reported",
          reason: `${copy.path} could not be removed: ${(err as Error).message}`,
          backedUp,
        });
        continue;
      }
      out.push({ cmd: copy.cmd, outcome: "retired", reason: `removed ${copy.path}`, backedUp });
      continue;
    }

    if (copy.owner === null || opts.npm === null) {
      log.warn(`${copy.label}: ${copy.path} answers before ${copy.canonical}`);
      log.plain("       red-dev cannot tell what installed it — remove it by hand to take the newer one");
      out.push({
        cmd: copy.cmd,
        outcome: "reported",
        reason: `${copy.path} is not a package red-dev can identify`,
        backedUp: [],
      });
      continue;
    }

    const spec = opts.specOf(copy.cmd);
    const backedUp = spec ? backupAgentConfig(spec, opts.home, opts.backupDir) : [];
    log.warn(`${copy.label}: retiring ${copy.owner}, which answers before ${copy.canonical}`);
    if (backedUp.length > 0) log.plain(`       configuration copied to ${opts.backupDir}`);

    await opts.run([opts.npm, "uninstall", "-g", copy.owner]);
    if (opts.mise) await opts.run([opts.mise, "reshim"]);

    out.push({
      cmd: copy.cmd,
      outcome: "retired",
      reason: `removed ${copy.owner}`,
      backedUp,
    });
  }

  return out;
}

/**
 * Retire what an old mechanism left, resolving every dependency here.
 *
 * The one entry point both install paths share. It lived in firstrun.ts
 * and so ran only where a person picked agents — the first-run
 * interview or the menu — which meant a plain `red-dev install core` on
 * a configured machine swept nothing, and the RedCode copy this move
 * was built to retire sat in ~/.local/bin through install after install.
 *
 * What npm holds, where PATH looks, where a release lands and where mise
 * shims are all facts about this machine; resolved here rather than
 * inside `retireLegacyInstalls`, which stays pure and testable.
 */
export async function retireLegacyAgents(
  p: Platform,
  hosts: readonly AgentSpec[],
): Promise<void> {
  try {
    const { agentInstallMethod, resolveNpm } = await import("./agents.ts");
    const { pathLookup } = await import("./shadowed.ts");
    const { npmGlobalPackages } = await import("./agent-update.ts");
    const { userBinDir, windowsBinDir, spawnLogged } = await import("./providers.ts");
    const { adoptionBackupRoot } = await import("./red-skills-adopt.ts");

    const home = (process.env["HOME"] ?? process.env["USERPROFILE"] ?? "").replace(/\\/g, "/");

    // A host that should be mise's but is not there yet has no canonical
    // copy, so nothing could be called legacy against it and the old
    // copy would survive every sweep. Place the mise ones first — the
    // converge walks the manifest's tools, never the agent hosts, so on
    // a plain `install core` this is the only thing that installs them.
    //
    // `mise install`, not `mise use`: the pin is already in red-dev's
    // conf.d fragment, and `use` would write it a *second* time into
    // config.toml — which is exactly the doubled `redcode` entry the
    // first version of this produced. `install` reads the fragment and
    // downloads what is declared, writing nothing. Idempotent, and it
    // leaves an already-current tool alone.
    const { miseShim } = await import("./mise-config.ts");
    const { agentInstallMethod: methodOf } = await import("./agents.ts");
    const mise = Bun.which("mise");
    const needMise = hosts.some(
      (h) => h.mise && methodOf(h, p) === "mise" && miseShim(h.cmd) === null,
    );
    if (needMise && mise) {
      try {
        const { spawnLogged } = await import("./providers.ts");
        await spawnLogged([mise, "install"], { timeoutMs: 300_000 });
      } catch (err) {
        log.warn(`could not place hosts under mise: ${(err as Error).message}`);
      }
    }

    const npm = await resolveNpm();
    const retired = await retireLegacyInstalls({
      hosts,
      platform: p,
      bin: p.os === "windows" ? windowsBinDir() : userBinDir(),
      method: (a) => agentInstallMethod(a, p),
      lookup: (cmd) => pathLookup(cmd),
      shim: (cmd) => miseShim(cmd),
      npmGlobals: npm ? await npmGlobalPackages(npm) : new Set<string>(),
      home,
      // One directory per run, beside the adoption backups: same shape
      // of act, same place a person already looks for what red-dev moved.
      backupDir: `${adoptionBackupRoot(home)}/${new Date().toISOString().replace(/[:.]/g, "-")}`,
      npm,
      mise: Bun.which("mise"),
      specOf: (cmd) => hosts.find((a) => a.cmd === cmd),
      run: async (argv) => await spawnLogged(argv, { timeoutMs: 120_000 }),
    });
    const removed = retired.filter((r) => r.outcome === "retired");
    if (removed.length > 0) {
      log.ok(`retired ${removed.length} install(s) from before red-dev's standard`);
    }
  } catch (err) {
    // Never fatal: this tidies, and an install that refused to proceed
    // because tidying failed would be the worse trade.
    log.warn(`legacy sweep: ${(err as Error).message}`);
  }
}
