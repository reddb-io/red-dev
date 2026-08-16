/**
 * Handing a crash to the Default agent with the evidence already
 * assembled.
 *
 * The alternative is the one everybody has lived through: red-dev dies,
 * the person opens an agent, and the agent asks them what happened. So
 * the diagnosis starts from a re-description — of a stack nobody read,
 * of a run whose transcript is sitting on disk, on a machine the agent
 * has no facts about. Every one of those four things is already written
 * down at the moment of the crash, which is exactly when nobody has the
 * patience to go and find them.
 *
 * So the brief carries all four: the crash entry and where the rest of
 * them live, the transcript of the run that died, this machine's
 * platform census, and a pointer at the Product skill — which is the
 * document that tells the agent what the paths in the other three mean.
 * See src/product-skill.ts and .red/contexts/agents/CONTEXT.md.
 *
 * ## Declining is a decision, not a postponement
 *
 * An offer that returns after every crash is a nag, and a nag is how a
 * feature meant to help becomes the thing people work around. `no` is
 * recorded in preferences and honoured from then on, and it is honoured
 * before anything else here runs — a machine whose owner said no does
 * not get its hosts resolved or its brief assembled.
 *
 * red-dev stays fully usable with no agent at all. A machine with no
 * Default agent captures the crash exactly as before and says nothing
 * about agents, because "install one" is not an answer to "it crashed".
 */

import { resolveLaunch, type LaunchTarget } from "./agent-launch.ts";
import type { CrashCapture } from "./crash.ts";
import type { Preferences } from "./preferences.ts";
import { PRODUCT_SKILL_NAME, SKILL_HOMES } from "./product-skill.ts";

/**
 * How much of a crash entry the brief carries inline.
 *
 * The whole file is not the brief: crash.log accumulates every crash
 * this machine has had, and the entry itself can be a deep stack. What
 * goes inline is the end of this crash — the frames nearest the failure
 * — and the path, so an agent that wants the rest reads it rather than
 * being handed it.
 */
export const BRIEF_ENTRY_LINES = 40;

/** Everything the brief is written from. Assembled by the caller. */
export interface CrashEvidence {
  /** The red-dev that died, so a brief identifies its own build. */
  version: string;
  capture: CrashCapture;
  /** The run that crashed, when a transcript was open for it. */
  transcript: string | null;
  /** What `red-dev platform` says about this machine. */
  census: string;
  /** Where the host reads the Product skill, when it is installed. */
  skill: string | null;
}

/**
 * Where a host reads the Product skill from. PURE.
 *
 * Read off SKILL_HOMES rather than composed here, so the pointer in the
 * brief cannot drift from the path the skill is actually written to. A
 * host red-dev does not put the skill into gets null, and the brief says
 * so instead of naming a file that is not there — a document an agent
 * cannot open is worse than an admission that there is none.
 */
export function productSkillPointer(agent: string, home: string | null): string | null {
  const skillHome = SKILL_HOMES.find((h) => h.agent === agent);
  if (!skillHome || !home) return null;
  return `${skillHome.dir(home.replace(/\\/g, "/"))}/${PRODUCT_SKILL_NAME}/SKILL.md`;
}

/** The end of a crash entry, which is the part nearest the failure. */
function tail(entry: string, lines: number): string {
  const all = entry.split("\n").filter((line) => line.trim().length > 0);
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

/**
 * The brief, as the agent receives it.
 *
 * Written as instructions rather than as a report, because it is a
 * prompt: it says what happened, where the evidence is, and what to
 * read first. It deliberately does not diagnose — a brief that guesses
 * at the cause is a brief that anchors the agent on the guess.
 */
export function crashBrief(e: CrashEvidence): string {
  const entry = tail(e.capture.entry, BRIEF_ENTRY_LINES);
  const truncated = entry.split("\n").length < e.capture.entry.trim().split("\n").length;

  return [
    `red-dev ${e.version} crashed on this machine (${e.capture.kind}). Everything known`,
    "about it is below — diagnose it from this evidence rather than asking me to",
    "describe what happened.",
    "",
    "## The crash",
    "",
    `Every crash on this machine is appended to \`${e.capture.path}\`.`,
    truncated
      ? `The end of the entry this run wrote — the full stack is in that file:`
      : "The entry this run wrote:",
    "",
    entry.replace(/^/gm, "    "),
    "",
    "## The run",
    "",
    e.transcript
      ? [
        `The transcript of the run that crashed is \`${e.transcript}\`. It opens with`,
        "the version, the time and the platform, and its converge steps are",
        "fixed-width rows — `grep failed` over it is the whole technique for",
        "finding what went wrong before the stack did.",
      ].join("\n")
      : [
        "No transcript was open for this run, so there is none to read. Read-only",
        "commands do not write one on purpose; a mutating command would have.",
      ].join("\n"),
    "",
    "## The machine",
    "",
    "What `red-dev platform` reports here:",
    "",
    e.census.replace(/^/gm, "    "),
    "",
    "## What red-dev is",
    "",
    e.skill
      ? [
        `Read the \`${PRODUCT_SKILL_NAME}\` skill first — \`${e.skill}\` — for where this`,
        "machine keeps managed configuration and state, which commands report it,",
        "and which acts need administrator. `red-dev doctor` is the first command",
        "to run; it changes nothing.",
      ].join("\n")
      : [
        `The \`${PRODUCT_SKILL_NAME}\` skill is not installed for this host, so the paths`,
        "above are all there is to go on. `red-dev doctor` is the first command to",
        "run; it changes nothing.",
      ].join("\n"),
    "",
  ].join("\n");
}

export type CrashHandoffPlan =
  /** There is a host to offer, and a command line ready for it. */
  | { state: "offer"; target: LaunchTarget }
  /** Nothing is offered, and the reason is always said. */
  | { state: "silent"; reason: string };

/** The preferences this reads. A narrow view, so a test can hold one. */
export type CrashHandoffPreferences = Pick<
  Preferences,
  "defaultAgent" | "agents" | "crashHandoff"
>;

/**
 * Whether the offer was declined for good.
 *
 * `=== false` rather than a truthy read, for the reason
 * `resolveRedwall` gives: this is JSON a person can open, and a decline
 * written as a string should not be read as one — nor should absent,
 * which is a machine that has never been asked.
 */
export function crashHandoffDeclined(prefs: CrashHandoffPreferences): boolean {
  return prefs.crashHandoff === false;
}

/**
 * What to do about a captured crash, decided before anything is asked.
 * PURE, given a PATH lookup.
 *
 * The order is the doctrine. A recorded decline wins over everything,
 * including a perfectly good Default agent — that is what "honoured"
 * means. Then a session nobody is watching, which is a reason to stay
 * quiet and *not* a decline: a crash in CI must not silently answer a
 * question on behalf of the person who owns the machine. Only then the
 * host, resolved through resolveLaunch so this surface cannot name one
 * red-dev has not been told to use.
 */
export function planCrashHandoff(
  brief: string,
  prefs: CrashHandoffPreferences,
  deps: { locate: (command: string) => string | null; interactive: boolean },
): CrashHandoffPlan {
  if (crashHandoffDeclined(prefs)) {
    return { state: "silent", reason: "the offer was declined once and is not made again" };
  }
  if (!deps.interactive) {
    return { state: "silent", reason: "nobody to ask on a non-interactive run" };
  }

  // The brief travels in the passthrough slot — the one reserved for
  // what the person typed after `--`. It is a prompt and never a flag,
  // so what agent-launch.ts guards stays empty: red-dev adds no
  // argument of its own to a host's command line, here least of all.
  const decision = resolveLaunch(prefs, deps.locate, [brief]);
  if (!decision.ok) return { state: "silent", reason: decision.detail };
  return { state: "offer", target: decision.target };
}

export type CrashHandoffOutcome =
  | { state: "handed"; key: string; label: string }
  /** Asked and answered no. Recorded, so it is asked once. */
  | { state: "declined" }
  /** Never asked. The reason is what planCrashHandoff decided. */
  | { state: "silent"; reason: string }
  /** Asked, accepted, and the host did not start. */
  | { state: "failed"; reason: string };

/** Every side of the machine the offer touches, so a test can hold all of them. */
export interface CrashHandoffDeps {
  prefs: CrashHandoffPreferences;
  locate: (command: string) => string | null;
  interactive: boolean;
  ask: (question: string) => Promise<boolean>;
  /** Records the decline. Merged into preferences, never a rewrite. */
  remember: (patch: { crashHandoff: boolean }) => Promise<void>;
  /** Hands the terminal to the host. */
  start: (target: LaunchTarget) => Promise<number>;
  say?: (line: string) => void;
}

/**
 * Offer the crash to the Default agent, and honour the answer.
 *
 * Only a `no` is written down. An accepted offer records nothing on
 * purpose: saying yes to this crash is not a standing instruction to
 * launch an agent at the next one, and a preference that appeared
 * because someone accepted once would be a decision they never made.
 */
export async function offerCrashHandoff(
  evidence: CrashEvidence,
  deps: CrashHandoffDeps,
): Promise<CrashHandoffOutcome> {
  const brief = crashBrief(evidence);
  const plan = planCrashHandoff(brief, deps.prefs, {
    locate: deps.locate,
    interactive: deps.interactive,
  });
  if (plan.state === "silent") return plan;

  const { target } = plan;
  if (!(await deps.ask(`Hand this crash to ${target.label} to diagnose?`))) {
    // Written before anything else can fail, so the answer survives even
    // if the rest of this run does not.
    await deps.remember({ crashHandoff: false });
    deps.say?.(
      `not asked again — turn it back on by removing "crashHandoff" from red-dev.json`,
    );
    return { state: "declined" };
  }

  try {
    await deps.start(target);
    return { state: "handed", key: target.key, label: target.label };
  } catch (err) {
    // A host that would not start is reported and nothing more. The
    // crash is already on disk, which was always the durable half.
    return { state: "failed", reason: (err as Error).message };
  }
}

/**
 * The offer as this machine answers it.
 *
 * Every dependency resolved here rather than at the crash handler, and
 * every module reached by dynamic import: this runs once a process is
 * already dying, and nothing above it should pay for agent hosts,
 * preferences and skills homes on a run that never crashes.
 */
export async function handOffCrash(capture: CrashCapture, version: string): Promise<
  CrashHandoffOutcome
> {
  const [
    { commandPath },
    { runLaunchTarget },
    { detect, summary },
    { readPreferences, writePreferences },
    { transcriptPath },
    { confirm, interactive },
  ] = await Promise.all([
    import("./agents.ts"),
    import("./agent-launch.ts"),
    import("./platform.ts"),
    import("./preferences.ts"),
    import("./transcript.ts"),
    import("./ui.ts"),
  ]);

  const p = detect();
  const prefs = await readPreferences(p);
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? null;

  return await offerCrashHandoff(
    {
      version,
      capture,
      transcript: transcriptPath(),
      census: summary(p),
      skill: prefs.defaultAgent ? productSkillPointer(prefs.defaultAgent, home) : null,
    },
    {
      prefs,
      locate: commandPath,
      interactive: interactive(),
      ask: (question) => confirm(question, false),
      remember: (patch) => writePreferences(p, patch),
      start: runLaunchTarget,
      say: (line) => process.stderr.write(`${line}\n`),
    },
  );
}
