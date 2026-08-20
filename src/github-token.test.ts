/**
 * Signing in with what the machine already has.
 *
 * 60 anonymous API requests an hour, per IP, shared with mise and with
 * anything else on the network — and a converge spends one per
 * gh-provided tool. The failure a person sees is `GitHub API 403 …
 * rate limited, set GITHUB_TOKEN` on a machine where `gh` has been
 * logged in for months.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  forgetGithubToken,
  githubAuthHeaders,
  githubToken,
  rateLimitAdvice,
} from "./github-token.ts";

afterEach(forgetGithubToken);

/** A `gh auth token` that answers whatever the test says. */
function gh(stdout: string, status = 0) {
  const calls: string[][] = [];
  const run = ((cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return { status, stdout, stderr: "", pid: 1, output: [], signal: null };
  }) as unknown as typeof import("node:child_process").spawnSync;
  return { run, calls };
}

describe("which token is sent", () => {
  test("an explicit GITHUB_TOKEN wins, because somebody meant it", () => {
    const { run, calls } = gh("gho_fromCli\n");
    expect(githubToken({ GITHUB_TOKEN: "ghp_explicit" }, run)).toBe("ghp_explicit");
    // And `gh` is not even asked: a subprocess for an answer already held.
    expect(calls).toEqual([]);
  });

  test("GH_TOKEN is honoured too, which is what gh itself reads", () => {
    const { run } = gh("gho_fromCli\n");
    expect(githubToken({ GH_TOKEN: "ghp_env" }, run)).toBe("ghp_env");
  });

  test("otherwise the gh CLI is asked, and its answer trimmed", () => {
    const { run, calls } = gh("gho_fromCli\n");
    expect(githubToken({}, run)).toBe("gho_fromCli");
    expect(calls).toEqual([["gh", "auth", "token"]]);
  });

  test("is asked once per process, not once per repository", () => {
    // A converge resolves a release for every gh-provided tool; each
    // one spawning `gh auth token` would be a subprocess for an answer
    // that cannot have changed.
    const { run, calls } = gh("gho_fromCli\n");
    githubToken({}, run);
    githubToken({}, run);
    githubToken({}, run);
    expect(calls).toHaveLength(1);
  });

  test("a gh that is absent, logged out or empty is simply no token", () => {
    for (const [stdout, status] of [["", 0], ["", 1], ["   \n", 0]] as const) {
      forgetGithubToken();
      const { run } = gh(stdout, status);
      expect(githubToken({}, run)).toBeNull();
    }
  });

  test("an empty environment variable does not count as set", () => {
    const { run } = gh("gho_fromCli\n");
    expect(githubToken({ GITHUB_TOKEN: "   " }, run)).toBe("gho_fromCli");
  });
});

describe("the header", () => {
  test("is a bearer when there is a token, and absent when there is none", () => {
    const { run } = gh("gho_fromCli\n");
    expect(githubAuthHeaders({}, run)).toEqual({ Authorization: "Bearer gho_fromCli" });
    forgetGithubToken();
    const none = gh("", 1);
    expect(githubAuthHeaders({}, none.run)).toEqual({});
  });
});

describe("what a 403 is told to do about itself", () => {
  test("names the cure when anonymous, and does not when signed in", () => {
    expect(rateLimitAdvice(false)).toContain("gh auth login");
    expect(rateLimitAdvice(false)).toContain("GITHUB_TOKEN");
    // Telling somebody to set a token they already sent is the advice
    // that wastes an afternoon.
    expect(rateLimitAdvice(true)).not.toContain("GITHUB_TOKEN");
    expect(rateLimitAdvice(true)).toContain("resets hourly");
  });
});

describe("the token never outlives the run", () => {
  test("nothing writes it to disk, a log or a child's environment", async () => {
    const source = await Bun.file(new URL("./github-token.ts", import.meta.url)).text();
    expect(source).not.toContain("writeFile");
    expect(source).not.toContain("log.");
    // Read, sent as a header, forgotten. A token in a state file is a
    // token that outlives the run that needed it.
    expect(source).not.toContain("process.env[\"GITHUB_TOKEN\"] =");
  });
});
