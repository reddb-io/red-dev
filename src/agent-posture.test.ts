/**
 * The agent posture `doctor` reports, and the two things it may not do.
 *
 * Three questions are answered here and none of them is answered by
 * asking a vendor: which host red-dev hands work to, how old each
 * installed host's copy is, and how much of each provider's allowance is
 * left with the reset times the Redwall card has no room for.
 *
 * The claim under test is that reporting is all this does. `doctor` is
 * the command people run when a machine is already misbehaving, and a
 * doctor that authenticates, takes a collector's lock or rewrites a
 * preference is a diagnostic that changes the patient. So the collect
 * path is asserted absent three ways — no network call, not one byte
 * written, and nothing in the module that names an entry point which
 * could do either.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentUsageSnapshot } from "./agent-usage.ts";
import {
  agentPosture,
  AGENT_STALE_DAYS,
  type AgentPostureRow,
} from "./agent-posture.ts";
import { AGENTS } from "./agents.ts";

const dir = mkdtempSync(`${tmpdir()}/red-dev-agent-posture-`);
const NOW = 1_760_000_000_000;
const DAY = 86_400_000;

/** A `locate` that answers for the named hosts and for nothing else. */
function locates(...keys: string[]): (cmd: string) => string | null {
  const commands = new Set(
    AGENTS.filter((agent) => keys.includes(agent.key)).map((agent) => agent.cmd),
  );
  return (cmd) => (commands.has(cmd) ? `/opt/agents/${cmd}` : null);
}

/** Every host's copy written the same number of days ago. */
function written(daysAgo: number): () => number {
  return () => NOW - daysAgo * DAY;
}

const snapshot: AgentUsageSnapshot = {
  schemaVersion: 1,
  provider: "claude",
  updatedAtMs: NOW - 60_000,
  windows: [
    { kind: "five_hour", usedPercent: 42, resetsAtMs: NOW + 2 * 3_600_000 + 1_800_000 },
    { kind: "seven_day", usedPercent: 18, resetsAtMs: null },
  ],
};

function posture(
  overrides: Parameters<typeof agentPosture>[0] = {},
): AgentPostureRow[] {
  return agentPosture({
    nowMs: NOW,
    locate: locates(),
    modifiedAtMs: () => null,
    usage: () => null,
    ...overrides,
  });
}

function row(rows: AgentPostureRow[], name: string): AgentPostureRow {
  const found = rows.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no '${name}' row in ${rows.map((r) => r.name).join(", ")}`);
  return found;
}

describe("the Default agent", () => {
  test("is reported under its own name and key when it is installed", () => {
    const rows = posture({
      defaultAgent: "codex",
      selected: ["claude-code", "codex"],
      locate: locates("claude-code", "codex"),
      modifiedAtMs: written(1),
    });
    const found = row(rows, "default agent");
    expect(found.status).toBe("ok");
    expect(found.detail).toContain("Codex CLI");
    expect(found.detail).toContain("codex");
  });

  test("is still reported under its own name once the host is gone", () => {
    // The failure this pins is a doctor that agrees with the machine by
    // changing the answer: a recorded host that has been uninstalled is
    // named, never replaced by whichever host is still there.
    const rows = posture({
      defaultAgent: "claude-code",
      selected: ["claude-code", "codex"],
      locate: locates("codex"),
      modifiedAtMs: written(1),
    });
    const found = row(rows, "default agent");
    expect(found.status).toBe("drift");
    expect(found.detail).toContain("Claude Code");
    expect(found.detail).not.toContain("Codex");
    expect(found.fix).toContain("red-dev agents claude-code");
  });

  test("is not a fault on a machine nobody has answered for", () => {
    const found = row(posture({ selected: ["claude-code", "codex"] }), "default agent");
    expect(found.status).toBe("n/a");
    expect(found.detail).toContain("red-dev agents default");
  });
});

describe("agent freshness", () => {
  test("is the age of the copy on PATH, reported per installed host", () => {
    const rows = posture({
      locate: locates("claude-code", "codex"),
      modifiedAtMs: written(3),
    });
    const found = row(rows, "Claude Code");
    expect(found.status).toBe("ok");
    expect(found.detail).toContain("3 day(s) ago");
    expect(rows.some((candidate) => candidate.name === "Codex CLI")).toBe(true);
    // A host that is not on this machine is not a row: doctor reports
    // the hosts that are installed, and eleven "not installed" lines
    // would bury the two that are.
    expect(rows.some((candidate) => candidate.name === "Gemini CLI")).toBe(false);
  });

  test("is drift once a host that moves weekly has stopped moving", () => {
    const found = row(
      posture({ locate: locates("claude-code"), modifiedAtMs: written(AGENT_STALE_DAYS + 5) }),
      "Claude Code",
    );
    expect(found.status).toBe("drift");
    expect(found.detail).toContain(`${AGENT_STALE_DAYS + 5} day(s)`);
    expect(found.fix).toBe("red-dev agents update");
  });

  test("is unknown rather than stale when the copy cannot be read", () => {
    // Unreadable is not old. Reporting it as drift would send someone
    // updating a host that may well be current.
    const found = row(
      posture({ locate: locates("claude-code"), modifiedAtMs: () => null }),
      "Claude Code",
    );
    expect(found.status).toBe("n/a");
    expect(found.detail).toContain("cannot be read");
    expect(found.fix).toBeUndefined();
  });

  test("says so plainly when this machine carries no host at all", () => {
    const found = row(posture(), "agent hosts");
    expect(found.status).toBe("n/a");
    expect(found.detail).toContain("none installed");
  });
});

describe("agent usage", () => {
  test("is the per-window detail, with the reset times the card has no room for", () => {
    const found = row(posture({ usage: () => snapshot }), "claude usage");
    expect(found.status).toBe("ok");
    expect(found.detail).toContain("five_hour 58% left");
    expect(found.detail).toContain("resets in 2h 30m");
    // A window the provider gave no reset for says that, rather than
    // borrowing the reset of the window beside it.
    expect(found.detail).toContain("seven_day 82% left");
    expect(found.detail).toContain("reset time not published");
    // Stale-but-honest is the contract, so the age of the observation is
    // part of the reading rather than an implied "just now".
    expect(found.detail).toContain("observed 1m ago");
  });

  test("is unknown where there is no snapshot, and never a number", () => {
    const found = row(posture({ usage: () => null }), "claude usage");
    expect(found.status).toBe("n/a");
    expect(found.detail).toContain("unknown");
    expect(found.detail).not.toMatch(/\d+%/);
  });

  test("is unknown for a snapshot too old to vouch for", () => {
    // An hour is the ceiling agent-usage.ts sets on stale-but-honest,
    // and doctor does not refresh what has passed it.
    const aged = { ...snapshot, updatedAtMs: NOW - 3_600_000 };
    const found = row(posture({ usage: () => aged }), "claude usage");
    expect(found.status).toBe("n/a");
    expect(found.detail).toContain("unknown");
  });
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("reporting the posture", () => {
  test("collects nothing: no network, and not one byte written", () => {
    const path = `${dir}/agent-usage-claude.json`;
    writeFileSync(path, `${JSON.stringify(snapshot)}\n`);
    const before = readFileSync(path, "utf8");
    const listing = readdirSync(dir).sort();

    let calls = 0;
    globalThis.fetch = ((): never => {
      calls += 1;
      throw new Error("doctor reached the network to report agent usage");
    }) as unknown as typeof fetch;

    const rows = agentPosture({
      nowMs: NOW,
      defaultAgent: "claude-code",
      selected: ["claude-code"],
      locate: locates("claude-code"),
      modifiedAtMs: written(2),
      // The real reader, against a real file, so this is the collect
      // path's own leavings that the assertions below would catch.
      usagePath: (provider) => `${dir}/agent-usage-${provider}.json`,
    });

    expect(row(rows, "claude usage").status).toBe("ok");
    expect(calls).toBe(0);
    // A `.lock` while a collector holds one, a `.tmp` mid-write, a
    // rewritten snapshot: the directory is exactly as it was found.
    expect(readdirSync(dir).sort()).toEqual(listing);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("reads an absent snapshot without creating one", () => {
    const path = `${dir}/agent-usage-nobody.json`;
    expect(existsSync(path)).toBe(false);
    const rows = agentPosture({
      nowMs: NOW,
      locate: locates(),
      modifiedAtMs: () => null,
      providers: ["nobody"],
      usagePath: (provider) => `${dir}/agent-usage-${provider}.json`,
    });
    expect(row(rows, "nobody usage").status).toBe("n/a");
    expect(existsSync(path)).toBe(false);
  });

  test("cannot collect or mutate: nothing in its path names an entry point that could", () => {
    // The behavioural tests above prove this run did not. This is what
    // keeps it true — `readAgentUsage` is a probe, a lock and a write,
    // and `writePreferences` is the mutation a report has no business
    // performing.
    const src = readFileSync(`${import.meta.dir}/agent-posture.ts`, "utf8");
    expect(src).toContain("agentUsageSnapshot");
    expect(src).toContain("agentUsageReading");
    expect(src).not.toContain("readAgentUsage");
    expect(src).not.toContain("claudeUsageCollector");
    expect(src).not.toContain("writePreferences");
    expect(src).not.toContain("writeFileSync");
    expect(src).not.toContain("Bun.spawn");
  });

  test("is what doctor prints, under a section of its own", () => {
    const src = readFileSync(`${import.meta.dir}/main.ts`, "utf8");
    expect(src).toContain('log.plain("\\n[agents]")');
    expect(src).toContain("agentPostureFor(p)");
  });
});
