import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  githubRatePercent,
  githubRatesFromHistoryJson,
  mergeGithubCredentialRates,
  readGithubRateLimit,
  readRedskilledGithubRates,
  type GithubRateSnapshot,
} from "./github-rate.ts";

const roots: string[] = [];

function cachePath(): string {
  const root = mkdtempSync(`${tmpdir()}/red-dev-github-rate-`);
  roots.push(root);
  return `${root}/github-rate-limit.json`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const response = JSON.stringify({
  resources: {
    core: { limit: 5000, remaining: 4759, used: 241, reset: 1786479561 },
    graphql: { limit: 5000, remaining: 0, used: 5000, reset: 1786478934 },
  },
});

describe("GitHub rate-limit snapshot", () => {
  test("reduces the PAT and optional App snapshots into four numbers", () => {
    const askedAt = "2026-08-12T20:30:00Z";
    expect(githubRatesFromHistoryJson(JSON.stringify([
      { pool: "rest", remaining: 4500, limit: 5000, asked_at: askedAt },
      { pool: "graphql", remaining: 3500, limit: 5000, asked_at: askedAt },
      { identity: "app:153309957", pool: "rest", remaining: 4900, limit: 5000, asked_at: askedAt },
      { identity: "app:153309957", pool: "graphql", remaining: 4250, limit: 5000, asked_at: askedAt },
    ]), Date.parse("2026-08-12T20:45:00Z"))).toEqual({
      pat: { api: 90, graphql: 70 },
      app: { api: 98, graphql: 85 },
    });
  });

  test("keeps github_app optional and refuses a fossil PAT snapshot", () => {
    const fossil = JSON.stringify([
      { pool: "rest", remaining: 5000, limit: 5000, asked_at: "2026-08-12T19:00:00Z" },
      { pool: "graphql", remaining: 5000, limit: 5000, asked_at: "2026-08-12T19:00:00Z" },
    ]);
    expect(githubRatesFromHistoryJson(
      fossil,
      Date.parse("2026-08-12T20:00:00Z"),
    )).toBeNull();
  });

  test("reads PAT and App from the identity-aware balance history", async () => {
    const path = cachePath();
    writeFileSync(path, "placeholder\n");
    const directory = path.slice(0, path.lastIndexOf("/"));
    writeFileSync(`${directory}/balance-history.toonl`, "toonl is converted by the injected tq\n");
    const history = JSON.stringify([
      { pool: "rest", remaining: 4500, limit: 5000, asked_at: "2026-08-12T20:30:00Z" },
      { pool: "graphql", remaining: 3500, limit: 5000, asked_at: "2026-08-12T20:30:00Z" },
      {
        identity: "app:153309957",
        pool: "rest",
        remaining: 4900,
        limit: 5000,
        asked_at: "2026-08-12T20:31:00Z",
      },
      {
        identity: "app:153309957",
        pool: "graphql",
        remaining: 4250,
        limit: 5000,
        asked_at: "2026-08-12T20:31:00Z",
      },
    ]);
    expect(await readRedskilledGithubRates({
      path: directory,
      nowMs: Date.parse("2026-08-12T20:45:00Z"),
      command: async () => ({
        exitCode: 0,
        stdout: history,
        stderr: "",
        timedOut: false,
        groupGone: true,
      }),
    })).toEqual({
      pat: { api: 90, graphql: 70 },
      app: { api: 98, graphql: 85 },
    });
  });

  test("merges domains by the tightest credential bucket instead of summing", () => {
    expect(mergeGithubCredentialRates([
      { pat: { api: 90, graphql: 80 }, app: { api: 70, graphql: 60 } },
      { pat: { api: 50, graphql: 85 }, app: null },
    ])).toEqual({
      pat: { api: 50, graphql: 80 },
      app: { api: 70, graphql: 60 },
    });
  });

  test("keeps REST and GraphQL separate and reports percent remaining", async () => {
    const snapshot = await readGithubRateLimit({
      path: cachePath(),
      nowMs: 1_786_478_321_000,
      probe: async () => response,
    });

    expect(snapshot?.core.remaining).toBe(4759);
    expect(snapshot?.graphql.remaining).toBe(0);
    expect(githubRatePercent(snapshot!.core)).toBe(95);
    expect(githubRatePercent(snapshot!.graphql)).toBe(0);
  });

  test("does not start another probe while the snapshot is fresh", async () => {
    const path = cachePath();
    let calls = 0;
    const first = await readGithubRateLimit({
      path,
      nowMs: 1_000_000,
      probe: async () => {
        calls++;
        return response;
      },
    });
    const second = await readGithubRateLimit({
      path,
      nowMs: 1_000_001,
      probe: async () => {
        calls++;
        return null;
      },
    });

    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  test("returns stale valid data when a refresh fails", async () => {
    const path = cachePath();
    const stale: GithubRateSnapshot = {
      schemaVersion: 1,
      updatedAtMs: 1,
      core: { limit: 5000, remaining: 4000, used: 1000, reset: 99 },
      graphql: { limit: 5000, remaining: 3000, used: 2000, reset: 99 },
    };
    writeFileSync(path, `${JSON.stringify(stale)}\n`);

    // Thirty minutes old: past the refresh TTL, inside the honesty
    // ceiling — the case stale-but-valid was built for.
    expect(await readGithubRateLimit({
      path,
      nowMs: 30 * 60 * 1_000,
      probe: async () => null,
    })).toEqual(stale);
  });

  test("refuses to serve a snapshot past the staleness ceiling", async () => {
    // The regression this guards: a probe that failed for ten hours
    // kept the Redwall showing a full budget while the fleet spent the
    // real one. Past the ceiling, "no data" is the honest answer.
    const path = cachePath();
    const fossil: GithubRateSnapshot = {
      schemaVersion: 1,
      updatedAtMs: 1,
      core: { limit: 5000, remaining: 4926, used: 74, reset: 99 },
      graphql: { limit: 5000, remaining: 4625, used: 375, reset: 99 },
    };
    writeFileSync(path, `${JSON.stringify(fossil)}\n`);

    expect(await readGithubRateLimit({
      path,
      nowMs: 10 * 60 * 60 * 1_000,
      probe: async () => null,
    })).toBeNull();
  });

  test("a fossil cache still refreshes when the probe answers", async () => {
    const path = cachePath();
    const fossil: GithubRateSnapshot = {
      schemaVersion: 1,
      updatedAtMs: 1,
      core: { limit: 5000, remaining: 4926, used: 74, reset: 99 },
      graphql: { limit: 5000, remaining: 4625, used: 375, reset: 99 },
    };
    writeFileSync(path, `${JSON.stringify(fossil)}\n`);

    const found = await readGithubRateLimit({
      path,
      nowMs: 10 * 60 * 60 * 1_000,
      probe: async () => response,
    });
    expect(found?.updatedAtMs).toBe(10 * 60 * 60 * 1_000);
  });

  test("a concurrent refresh reads stale cache instead of spawning", async () => {
    const path = cachePath();
    const stale: GithubRateSnapshot = {
      schemaVersion: 1,
      updatedAtMs: 1,
      core: { limit: 5000, remaining: 4000, used: 1000, reset: 99 },
      graphql: { limit: 5000, remaining: 3000, used: 2000, reset: 99 },
    };
    writeFileSync(path, `${JSON.stringify(stale)}\n`);
    writeFileSync(`${path}.lock`, "another red-dev owns this refresh\n");
    let calls = 0;

    const found = await readGithubRateLimit({
      path,
      nowMs: 20_000,
      probe: async () => {
        calls++;
        return response;
      },
    });

    expect(calls).toBe(0);
    expect(found).toEqual(stale);
  });

  test("rejects malformed provider output without poisoning the cache", async () => {
    const path = cachePath();
    expect(await readGithubRateLimit({
      path,
      nowMs: 1_000,
      probe: async () => '{"resources":{"core":{"limit":0}}}',
    })).toBeNull();
  });
});
