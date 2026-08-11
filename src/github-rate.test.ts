import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  githubRatePercent,
  readGithubRateLimit,
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

    expect(await readGithubRateLimit({
      path,
      nowMs: 9_999_999,
      probe: async () => null,
    })).toEqual(stale);
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
