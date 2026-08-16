/**
 * Agent usage as a cached observation, one snapshot per provider.
 *
 * This is the GitHub rate-limit collector's shape applied to the agent
 * hosts: the same TTL, the same exclusive lock, the same preference for
 * stale-but-honest data over a blank surface. What is new is the thing
 * it refuses to do. Omarchy's Codex collector reads usage by starting
 * an agent process and talking to it; doing that here would rebuild the
 * process factory this project spent a release removing, once per
 * repaint. So the collect path is declared up front as a read plan, and
 * a plan that names an agent binary is refused before anything runs —
 * the guard sits on the live path, not only in a test.
 *
 * The first provider is the one with a cheap read path: Claude reads a
 * token already on disk and asks one bounded HTTPS question. No
 * subprocess of any kind is involved, which is the strongest form of
 * the guarantee. Providers whose only path is an agent process stay
 * unreported — unknown is an honest answer, a guessed number is not.
 *
 * Display surfaces call `agentUsageSnapshot` and `agentUsageReading`;
 * neither refreshes, neither blocks, and both answer `null` — unknown —
 * for a provider that has no snapshot or whose snapshot has aged out.
 * Nothing here ever reports an unknown allowance as zero remaining.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AGENTS } from "./agents.ts";
import { transcriptDir } from "./transcript.ts";

// Deliberately the GitHub collector's numbers. Two status collectors
// that age differently are two behaviours an operator has to hold in
// their head to read one wallpaper.
const TTL_MS = 15 * 60 * 1_000;
const STALE_LOCK_MS = 30_000;
/** The ceiling past which stale-but-valid stops being either. */
const MAX_STALE_MS = 60 * 60 * 1_000;
/** One probe's whole budget. A status surface never waits on a provider. */
const PROBE_TIMEOUT_MS = 2_000;

/** One provider-defined allowance window, as the provider reports it. */
export interface AgentUsageWindow {
  /** The provider's own name for the window, e.g. `five_hour`. */
  readonly kind: string;
  /** Percent of the window consumed, 0-100. */
  readonly usedPercent: number;
  /** When the window rolls over, or null when the provider omits it. */
  readonly resetsAtMs: number | null;
}

export interface AgentUsageSnapshot {
  readonly schemaVersion: 1;
  readonly provider: string;
  readonly updatedAtMs: number;
  readonly windows: readonly AgentUsageWindow[];
}

/**
 * Everything a collect path touches, declared before it runs.
 *
 * `argv` exists to be asserted empty rather than to be executed. A
 * collector that wants a subprocess has to say so here, and saying so
 * is what gets it refused.
 */
export interface UsageReadPlan {
  readonly provider: string;
  /** Files read directly, with no process in between. */
  readonly reads: readonly string[];
  /** HTTPS endpoints the probe may ask, each under one deadline. */
  readonly endpoints: readonly string[];
  /** Subprocesses the collect path would start. Empty by construction. */
  readonly argv: readonly (readonly string[])[];
}

export interface UsageCollector {
  readonly provider: string;
  readonly plan: UsageReadPlan;
  /** Provider seam. Null is any unavailable, failed or timed-out probe. */
  readonly probe: () => Promise<string | null>;
  /** Raw provider bytes to a snapshot, or null when they are not usable. */
  readonly parse: (raw: string, nowMs: number) => AgentUsageSnapshot | null;
}

export interface AgentUsageOptions {
  /** Cache location; injectable so tests never touch the operator's state. */
  readonly path?: string;
  /** Frozen clock for cache and lock tests. */
  readonly nowMs?: number;
  readonly collector?: UsageCollector;
}

/**
 * The narrow slice of `fetch` a probe is allowed. Narrow on purpose:
 * the global's own type carries runtime-specific extras a test double
 * would have to invent, and a collector needs one bounded GET.
 */
export type UsageFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClaudeUsageOptions {
  /** Where `.claude` lives; injectable so tests never read a real token. */
  readonly home?: string;
  readonly credentialsPath?: string;
  /** Network seam, so no test can reach api.anthropic.com by accident. */
  readonly fetchImpl?: UsageFetch;
  readonly nowMs?: number;
}

/** What a display surface may render for one window. */
export interface AgentUsageWindowReading {
  readonly kind: string;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly resetsAtMs: number | null;
}

/** A trusted reading. `null` from `agentUsageReading` means unknown. */
export interface AgentUsageReading {
  readonly provider: string;
  readonly updatedAtMs: number;
  readonly windows: readonly AgentUsageWindowReading[];
}

/** Agent host binaries, taken from the install specs so they cannot drift. */
const AGENT_COMMANDS: ReadonlySet<string> = new Set(
  AGENTS.map((agent) => agent.cmd).filter((cmd) => cmd !== ""),
);

/**
 * Every token in an argv that names an agent host binary. PURE.
 *
 * Split and basename-reduced rather than compared whole, because the
 * shapes worth catching hide the name: an absolute path, a `.exe`, a
 * `sh -lc "codex app-server"` one-liner. Over-matching here costs a
 * collector nothing — it only has to not name an agent.
 */
export function agentProcessTokens(argv: readonly string[]): string[] {
  return argv
    .flatMap((word) => word.split(/[\s;|&()"']+/))
    .map((token) => token.replace(/\\/g, "/").split("/").pop() ?? "")
    .map((token) => token.replace(/\.(?:exe|cmd|bat|ps1)$/i, ""))
    .filter((token) => AGENT_COMMANDS.has(token));
}

/** The argv entries of a plan that would launch an agent. PURE. */
export function agentProcessArgv(plan: UsageReadPlan): readonly (readonly string[])[] {
  return plan.argv.filter((argv) => agentProcessTokens(argv).length > 0);
}

/** One snapshot per provider, under machine-local state. */
export function agentUsagePath(provider: string): string {
  return `${transcriptDir()}/agent-usage-${provider.replace(/[^a-z0-9-]/gi, "-")}.json`;
}

export function claudeCredentialsPath(
  home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "",
): string {
  return `${home.replace(/\\/g, "/")}/.claude/.credentials.json`;
}

const CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
/** The windows Claude reports, in the order a surface should show them. */
const CLAUDE_WINDOWS = ["five_hour", "seven_day", "seven_day_opus"] as const;

function validNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function resetsAtMs(value: unknown): number | null {
  // Providers spell this either way; an unparseable reset costs the
  // reset time, not the window.
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value < 1e11 ? value * 1_000 : value);
  }
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function usageWindow(kind: string, value: unknown): AgentUsageWindow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const found = value as Record<string, unknown>;
  const used = found["utilization"];
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return null;
  // Rounded up, so a window that is 0.4% spent never reads as untouched.
  // The conservative direction is the one an operator can plan against.
  return { kind, usedPercent: Math.ceil(used), resetsAtMs: resetsAtMs(found["resets_at"]) };
}

/** Reduce Claude's usage payload to the displayed numbers. PURE. */
export function claudeUsageFromJson(raw: string, nowMs: number): AgentUsageSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const found = parsed as Record<string, unknown>;
  const windows = CLAUDE_WINDOWS
    .map((kind) => usageWindow(kind, found[kind]))
    .filter((window): window is AgentUsageWindow => window !== null);
  // No window read is unknown, and unknown is never written down as a
  // snapshot: a stored empty reading would display as a full allowance.
  return windows.length === 0
    ? null
    : { schemaVersion: 1, provider: "claude", updatedAtMs: nowMs, windows };
}

/**
 * The OAuth token Claude Code already stores for itself.
 *
 * Read straight off disk, which is what makes this the cheap path. On
 * macOS the same token lives in the Keychain and would need a helper
 * process to reach; that host is not a target here, and a provider we
 * cannot read cheaply is reported unknown rather than worked around.
 */
function claudeAccessToken(path: string, nowMs: number): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const oauth = parsed["claudeAiOauth"];
    if (typeof oauth !== "object" || oauth === null) return null;
    const found = oauth as Record<string, unknown>;
    const token = found["accessToken"];
    const expiresAt = found["expiresAt"];
    if (typeof token !== "string" || token === "") return null;
    // An expired token is a 401 we can decline to spend a deadline on.
    if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= nowMs) {
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

/** Claude's collector: one file read, one bounded request, no subprocess. */
export function claudeUsageCollector(options: ClaudeUsageOptions = {}): UsageCollector {
  const path = options.credentialsPath ?? claudeCredentialsPath(options.home);
  return {
    provider: "claude",
    plan: {
      provider: "claude",
      reads: [path],
      endpoints: [CLAUDE_USAGE_ENDPOINT],
      argv: [],
    },
    parse: claudeUsageFromJson,
    probe: async () => {
      const token = claudeAccessToken(path, options.nowMs ?? Date.now());
      if (token === null) return null;
      try {
        const response = await (options.fetchImpl ?? fetch)(CLAUDE_USAGE_ENDPOINT, {
          headers: {
            authorization: `Bearer ${token}`,
            "anthropic-beta": "oauth-2025-04-20",
            "anthropic-version": "2023-06-01",
          },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return response.ok ? await response.text() : null;
      } catch {
        return null;
      }
    },
  };
}

function snapshotWindow(value: unknown): AgentUsageWindow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const found = value as Record<string, unknown>;
  const kind = found["kind"];
  const used = found["usedPercent"];
  const resets = found["resetsAtMs"];
  if (
    typeof kind !== "string" || kind === "" ||
    typeof used !== "number" || !Number.isInteger(used) || used < 0 || used > 100 ||
    !(resets === null || validNonNegative(resets))
  ) return null;
  return { kind, usedPercent: used, resetsAtMs: resets === null ? null : resets };
}

function parseSnapshot(raw: string): AgentUsageSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const provider = parsed["provider"];
    const windows = parsed["windows"];
    if (
      parsed["schemaVersion"] !== 1 || typeof provider !== "string" || provider === "" ||
      !validNonNegative(parsed["updatedAtMs"]) || !Array.isArray(windows)
    ) return null;
    const read = windows.map(snapshotWindow);
    // One unreadable window makes the whole file untrusted. Partial
    // trust is how a surface ends up rendering half a reading as if it
    // were the whole allowance.
    if (read.length === 0 || read.some((window) => window === null)) return null;
    return {
      schemaVersion: 1,
      provider,
      updatedAtMs: parsed["updatedAtMs"],
      windows: read as AgentUsageWindow[],
    };
  } catch {
    return null;
  }
}

/**
 * Read a provider's snapshot without refreshing it. PURE of side effects.
 *
 * This is the whole display contract: a surface reads a file or gets
 * null. It never authenticates, never waits on a provider, and never
 * discovers that a wallpaper repaint made a network call.
 */
export function agentUsageSnapshot(
  options: { readonly provider?: string; readonly path?: string } = {},
): AgentUsageSnapshot | null {
  const path = options.path ?? agentUsagePath(options.provider ?? "claude");
  try {
    return existsSync(path) ? parseSnapshot(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

/**
 * The displayed numbers, or null for unknown.
 *
 * Absent, malformed and aged-out all answer the same way, and that
 * answer is never a number. A provider whose allowance we cannot vouch
 * for reads as unknown; it does not read as spent, and it does not read
 * as full.
 */
export function agentUsageReading(
  snapshot: AgentUsageSnapshot | null,
  nowMs = Date.now(),
): AgentUsageReading | null {
  if (snapshot === null || snapshot.windows.length === 0) return null;
  if (nowMs - snapshot.updatedAtMs >= MAX_STALE_MS) return null;
  return {
    provider: snapshot.provider,
    updatedAtMs: snapshot.updatedAtMs,
    windows: snapshot.windows.map((window) => ({
      kind: window.kind,
      usedPercent: window.usedPercent,
      remainingPercent: 100 - window.usedPercent,
      resetsAtMs: window.resetsAtMs,
    })),
  };
}

function cached(path: string): AgentUsageSnapshot | null {
  try {
    return parseSnapshot(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function acquire(path: string, nowMs: number): number | null {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const tryOpen = (): number | null => {
    try {
      return openSync(lock, "wx", 0o600);
    } catch {
      return null;
    }
  };

  const first = tryOpen();
  if (first !== null) return first;
  try {
    if (nowMs - statSync(lock).mtimeMs <= STALE_LOCK_MS) return null;
    unlinkSync(lock);
  } catch {
    return null;
  }
  return tryOpen();
}

function release(path: string, fd: number): void {
  try {
    closeSync(fd);
  } finally {
    try {
      unlinkSync(`${path}.lock`);
    } catch {
      // A lock disappearing early is harmless; the descriptor was still ours.
    }
  }
}

function save(path: string, snapshot: AgentUsageSnapshot): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Refresh one provider's snapshot, at most once across concurrent callers.
 *
 * Collectors call this; display surfaces do not. The order of the
 * refusals is the contract: fresh cache short-circuits before any work,
 * a plan naming an agent binary is refused before the lock, and every
 * later failure falls back to the last snapshot that is still honest.
 */
export async function readAgentUsage(
  options: AgentUsageOptions = {},
): Promise<AgentUsageSnapshot | null> {
  const collector = options.collector ?? claudeUsageCollector();
  const path = options.path ?? agentUsagePath(collector.provider);
  const nowMs = options.nowMs ?? Date.now();
  const previous = existsSync(path) ? cached(path) : null;
  if (previous && nowMs - previous.updatedAtMs < TTL_MS) return previous;
  // What a failed refresh may fall back to. Distinct from `previous`
  // because the TTL check above and the fallbacks below answer
  // different questions: "is this fresh enough to skip the probe" vs
  // "is this honest enough to show when the probe fails".
  const fallback = previous && nowMs - previous.updatedAtMs < MAX_STALE_MS ? previous : null;

  // The line the process-exhaustion incident bought. A collect path
  // that names an agent binary does not run, whatever it promises the
  // reading would be worth.
  if (agentProcessArgv(collector.plan).length > 0) return fallback;

  const fd = acquire(path, nowMs);
  if (fd === null) return fallback;
  try {
    const raw = await collector.probe();
    if (raw === null) return fallback;
    const next = collector.parse(raw, nowMs);
    if (next === null || next.provider !== collector.provider) return fallback;
    save(path, next);
    return next;
  } finally {
    release(path, fd);
  }
}
