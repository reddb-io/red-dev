/**
 * Who started this run, and what that entitles it to.
 *
 * red-dev has one converge and six ways in: a person typing a command, a
 * shell's PROMPT_COMMAND, a systemd timer, a Windows Scheduled Task, a
 * mise postinstall hook, and the RedSkills daemon. Until this file existed
 * the converge could not tell them apart — `src/main.ts` computed
 * `force: selector !== "due"`, which skips a debounce, and threw the rest
 * away. So every automatic trigger inherited a person's full authority.
 *
 * What that cost, on the machine that found it: a ten-minute timer that
 * was entitled to add an apt repository, import a GPG key and
 * `apt-get install code` into a WSL distro — unattended, to place an
 * extension the Windows half had already installed. Twenty consecutive
 * failures, and the run that hung took six minutes and forty seconds.
 *
 * ## The rule
 *
 * An **attended** run may do anything red-dev can do. An **unattended**
 * one may acquire, verify, activate and wire the machine *from what is
 * already on it* — and may not reach a package manager, may not ask for
 * privilege, and may not block without a deadline. What it declines is a
 * `skip` naming the command a person should type, never a failure: the
 * machine is not broken, it deferred.
 *
 * ## How it is decided
 *
 * A launcher we generate says so outright — the systemd unit, the `.cmd`
 * wrapper, the mise plugin script and the shell hook all set
 * `RED_DEV_TRIGGER`. Anything else is inferred from whether a terminal is
 * attached, and inferred *conservatively*: no terminal means no person,
 * and a run that cannot be sure defaults to unattended. Being wrong in
 * that direction costs a `skip` and a line telling somebody what to type.
 * Being wrong in the other direction is what this file was written for.
 */

export const TRIGGERS = [
  "typed",
  "shell",
  "timer",
  "task",
  "mise",
  "daemon",
  /** The WSL half poking the Windows half — see `crossToWindows`. */
  "cross",
  "unknown",
] as const;

export type Trigger = (typeof TRIGGERS)[number];

/** The variable a generated launcher stamps itself with. */
export const TRIGGER_ENV = "RED_DEV_TRIGGER";

/** One `NAME=value` pair for a launcher to carry. PURE. */
export function triggerEnv(trigger: Trigger): Record<string, string> {
  return { [TRIGGER_ENV]: trigger };
}

/**
 * What started this run. PURE.
 *
 * `tty` is passed rather than read so the decision is testable off a
 * terminal — which is, pointedly, the condition this whole file is about.
 */
export function triggerOf(env: NodeJS.ProcessEnv, tty: boolean): Trigger {
  const named = env[TRIGGER_ENV];
  if (named !== undefined && (TRIGGERS as readonly string[]).includes(named)) {
    return named as Trigger;
  }
  return tty ? "typed" : "unknown";
}

/**
 * Whether a person is at the keyboard for this run. PURE.
 *
 * Only a typed command counts. A prompt hook is the closest call and is
 * deliberately excluded: a person is at the keyboard, but the process is
 * detached with all three streams on `/dev/null`, so anything it started
 * that wanted an answer would wait forever against nobody.
 */
export function attended(trigger: Trigger): boolean {
  return trigger === "typed";
}

/**
 * One sentence for a surface that declined, naming the way out. PURE.
 *
 * Every unattended refusal says the same two things — what was not done,
 * and the command that would do it — because a `skip` nobody can act on
 * is the silence this file replaces.
 */
export function deferred(what: string, command: string): string {
  return `${what} — no person is watching this run; \`${command}\` does it`;
}
