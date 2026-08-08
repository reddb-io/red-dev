/**
 * One place that turns "this could not run because it lacked rights"
 * into a single named, actionable outcome.
 *
 * Two platforms asking the same question, and until now only one of them
 * had an answer. Ubuntu asks it through `sudo`, which can be probed
 * without blocking, and the branch that handles the refusal already read
 * well: one line naming the cause, one line naming the single command to
 * run first, and the promise that re-running costs nothing. Windows asks
 * it through UAC, which cannot be answered at all once a run is under
 * way — the prompt lands on the secure desktop, where a remote session
 * cannot reach it — and eleven modules invoke PowerShell, each inventing
 * its own wording for the refusal or saying nothing at all.
 *
 * So the Windows case becomes the Linux one's sibling: same shape, same
 * place, different instruction. The sudo strings here are the exact
 * bytes providers.ts used to hold, and a test pins them as such; this is
 * a widening of a branch that works, not a rewrite of it.
 *
 * The reason to centralise is the operator, not us. Eleven wordings for
 * the same outcome teach the same rule eleven times, one failure at a
 * time. One wording teaches it once.
 *
 * This is deliberately a classification and nothing more. It does not
 * elevate, prompt, or decide what to skip — a provider that raises its
 * own consent prompt is how the single-prompt guarantee gets broken
 * quietly, and that machinery belongs to the batch, not here.
 */

/** Which gate the work could not pass. */
export type Gate = "sudo" | "administrator";

/**
 * A named outcome, not a failure.
 *
 * Kept in three pieces because callers lay it out differently: a gate
 * that stops the run throws `message`, while an item that carries on
 * without its privileged half prints `cause` beside its own name and
 * `remedy` under it, at whatever indent that log already uses.
 */
export interface MissingRights {
  /** The gate that refused. */
  gate: Gate;
  /** One line naming why the work stopped, with no remedy in it. */
  cause: string;
  /** One line naming what the operator must do to finish. */
  remedy: string;
  /** Both, laid out the way the converge prints a two-line message. */
  message: string;
}

/**
 * The continuation indent of a converge message.
 *
 * Six spaces, matching the width of the `warn`/`fail` badge the log
 * puts in front of a first line, so the second line starts under the
 * first word rather than under the badge.
 */
const INDENT = "      ";

/**
 * The wording, and the only copy of it.
 *
 * Both halves say the same three things in the same order: what could
 * not happen, the one command that fixes it, and that coming back is
 * safe. The sudo pair is load-bearing text rather than a phrasing
 * choice — it is what the Linux path has always printed.
 */
const WORDING: Record<Gate, { cause: string; remedy: string }> = {
  sudo: {
    cause: "sudo needs a password and nothing here can supply one.",
    remedy: "Run `sudo -v` first, then re-run red-dev — or run it as root.",
  },
  administrator: {
    cause: "this needs administrator and nothing here can raise it.",
    remedy: "Start an elevated PowerShell first, then re-run red-dev — re-running is safe.",
  },
};

/** The outcome for a gate that is known to have refused. */
export function missingRights(gate: Gate): MissingRights {
  const { cause, remedy } = WORDING[gate];
  return { gate, cause, remedy, message: `${cause}\n${INDENT}${remedy}` };
}

/**
 * How each gate spells a refusal, lower-cased for comparison.
 *
 * Windows has no single spelling. One product, several components, and
 * a capability, a service and a firewall rule each report the same
 * missing right differently — which is precisely why deciding this once
 * beats deciding it at eleven call sites.
 *
 * The list is matched loosely on purpose in one direction only: a tell
 * that is missing here yields the generic failure the caller would have
 * produced anyway, while a tell that is too eager would send an operator
 * to elevate a shell that changes nothing and bury the real cause under
 * a remedy. Erring towards the first is recoverable; the second is not.
 */
const REFUSALS: Record<Gate, string[]> = {
  sudo: [
    "a password is required",
    "no tty present",
    "a terminal is required",
    "is not in the sudoers file",
    "may not run",
  ],
  administrator: [
    "access is denied",
    "access to the path is denied",
    "requires elevation",
    "permissiondenied",
    "unauthorizedaccessexception",
    "registry access is not allowed",
    "run as administrator",
    "securityexception",
  ],
};

/**
 * Did this command fail for lack of rights, or for some other reason?
 *
 * `null` is the important answer. A converge that blames elevation for
 * every non-zero exit is no more useful than one that never mentions
 * it, so the caller keeps its own reporting for everything else and
 * only defers to the shared outcome when the output says so.
 */
export function classifyRights(output: string, gate: Gate): MissingRights | null {
  const haystack = output.toLowerCase();
  const refused = REFUSALS[gate].some((tell) => haystack.includes(tell));
  return refused ? missingRights(gate) : null;
}
