/**
 * The Default agent: the one installed agent host red-dev hands work to.
 *
 * A crash to diagnose, a launch shortcut, a profile's required host —
 * they all need a target, and until now each surface would have had to
 * guess one from whatever happened to be on PATH. A guess is not a
 * choice, and the difference shows the day a second host is installed
 * and the answer moves without anyone deciding it should.
 *
 * Two rules do the work here and they pull in opposite directions on
 * purpose:
 *
 *   - Where there is a real choice, ask. More than one CLI host means
 *     more than one plausible answer, and picking the first in a list is
 *     the guess this exists to remove.
 *   - Where there is no choice, say nothing. One CLI host is not a
 *     decision, and a question with one possible answer is noise.
 *
 * And once recorded it is never quietly replaced. A machine that has
 * lost claude-code reports claude-code as gone; it does not start
 * answering as codex, because the person who reads "default agent:
 * Codex CLI" has no way to tell that from a choice they made.
 *
 * See .red/contexts/agents/CONTEXT.md.
 */

import { AGENTS, currentAgentKeys, type AgentSpec } from "./agents.ts";

/**
 * Which hosts may be the Default agent.
 *
 * Desktop applications are out because red-dev hands work to a command
 * and they have none — that is what `cmd: ""` means. A multiplexer is
 * out because it runs agents rather than being one; see herdr's entry
 * in agents.ts, which says so in its own words.
 */
export function isDefaultAgentCandidate(a: AgentSpec): boolean {
  return !a.desktopOnly && !a.multiplexer && a.cmd.length > 0;
}

/** The hosts in a selection that could be the Default agent. */
export function defaultAgentCandidates(selected: readonly string[]): AgentSpec[] {
  const keys = currentAgentKeys(selected);
  return AGENTS.filter((a) => keys.includes(a.key) && isDefaultAgentCandidate(a));
}

/**
 * The Default agent a selection settles on by itself, or null when
 * there is something to ask.
 */
export function impliedDefaultAgent(selected: readonly string[]): string | null {
  const candidates = defaultAgentCandidates(selected);
  return candidates.length === 1 ? candidates[0]!.key : null;
}

/** Whether the person has to be asked which host is the Default agent. */
export function needsDefaultAgentChoice(selected: readonly string[]): boolean {
  return defaultAgentCandidates(selected).length > 1;
}

/**
 * What to record for a selection, given whatever answer was collected.
 *
 * An unanswered choice stays unanswered. Returning the first candidate
 * here would make the interview's question decorative — the recorded
 * value would be the same whether or not anyone looked at it.
 */
export function defaultAgentFrom(
  selected: readonly string[],
  answer?: string | undefined,
): string | undefined {
  const implied = impliedDefaultAgent(selected);
  if (implied) return implied;
  return defaultAgentCandidates(selected).some((a) => a.key === answer) ? answer : undefined;
}

export type DefaultAgentState =
  /** Nothing recorded. A legitimate state, not a fault. */
  | "unset"
  /** Recorded, known, and installed. */
  | "ready"
  /** Recorded and known, but no longer on this machine. */
  | "absent"
  /** Recorded and not a host red-dev can hand work to. */
  | "unknown";

export interface DefaultAgentReading {
  state: DefaultAgentState;
  /** The host the record resolves to, under its own name. */
  key: string | null;
  label: string | null;
  /** What was written down, verbatim, whatever became of it. */
  recorded: string | null;
}

/**
 * Read the recorded choice against the installed set.
 *
 * The installed test is injected rather than reached for, so a caller
 * that already knows what is present does not probe PATH again — and so
 * this is answerable in a test without installing an agent.
 */
export function readDefaultAgent(
  stored: string | undefined,
  installed: (a: AgentSpec) => boolean,
): DefaultAgentReading {
  const recorded = typeof stored === "string" ? stored.trim() : "";
  if (recorded === "") return { state: "unset", key: null, label: null, recorded: null };

  // Through currentAgentKeys, so a selection recorded before OpenCode
  // was renamed resolves to RedCode. That is the same host under a new
  // name, which is the one substitution that is not a replacement.
  const key = currentAgentKeys([recorded])[0];
  const spec = AGENTS.find((a) => a.key === key);
  if (!spec || !isDefaultAgentCandidate(spec)) {
    return { state: "unknown", key: null, label: null, recorded };
  }
  return {
    state: installed(spec) ? "ready" : "absent",
    key: spec.key,
    label: spec.label,
    recorded,
  };
}

export interface DefaultAgentReport {
  status: "ok" | "drift" | "n/a";
  detail: string;
  /** What to run. Omitted when there is nothing to do. */
  fix?: string;
}

/**
 * The recorded choice as a line `doctor` can print.
 *
 * Unset is `n/a` rather than drift: the Default agent is allowed to be
 * unset, and a machine nobody has answered for should not report a
 * fault for a question it was never asked.
 */
export function reportDefaultAgent(
  reading: DefaultAgentReading,
  selected: readonly string[],
): DefaultAgentReport {
  switch (reading.state) {
    case "ready":
      return { status: "ok", detail: `${reading.label} (${reading.key})` };
    case "absent":
      // Named under the recorded host and nothing else. Suggesting a
      // replacement here is one keystroke away from performing one.
      return {
        status: "drift",
        detail: `${reading.label} is recorded and no longer installed`,
        fix: `red-dev agents ${reading.key} — or choose another: red-dev agents default <key>`,
      };
    case "unknown":
      return {
        status: "drift",
        detail: `'${reading.recorded}' is not a host red-dev can hand work to`,
        fix: "red-dev agents default <key>",
      };
    case "unset": {
      const candidates = defaultAgentCandidates(selected);
      if (candidates.length === 0) return { status: "n/a", detail: "no CLI agent host selected" };
      return {
        status: "n/a",
        detail: `not chosen — red-dev agents default <${candidates.map((a) => a.key).join("|")}>`,
      };
    }
  }
}
