/**
 * The daemon's host-state, reduced to what Redwall draws from it.
 *
 * `redskilled host-state` answers with everything the RedSkills daemon knows
 * about this machine — ceilings, budgets, registrations, birth latches, the
 * version it is holding at. Redwall wants one number out of that document:
 * how many Workers are running right now. Everything else is read past.
 *
 * ## Absent is a value, not a failure
 *
 * The whole of this module is one rule: **never withhold half the
 * information because the other half is unavailable.** Redwall composes a
 * Worker count and a LAN address over the theme's art, and the address is
 * resolved without the daemon's help. So a daemon that is not running, a
 * document this build cannot parse, and a document whose version it does not
 * recognise all produce the same thing — `null`, meaning "no Worker count" —
 * and none of them throws. The Redwall that results carries the address
 * alone, which is the picture the Spec settled on twice.
 *
 * `null` is therefore load-bearing, and it is not the same value as
 * `{ workers: 0 }`. A host whose queue has drained reports zero; a host
 * whose daemon is gone reports nothing. Collapsing the two would draw the
 * same wallpaper for "the work is done" and "the machine went quiet", which
 * is the one distinction the daemon's own document was built to preserve.
 *
 * ## Why the version is checked at all
 *
 * The daemon's contract is frozen and serves checkouts pinned to different
 * bundle versions, so a red-dev built today will meet daemons older and
 * newer than itself. `version` and `protocol_version` are how the document
 * says which contract it was written against, and this build understands
 * exactly one of each. Reading a document that declares another would be
 * guessing that a field kept its meaning across a release that said it did
 * not — and a guess that is wrong draws a confident, false number on
 * someone's desktop.
 */

import { existsSync } from "node:fs";

/** The document shape this build reads. Not a floor: an exact match. */
export const HOST_STATE_VERSION = 1;

/** The wire contract this build reads. Exact for the same reason. */
export const HOST_STATE_PROTOCOL_VERSION = 1;

/** What Redwall takes from the daemon. `null` in place of this is "unknown". */
export interface HostState {
  /** Workers running on this machine right now; zero is a real answer. */
  readonly workers: number;
}

/**
 * The Worker count in a parsed host-state document, or null. PURE.
 *
 * Fail-closed by construction: every path that is not a document of the
 * exact version this build understands, carrying a Worker array, returns
 * null. `workers.length` rather than the `projects` block, because
 * `projects` is that same array grouped by label — one source, so the two
 * can never be seen to disagree — and rather than `ceiling.worker_count`,
 * which is what the machine would allow and not what it is running.
 */
export function hostStateFrom(value: unknown): HostState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state["version"] !== HOST_STATE_VERSION) return null;
  if (state["protocol_version"] !== HOST_STATE_PROTOCOL_VERSION) return null;
  const workers = state["workers"];
  if (!Array.isArray(workers)) return null;
  return { workers: workers.length };
}

/**
 * The same, from the JSON text the daemon printed. PURE.
 *
 * Text that is not JSON is a daemon that answered with something else — an
 * error line, a truncated write, a stub on a machine where the bundle was
 * never built. All of it means the same thing here, and none of it is worth
 * an exception the caller would have to catch to keep its address.
 */
export function parseHostState(text: string | null | undefined): HostState | null {
  if (text == null || text.trim() === "") return null;
  try {
    return hostStateFrom(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Produces the host-state document as text, or null when there is none. */
export type HostStateSource = () => Promise<string | null>;

/**
 * Ask for host-state and reduce it, or answer null.
 *
 * The source is injected so the two cases that matter — a daemon that is not
 * running and a daemon whose document this build cannot read — are testable
 * without a machine in either state. A source that rejects is caught here
 * rather than at the caller, because "the command is not installed" is the
 * ordinary condition on a machine that only ever wanted the wallpaper, and
 * an ordinary condition must not travel as an exception.
 */
export async function readHostState(
  source: HostStateSource = askRedskilled,
): Promise<HostState | null> {
  try {
    return parseHostState(await source());
  } catch {
    return null;
  }
}

/**
 * The default source: the `redskilled` entry point in the red-skills checkout.
 *
 * A read and only a read. `host-state` reaches for the daemon's socket and
 * never starts it, which is the property that lets a wallpaper regenerate
 * without a cosmetic feature becoming what births a machine-wide singleton.
 *
 * A checkout that is absent, or present without its built bundle, exits
 * non-zero or prints nothing — and both arrive here as null, which is the
 * same answer a stopped daemon gives. That is deliberate: red-dev has no
 * repair to offer for either, and the Redwall it draws is identical.
 */
async function askRedskilled(): Promise<string | null> {
  const home = (process.env["HOME"] ?? process.env["USERPROFILE"] ?? "").replace(/\\/g, "/");
  if (home === "") return null;
  const bin = `${home}/.red-skills/current/packaging/npm/bin/red-skills-redskilled.mjs`;
  if (!existsSync(bin)) return null;
  const proc = Bun.spawn(["node", bin, "host-state"], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? out : null;
}
