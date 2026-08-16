import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  agentProcessArgv,
  agentProcessTokens,
  agentUsagePath,
  agentUsageReading,
  agentUsageSnapshot,
  claudeUsageCollector,
  claudeUsageFromJson,
  readAgentUsage,
  type AgentUsageSnapshot,
  type UsageCollector,
} from "./agent-usage.ts";

const roots: string[] = [];

/** A throwaway machine-local state root, so no test reads the operator's. */
function stateRoot(): string {
  const root = mkdtempSync(`${tmpdir()}/red-dev-agent-usage-`);
  roots.push(root);
  return root;
}

function snapshotPath(): string {
  return `${stateRoot()}/agent-usage-claude.json`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const payload = readFileSync("src/fixtures/claude-usage.json", "utf8");
const NOW = Date.parse("2026-08-16T00:20:00Z");

function stale(updatedAtMs: number): AgentUsageSnapshot {
  return {
    schemaVersion: 1,
    provider: "claude",
    updatedAtMs,
    windows: [
      { kind: "five_hour", usedPercent: 71, resetsAtMs: 1_786_478_934_000 },
      { kind: "seven_day", usedPercent: 22, resetsAtMs: null },
    ],
  };
}

/** A collector that reports usage by starting an agent — the banned shape. */
function omarchyShapedCollector(argv: readonly string[]): UsageCollector & { calls: () => number } {
  let calls = 0;
  return {
    provider: "claude",
    plan: {
      provider: "claude",
      reads: [],
      endpoints: [],
      argv: [argv],
    },
    parse: claudeUsageFromJson,
    probe: async () => {
      calls++;
      return payload;
    },
    calls: () => calls,
  };
}

describe("agent usage collector", () => {
  test("reduces the provider payload to the displayed usage numbers", () => {
    const snapshot = claudeUsageFromJson(payload, NOW);

    expect(snapshot?.provider).toBe("claude");
    expect(agentUsageReading(snapshot, NOW)?.windows).toEqual([
      {
        kind: "five_hour",
        usedPercent: 42,
        remainingPercent: 58,
        resetsAtMs: Date.parse("2026-08-16T04:00:00Z"),
      },
      {
        kind: "seven_day",
        usedPercent: 13,
        remainingPercent: 87,
        resetsAtMs: Date.parse("2026-08-20T09:00:00Z"),
      },
      {
        kind: "seven_day_opus",
        usedPercent: 0,
        remainingPercent: 100,
        resetsAtMs: Date.parse("2026-08-20T09:00:00Z"),
      },
    ]);
  });

  test("rounds a barely-touched window up, never down to untouched", () => {
    expect(claudeUsageFromJson('{"five_hour":{"utilization":0.4}}', NOW)?.windows).toEqual([
      { kind: "five_hour", usedPercent: 1, resetsAtMs: null },
    ]);
  });

  test("writes one snapshot per provider under the state root and re-reads it", async () => {
    const root = stateRoot();
    const path = `${root}/agent-usage-claude.json`;
    let calls = 0;
    const collector: UsageCollector = {
      ...claudeUsageCollector({ home: root }),
      probe: async () => {
        calls++;
        return payload;
      },
    };

    const written = await readAgentUsage({ path, nowMs: NOW, collector });
    expect(written?.updatedAtMs).toBe(NOW);

    // The display contract: a separate reader, no refresh, same numbers.
    expect(agentUsageSnapshot({ path })).toEqual(written!);

    // Inside the TTL nothing is asked of the provider again.
    const fresh = await readAgentUsage({ path, nowMs: NOW + 14 * 60 * 1_000, collector });
    expect(calls).toBe(1);
    expect(fresh).toEqual(written!);

    // Past it, the probe runs once more and replaces the file atomically.
    const refreshed = await readAgentUsage({ path, nowMs: NOW + 16 * 60 * 1_000, collector });
    expect(calls).toBe(2);
    expect(refreshed?.updatedAtMs).toBe(NOW + 16 * 60 * 1_000);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(refreshed)}\n`);
  });

  test("names the snapshot after the provider, under machine-local state", () => {
    expect(agentUsagePath("claude").endsWith("/agent-usage-claude.json")).toBe(true);
  });

  test("prefers a stale snapshot to no snapshot when the refresh fails", async () => {
    const path = snapshotPath();
    const previous = stale(NOW - 30 * 60 * 1_000);
    writeFileSync(path, `${JSON.stringify(previous)}\n`);

    const found = await readAgentUsage({
      path,
      nowMs: NOW,
      collector: { ...claudeUsageCollector(), probe: async () => null },
    });

    // Thirty minutes old: past the refresh TTL, inside the honesty
    // ceiling — the case stale-preferred was built for.
    expect(found).toEqual(previous);
    expect(agentUsageReading(found, NOW)?.windows[0]?.remainingPercent).toBe(29);
  });

  test("a concurrent refresh reads the stale snapshot instead of probing", async () => {
    const path = snapshotPath();
    const previous = stale(NOW - 30 * 60 * 1_000);
    writeFileSync(path, `${JSON.stringify(previous)}\n`);
    writeFileSync(`${path}.lock`, "another red-dev owns this refresh\n");
    let calls = 0;

    const found = await readAgentUsage({
      path,
      nowMs: NOW,
      collector: {
        ...claudeUsageCollector(),
        probe: async () => {
          calls++;
          return payload;
        },
      },
    });

    expect(calls).toBe(0);
    expect(found).toEqual(previous);
  });

  test("an absent snapshot reads as unknown, never as zero remaining", () => {
    const path = snapshotPath();

    expect(agentUsageSnapshot({ path })).toBeNull();
    const reading = agentUsageReading(agentUsageSnapshot({ path }), NOW);
    expect(reading).toBeNull();
    // The failure this pins: unknown rendered as a spent allowance.
    expect(reading?.windows.map((window) => window.remainingPercent)).toBeUndefined();
  });

  test("an untrusted snapshot reads as unknown, never as zero remaining", () => {
    const path = snapshotPath();

    // Aged past the honesty ceiling.
    writeFileSync(path, `${JSON.stringify(stale(NOW - 10 * 60 * 60 * 1_000))}\n`);
    expect(agentUsageReading(agentUsageSnapshot({ path }), NOW)).toBeNull();

    // Half-readable: one window this schema does not vouch for.
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      provider: "claude",
      updatedAtMs: NOW,
      windows: [
        { kind: "five_hour", usedPercent: 71, resetsAtMs: null },
        { kind: "seven_day", usedPercent: 140, resetsAtMs: null },
      ],
    })}\n`);
    expect(agentUsageSnapshot({ path })).toBeNull();
    expect(agentUsageReading(agentUsageSnapshot({ path }), NOW)).toBeNull();

    // A future schema, and plain rubbish.
    writeFileSync(path, `${JSON.stringify({ ...stale(NOW), schemaVersion: 2 })}\n`);
    expect(agentUsageSnapshot({ path })).toBeNull();
    writeFileSync(path, "not json at all\n");
    expect(agentUsageSnapshot({ path })).toBeNull();
  });

  test("a payload with no readable window is unknown rather than a zero snapshot", async () => {
    const path = snapshotPath();

    expect(await readAgentUsage({
      path,
      nowMs: NOW,
      collector: { ...claudeUsageCollector(), probe: async () => '{"five_hour":{}}' },
    })).toBeNull();
    expect(agentUsageSnapshot({ path })).toBeNull();
  });

  test("the collect path builds no agent-process argv", () => {
    // The whole Claude path: a token off disk and one HTTPS question.
    const plan = claudeUsageCollector({ home: "/tmp/red-dev-nowhere" }).plan;

    expect(plan.argv).toEqual([]);
    expect(agentProcessArgv(plan)).toEqual([]);
    expect(plan.reads).toEqual(["/tmp/red-dev-nowhere/.claude/.credentials.json"]);
  });

  test("the same assertion fails against a collector that launches an agent", async () => {
    // Omarchy reads Codex usage by starting `codex app-server` and
    // talking to it. Under one status surface per repaint that is the
    // process factory this project removed, so the plan is refused
    // before the lock is taken and the probe never runs.
    for (const argv of [
      ["codex", "app-server"],
      ["/usr/local/bin/claude", "--print", "usage"],
      ["sh", "-lc", "codex app-server --json"],
      ["cmd.exe", "/c", "C:\\Users\\me\\bin\\gemini.exe"],
    ]) {
      const rogue = omarchyShapedCollector(argv);
      expect(agentProcessArgv(rogue.plan)).toEqual([argv]);

      const path = snapshotPath();
      expect(await readAgentUsage({ path, nowMs: NOW, collector: rogue })).toBeNull();
      expect(rogue.calls()).toBe(0);
      expect(agentUsageSnapshot({ path })).toBeNull();
    }
  });

  test("a refused plan still serves the stale snapshot rather than nothing", async () => {
    const path = snapshotPath();
    const previous = stale(NOW - 30 * 60 * 1_000);
    writeFileSync(path, `${JSON.stringify(previous)}\n`);
    const rogue = omarchyShapedCollector(["codex", "app-server"]);

    expect(await readAgentUsage({ path, nowMs: NOW, collector: rogue })).toEqual(previous);
    expect(rogue.calls()).toBe(0);
  });

  test("names agent binaries through paths, extensions and one-liners", () => {
    expect(agentProcessTokens(["gh", "api", "rate_limit"])).toEqual([]);
    expect(agentProcessTokens(["sh", "-lc", 'cat "$HOME/.claude/.credentials.json"'])).toEqual([]);
    expect(agentProcessTokens(["sh", "-lc", "codex app-server"])).toEqual(["codex"]);
    expect(agentProcessTokens(["C:/Program Files/redcode.exe"])).toEqual(["redcode"]);
  });

  test("authenticates from the token on disk and asks one bounded question", async () => {
    const root = stateRoot();
    const path = `${root}/agent-usage-claude.json`;
    writeFileSync(`${root}/.credentials.json`, JSON.stringify({
      claudeAiOauth: { accessToken: "sk-ant-oat-fixture", expiresAt: NOW + 60_000 },
    }));
    const asked: string[] = [];

    const found = await readAgentUsage({
      path,
      nowMs: NOW,
      collector: claudeUsageCollector({
        credentialsPath: `${root}/.credentials.json`,
        nowMs: NOW,
        fetchImpl: async (input, init) => {
          asked.push(String(input));
          const headers = new Headers(init?.headers);
          expect(headers.get("authorization")).toBe("Bearer sk-ant-oat-fixture");
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          return new Response(payload, { status: 200 });
        },
      }),
    });

    expect(asked).toEqual(["https://api.anthropic.com/api/oauth/usage"]);
    expect(found?.windows[0]).toEqual({
      kind: "five_hour",
      usedPercent: 42,
      resetsAtMs: Date.parse("2026-08-16T04:00:00Z"),
    });
  });

  test("an expired or missing token is unknown, and spends no deadline", async () => {
    const root = stateRoot();
    let requests = 0;
    const collector = (credentials: string | null): UsageCollector => {
      if (credentials !== null) writeFileSync(`${root}/.credentials.json`, credentials);
      return claudeUsageCollector({
        credentialsPath: `${root}/.credentials.json`,
        nowMs: NOW,
        fetchImpl: async () => {
          requests++;
          return new Response(payload, { status: 200 });
        },
      });
    };

    for (const credentials of [
      null,
      "{}",
      JSON.stringify({ claudeAiOauth: { accessToken: "expired", expiresAt: NOW - 1 } }),
    ]) {
      expect(await readAgentUsage({
        path: `${root}/agent-usage-claude.json`,
        nowMs: NOW,
        collector: collector(credentials),
      })).toBeNull();
    }
    expect(requests).toBe(0);
  });

  test("a provider that answers with an error is unknown, not empty", async () => {
    const root = stateRoot();
    writeFileSync(`${root}/.credentials.json`, JSON.stringify({
      claudeAiOauth: { accessToken: "sk-ant-oat-fixture" },
    }));

    expect(await readAgentUsage({
      path: `${root}/agent-usage-claude.json`,
      nowMs: NOW,
      collector: claudeUsageCollector({
        credentialsPath: `${root}/.credentials.json`,
        nowMs: NOW,
        fetchImpl: async () => new Response("upstream is having a moment", { status: 503 }),
      }),
    })).toBeNull();
  });
});
