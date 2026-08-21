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

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
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
): string | null {
  if (method !== "github-release" || a.cmd.length === 0) return null;
  return `${bin}/${a.cmd}${os === "windows" ? ".exe" : ""}`;
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
}

/** Every copy of a host that the mechanism in use today does not own. */
export function findLegacyCopies(opts: LegacyScanOptions): LegacyCopy[] {
  const out: LegacyCopy[] = [];
  for (const a of opts.hosts) {
    const canonical = canonicalPath(a, opts.method(a), opts.bin, opts.platform.os);
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
