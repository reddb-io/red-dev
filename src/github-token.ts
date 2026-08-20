/**
 * The GitHub token this machine can already prove it has.
 *
 * Unauthenticated API requests are limited to 60 an hour **per IP**, and
 * a converge spends several: one release lookup per `gh`-provided tool.
 * Share that IP with a `mise` doing its own lookups — which is every
 * machine red-dev converges — and the limit is reached in an ordinary
 * morning. What the operator then sees is two providers failing with
 * `GitHub API 403 ... rate limited, set GITHUB_TOKEN` on a machine where
 * `gh` has been logged in for months.
 *
 * Because that is the gap: red-dev read `GITHUB_TOKEN` from its own
 * environment and nothing else, while the `gh` CLI — a tool red-dev
 * installs itself, from its own manifest — was sitting there holding a
 * token for the same account. Asking it turns 60 requests an hour into
 * 5,000.
 *
 * ## Asked once, and never written down
 *
 * The answer is memoised for the life of the process: a converge asks
 * for several repositories and `gh auth token` is a subprocess. It is
 * deliberately not cached to disk, not logged, and not put into any
 * child's environment — it is read, used as a header against
 * api.github.com, and forgotten when the process ends. A token in a log
 * or a state file is a token that outlives the run that needed it.
 *
 * `GITHUB_TOKEN` and `GH_TOKEN` still win, in that order, because an
 * operator who set one meant it — CI sets the first, and `gh` itself
 * honours the second.
 */

import { spawnSync } from "node:child_process";

/** Cleared only by the process ending. `undefined` means "not asked yet". */
let memo: string | null | undefined;

/** Exported for the tests, which must not inherit one run's answer. */
export function forgetGithubToken(): void {
  memo = undefined;
}

/**
 * `gh auth token`, or null.
 *
 * Bounded and quiet: `gh` may be absent, logged out, or slow to answer
 * on a machine with no network, and none of those is an error worth
 * reporting — the caller simply makes an unauthenticated request, which
 * is what it did before this existed.
 */
function tokenFromGh(run = spawnSync): string | null {
  try {
    const result = run("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    if (result.status !== 0) return null;
    const token = (result.stdout ?? "").trim();
    return token.length > 0 ? token : null;
  } catch {
    // No `gh` on PATH is the ordinary case on a machine mid-converge.
    return null;
  }
}

/** The token to send, or null to ask anonymously. */
export function githubToken(
  env: NodeJS.ProcessEnv = process.env,
  run: typeof spawnSync = spawnSync,
): string | null {
  const explicit = env["GITHUB_TOKEN"] ?? env["GH_TOKEN"];
  if (explicit && explicit.trim().length > 0) return explicit.trim();

  if (memo === undefined) memo = tokenFromGh(run);
  return memo;
}

/** The Authorization header, or nothing. Never logged by any caller. */
export function githubAuthHeaders(
  env: NodeJS.ProcessEnv = process.env,
  run: typeof spawnSync = spawnSync,
): Record<string, string> {
  const token = githubToken(env, run);
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}

/** What to tell somebody a 403 means, given what we were able to send. */
export function rateLimitAdvice(authenticated: boolean): string {
  return authenticated
    ? " — rate limited even signed in; the limit resets hourly"
    : " — rate limited. Run `gh auth login`, or set GITHUB_TOKEN";
}
