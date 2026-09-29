import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Platform } from "./platform.ts";
import {
  UPDATE_CHECK_INTERVAL_MS,
  curatedToolNames,
  parseOutdated,
  readUpdateState,
  refreshUpdateState,
  updateCheckDue,
} from "./update-state.ts";

const UBUNTU: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false },
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "red-updates-"));
  roots.push(dir);
  return dir;
};

const OUTDATED = JSON.stringify({
  claude: { name: "claude", requested: "latest", current: "2.1.284", latest: "2.1.290" },
  "red-router": { name: "red-router", current: "0.37.0", latest: "0.38.0" },
  // Somebody's own runtime: theirs to update, never ours to report.
  node: { name: "node", current: "26.9.0", latest: "26.10.0" },
  // Not behind at all.
  codex: { name: "codex", current: "0.159.0", latest: "0.159.0" },
  // No latest known.
  herdr: { name: "herdr", current: "1.0.0" },
});

describe("what red-dev curates", () => {
  test("is the fragment's tools by spec and alias, plus the agents mise owns", () => {
    const names = curatedToolNames(UBUNTU);
    expect(names.has("red-router")).toBe(true);
    expect(names.has("npm:@reddb-io/red-router")).toBe(true);
    expect(names.has("claude")).toBe(true);
    expect(names.has("codex")).toBe(true);
    expect(names.has("kubectl")).toBe(false);
  });
});

describe("parsing mise outdated", () => {
  const curated = new Set(["claude", "codex", "herdr", "red-router"]);

  test("keeps only curated tools that are really behind, sorted", () => {
    expect(parseOutdated(OUTDATED, curated)).toEqual([
      { name: "claude", current: "2.1.284", latest: "2.1.290" },
      { name: "red-router", current: "0.37.0", latest: "0.38.0" },
    ]);
  });

  test("reads nothing from output that is not an object of tools", () => {
    expect(parseOutdated("not json", curated)).toEqual([]);
    expect(parseOutdated("[]", curated)).toEqual([]);
    expect(parseOutdated("null", curated)).toEqual([]);
    expect(parseOutdated("{}", curated)).toEqual([]);
  });
});

describe("asking again", () => {
  test("is due with no record, after the interval, and when the clock went backwards", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    expect(updateCheckDue(null, now)).toBe(true);
    expect(updateCheckDue({ checkedAt: new Date(now - 60_000).toISOString(), outdated: [] }, now)).toBe(false);
    expect(updateCheckDue({ checkedAt: new Date(now - UPDATE_CHECK_INTERVAL_MS).toISOString(), outdated: [] }, now)).toBe(true);
    expect(updateCheckDue({ checkedAt: new Date(now + 60_000).toISOString(), outdated: [] }, now)).toBe(true);
  });
});

describe("refreshing the state", () => {
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", timedOut: false, groupGone: true });

  test("writes the curated list with the release-age exemption on the call", async () => {
    const path = join(temp(), "state", "updates.json");
    const seen: Record<string, string | undefined>[] = [];
    const state = await refreshUpdateState(UBUNTU, {
      path,
      nowMs: Date.parse("2026-09-29T12:00:00Z"),
      run: async (argv, env) => {
        expect(argv).toEqual(["mise", "outdated", "--json"]);
        seen.push(env);
        return ok(OUTDATED);
      },
    });

    expect(state?.outdated.map((tool) => tool.name)).toEqual(["claude", "red-router"]);
    expect(readUpdateState(path)).toEqual(state);
    expect(seen[0]?.["MISE_MINIMUM_RELEASE_AGE_EXCLUDES"]).toContain("claude");
    expect(seen[0]?.["MISE_FETCH_REMOTE_VERSIONS_CACHE"]).toBe("0s");
  });

  test("does not ask inside the interval", async () => {
    const path = join(temp(), "updates.json");
    const now = Date.parse("2026-09-29T12:00:00Z");
    writeFileSync(path, JSON.stringify({ checkedAt: new Date(now - 60_000).toISOString(), outdated: [] }));
    const state = await refreshUpdateState(UBUNTU, {
      path,
      nowMs: now,
      run: async () => { throw new Error("must not run"); },
    });
    expect(state?.outdated).toEqual([]);
  });

  test("keeps what it knew when mise fails or times out", async () => {
    const path = join(temp(), "updates.json");
    const before = { checkedAt: "2026-09-28T00:00:00.000Z", outdated: [{ name: "claude", current: "1", latest: "2" }] };
    writeFileSync(path, JSON.stringify(before));
    const now = Date.parse("2026-09-29T12:00:00Z");

    expect(await refreshUpdateState(UBUNTU, { path, nowMs: now, run: async () => ({ ...ok(""), exitCode: 1 }) })).toEqual(before);
    expect(await refreshUpdateState(UBUNTU, { path, nowMs: now, run: async () => ({ ...ok(""), timedOut: true }) })).toEqual(before);
    expect(await refreshUpdateState(UBUNTU, { path, nowMs: now, run: async () => { throw new Error("no mise"); } })).toEqual(before);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(before);
  });
});
