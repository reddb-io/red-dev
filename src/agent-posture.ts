/**
 * The machine's agent posture, as `doctor` reports it.
 *
 * Three questions, one section, and the same rule over all of them: this
 * reports and does nothing else. `doctor` is what people run when a
 * machine is already misbehaving, so a report that authenticates, takes
 * the usage collector's lock or rewrites a preference would be a
 * diagnostic that changes the patient — and the collector this reads
 * from is the one whose whole design memo is that a display surface must
 * never be able to start one. See src/agent-usage.ts and
 * .red/contexts/agents/CONTEXT.md.
 *
 * Which host is the Default agent comes from the recorded choice read
 * against what is installed, which is src/default-agent.ts's job and not
 * repeated here.
 *
 * Whether an installed host is current is answered from the copy on
 * PATH and nothing else. Asking each vendor what their newest version is
 * would be a network call per host on a command that is supposed to be
 * cheap, and running `<host> --version` would be the agent process this
 * project spent a release learning not to start from a status surface.
 * So freshness is the age of the file that would run — evidence rather
 * than a verdict, with the verdict left to the threshold below and the
 * evidence printed beside it.
 *
 * Agent usage is the per-provider detail that does not fit on the
 * Redwall's compact line: every window the provider defines, what is
 * left of it, and when it comes back. Unknown is an answer — no
 * snapshot, or one too old to vouch for, reads as unknown and never as a
 * number.
 */

import { statSync } from "node:fs";
import {
  agentUsageReading,
  agentUsageSnapshot,
  type AgentUsageReading,
  type AgentUsageSnapshot,
} from "./agent-usage.ts";
import { AGENTS, commandPath, type AgentSpec } from "./agents.ts";
import { readDefaultAgent, reportDefaultAgent } from "./default-agent.ts";
import type { Platform } from "./platform.ts";

/** One line of the section, in the shape drift checks already use. */
export interface AgentPostureRow {
  readonly name: string;
  readonly status: "ok" | "drift" | "n/a";
  readonly detail: string;
  /** What to run. Omitted when there is nothing to do. */
  readonly fix?: string;
}

/**
 * How long a host may sit unchanged before it is worth saying so.
 *
 * Agent CLIs move several times a week, so a month without the file on
 * PATH changing is not a machine that happens to be current — it is one
 * nothing has updated. Deliberately generous: this is a report, and the
 * cost of being wrong is an update nobody needed rather than a host left
 * frozen for a season.
 */
export const AGENT_STALE_DAYS = 30;

/**
 * The providers whose allowance this section reports.
 *
 * One, and it is the one with a read path that costs no process — the
 * same provider the Redwall draws. A second name here would be a
 * permanent "unknown" line about a provider red-dev cannot read.
 */
export const AGENT_USAGE_PROVIDERS: readonly string[] = ["claude"];

export interface AgentPostureSeams {
  /** The recorded Default agent, verbatim. */
  readonly defaultAgent?: string | undefined;
  /** The agent hosts this machine selected, for the unset wording. */
  readonly selected?: readonly string[];
  /** The catalog to walk. Injected so a test needs no real host. */
  readonly hosts?: readonly AgentSpec[];
  readonly providers?: readonly string[];
  /** Where a host's command is on PATH, or null. */
  readonly locate?: (cmd: string) => string | null;
  /** When that file last changed, or null when it cannot be read. */
  readonly modifiedAtMs?: (path: string) => number | null;
  /** Where a provider's snapshot lives, so a test writes no real state. */
  readonly usagePath?: (provider: string) => string;
  /** The snapshot itself. A read, never a collect. */
  readonly usage?: (provider: string) => AgentUsageSnapshot | null;
  readonly nowMs?: number;
}

/** When a file last changed, with every way of not knowing as null. */
function modifiedAtMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Whole days, floored: "3 days ago" must not round a 3-day-old file to 4. */
function wholeDays(ms: number): number {
  return Math.floor(Math.max(ms, 0) / 86_400_000);
}

/**
 * A duration a person reads rather than converts.
 *
 * Coarse on purpose — nobody plans a session around the seconds, and a
 * reset time printed to the minute past a day out is precision the
 * snapshot it came from does not have.
 */
export function humanDuration(ms: number): string {
  const minutes = Math.max(Math.round(ms / 60_000), 0);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

/**
 * One installed host's freshness, from the age of what would run.
 *
 * The detail always carries the evidence and the status carries the
 * reading of it, which is what keeps this honest: red-dev has not asked
 * the publisher anything, and a line that said "out of date" would be
 * claiming it had.
 */
export function reportAgentFreshness(
  host: AgentSpec,
  writtenAtMs: number | null,
  nowMs: number,
): AgentPostureRow {
  if (writtenAtMs === null) {
    // Unreadable is not old, and reporting it as drift would send
    // someone updating a host that may well be current.
    return {
      name: host.label,
      status: "n/a",
      detail: "on PATH, and when its copy last changed cannot be read",
    };
  }
  const days = wholeDays(nowMs - writtenAtMs);
  if (days >= AGENT_STALE_DAYS) {
    return {
      name: host.label,
      status: "drift",
      detail: `the copy on PATH last changed ${days} day(s) ago`,
      fix: "red-dev agents update",
    };
  }
  return {
    name: host.label,
    status: "ok",
    detail: `the copy on PATH changed ${days} day(s) ago`,
  };
}

/** One window, spelled the way its provider spells it. */
function windowDetail(
  window: AgentUsageReading["windows"][number],
  nowMs: number,
): string {
  const resets = window.resetsAtMs === null
    ? "reset time not published"
    : window.resetsAtMs <= nowMs
      ? "resets now"
      : `resets in ${humanDuration(window.resetsAtMs - nowMs)}`;
  return `${window.kind} ${window.remainingPercent}% left, ${resets}`;
}

/**
 * One provider's allowance detail, or the honest absence of it.
 *
 * A spent window is `ok` rather than drift: an allowance nobody has left
 * is a fact about a week's work, not a fault in the machine, and
 * doctor's failure column is for things a person can act on here.
 */
export function reportAgentUsage(
  provider: string,
  reading: AgentUsageReading | null,
  nowMs: number,
): AgentPostureRow {
  const name = `${provider} usage`;
  if (reading === null || reading.windows.length === 0) {
    return {
      name,
      status: "n/a",
      detail: "unknown — no usage snapshot on this machine, or none recent enough to trust",
    };
  }
  const windows = reading.windows.map((window) => windowDetail(window, nowMs));
  return {
    name,
    status: "ok",
    detail: `${windows.join(" · ")} — observed ${humanDuration(nowMs - reading.updatedAtMs)} ago`,
  };
}

/**
 * The whole section, from what the machine already wrote down. PURE of
 * side effects: every default here opens a file or looks at PATH.
 */
export function agentPosture(seams: AgentPostureSeams = {}): AgentPostureRow[] {
  const nowMs = seams.nowMs ?? Date.now();
  const locate = seams.locate ?? commandPath;
  const written = seams.modifiedAtMs ?? modifiedAtMs;
  const usage = seams.usage ??
    ((provider: string): AgentUsageSnapshot | null =>
      agentUsageSnapshot({
        provider,
        ...(seams.usagePath ? { path: seams.usagePath(provider) } : {}),
      }));

  const hosts = seams.hosts ?? AGENTS;
  const found = hosts
    .filter((host) => host.cmd.length > 0)
    .map((host) => ({ host, path: locate(host.cmd) }))
    .filter((entry): entry is { host: AgentSpec; path: string } => entry.path !== null);
  const installed = (host: AgentSpec): boolean =>
    found.some((entry) => entry.host.key === host.key);

  const rows: AgentPostureRow[] = [];
  const chosen = reportDefaultAgent(
    readDefaultAgent(seams.defaultAgent, installed),
    seams.selected ?? [],
  );
  rows.push({
    name: "default agent",
    status: chosen.status,
    detail: chosen.detail,
    ...(chosen.fix ? { fix: chosen.fix } : {}),
  });

  if (found.length === 0) {
    rows.push({ name: "agent hosts", status: "n/a", detail: "none installed" });
  } else {
    for (const entry of found) {
      rows.push(reportAgentFreshness(entry.host, written(entry.path), nowMs));
    }
  }

  for (const provider of seams.providers ?? AGENT_USAGE_PROVIDERS) {
    rows.push(reportAgentUsage(provider, agentUsageReading(usage(provider), nowMs), nowMs));
  }
  return rows;
}

/**
 * The same section, for a caller that has a platform and no preferences
 * in hand — which is `doctor`.
 *
 * The preferences are read and never written back: the recorded choice
 * is evidence here, and a report that healed it would be making the
 * decision it exists to describe.
 */
export async function agentPostureFor(
  p: Platform,
  seams: AgentPostureSeams = {},
): Promise<AgentPostureRow[]> {
  const { readPreferences } = await import("./preferences.ts");
  const prefs = await readPreferences(p);
  return agentPosture({
    ...seams,
    defaultAgent: seams.defaultAgent ?? prefs.defaultAgent,
    selected: seams.selected ?? prefs.agents ?? [],
  });
}
