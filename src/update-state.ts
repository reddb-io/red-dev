import { toolPolicy } from "./tool-policy.ts";
import { runUpdateJob, withUpdateLock, updateClockPath } from "./update-coordinator.ts";
/**
 * What is out of date, written down where the desktop can read it.
 *
 * The GNOME bar cannot ask mise anything itself and should not: it does not
 * know which tools red-dev curates, and a network call has no place in the
 * Shell's process. So the watch tick, which already asks whether red-dev and
 * RedSkills moved every ten minutes, also keeps this small file, and the bar
 * only reads it.
 *
 * Curated means what red-dev declares in its mise fragment plus the agent
 * hosts mise owns. A runtime somebody added to their own config.toml is
 * theirs to update and is never reported here.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { AGENTS } from "./agents.ts";
import { runBounded, type BoundedCommandResult } from "./bounded-command.ts";
import { miseEntries } from "./mise-config.ts";
import { miseGithubEnvironment, miseRemoteVersionsEnv } from "./mise-github.ts";
import type { Platform } from "./platform.ts";
import { redDevStateRoot } from "./reclaim.ts";

export interface OutdatedTool {
  name: string;
  current: string;
  latest: string;
}

export interface UpdateState {
  checkedAt: string;
  outdated: OutdatedTool[];
}

/** Six hours: releases are hours apart, and the file is read far more often. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function updateStatePath(env: Record<string, string | undefined> = process.env): string {
  return join(redDevStateRoot(env), "updates.json");
}

/** The names `mise outdated` may use for a tool red-dev curates. PURE. */
export function curatedToolNames(
  p: Platform,
  hosts: readonly { mise?: string; cmd?: string }[] = AGENTS,
): Set<string> {
  const names = new Set<string>();
  for (const entry of miseEntries(p)) {
    if (toolPolicy(entry.alias ?? entry.spec, entry.spec).mode !== "follow") continue;
    names.add(entry.spec);
    if (entry.alias) names.add(entry.alias);
  }
  for (const host of hosts) {
    if (host.mise && toolPolicy(host.cmd ?? host.mise, host.mise).mode === "follow") names.add(host.mise);
  }
  return names;
}

/**
 * The curated tools `mise outdated --json` reports as behind. PURE.
 *
 * mise answers with an object keyed by tool name. A row with no `latest`, or
 * one already at it, is not behind, and anything unparseable is nothing.
 */
export function parseOutdated(json: string, curated: ReadonlySet<string>): OutdatedTool[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const out: OutdatedTool[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!curated.has(key) || typeof value !== "object" || value === null) continue;
    const row = value as { name?: unknown; current?: unknown; latest?: unknown };
    const current = typeof row.current === "string" ? row.current : "";
    const latest = typeof row.latest === "string" ? row.latest : "";
    if (latest === "" || latest === current) continue;
    out.push({ name: typeof row.name === "string" ? row.name : key, current, latest });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readUpdateState(path = updateStatePath()): UpdateState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<UpdateState>;
    if (typeof parsed.checkedAt !== "string" || !Array.isArray(parsed.outdated)) return null;
    return parsed as UpdateState;
  } catch {
    return null;
  }
}

/** Whether the last look is old enough to ask again. PURE. */
export function updateCheckDue(state: UpdateState | null, nowMs: number): boolean {
  if (state === null) return true;
  const at = Date.parse(state.checkedAt);
  return !Number.isFinite(at) || nowMs - at >= UPDATE_CHECK_INTERVAL_MS || at > nowMs;
}

export interface RefreshOptions {
  coordinated?: boolean;
  path?: string;
  nowMs?: number;
  run?: (argv: string[], env: Record<string, string | undefined>) => Promise<BoundedCommandResult>;
  env?: Record<string, string>;
}

/**
 * Ask mise, at most once per interval, and keep the answer.
 *
 * Best effort by construction: a machine without mise, without a network or
 * with a mise that times out keeps whatever it last knew, and the watch that
 * called this carries on. The release-age exemption for curated tools is the
 * same one red-dev's own mise calls carry, so "behind" means what an update
 * would actually install.
 */
export async function refreshUpdateState(p: Platform, opts: RefreshOptions = {}): Promise<UpdateState | null> {
  const path = opts.path ?? updateStatePath();
  const nowMs = opts.nowMs ?? Date.now();
  const previous = readUpdateState(path);
  if (!updateCheckDue(previous, nowMs)) return previous;

  const refresh = async () => {
    await runUpdateJob("metadata", UPDATE_CHECK_INTERVAL_MS, async () => {
      const run = opts.run ?? ((argv, env) => runBounded(argv, { timeoutMs: 90_000, env }));
      const { miseReleaseAgeEnv } = await import("./providers.ts");
      let result: BoundedCommandResult;
      try {
        result = await run(["mise", "outdated", "--json"], {
          ...process.env, ...miseGithubEnvironment(), ...miseRemoteVersionsEnv(), ...miseReleaseAgeEnv(p), ...opts.env,
        });
      } catch { return false; }
      if (result.timedOut || result.exitCode !== 0) return false;
      // Invalid output is a failed observation, never an empty successful list.
      try { const parsed = JSON.parse(result.stdout); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false; }
      catch { return false; }
      const state: UpdateState = { checkedAt: new Date(nowMs).toISOString(), outdated: parseOutdated(result.stdout, curatedToolNames(p)) };
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
      return true;
    }, { path: opts.path ? `${path}.clock` : updateClockPath(), now: nowMs });
    return readUpdateState(path) ?? previous;
  };
  if (opts.coordinated) return refresh();
  const result = await withUpdateLock(refresh, opts.path ? `${path}.clock` : updateClockPath());
  return result.busy ? previous : result.value;
}
