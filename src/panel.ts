/**
 * What every Panel is made of, before any subsystem has been named.
 *
 * The network Panel arrived first and carried all of this inside itself,
 * which was the right shape while there was one. There are three now —
 * network, audio, power — and a second copy of "which CLI answers for
 * this machine" is exactly how two Panels end up disagreeing about WSL.
 * So the vocabulary lives here, and each Panel is what is left once the
 * shape is taken out of it: the commands it builds, and what the answers
 * to those commands mean.
 *
 * ## The two rules every Panel keeps
 *
 * Looking is never privileged. Not "usually is not" — never, checkably,
 * by reading the words of every command observation builds. `PanelPlan`
 * carries the claim as `gate` and `raisesRights` reads the argv that
 * actually runs, so a plan cannot say `null` while quietly carrying a
 * `sudo`. A Panel that raised a consent prompt to *show* something would
 * teach people to dismiss consent prompts, and the next one is the one
 * that changes the machine.
 *
 * And where an act does need rights, the Panel asks inline, at that
 * moment — never by queueing the act into `red-dev privileged`, the
 * converge's single-consent batch (decision of 2026-08-15,
 * `interaction/CONTEXT.md`). The batch exists so that "make this machine
 * correct" costs one prompt at the end of a long run. A Panel act
 * belongs to neither that run nor that prompt.
 *
 * The corollary is the one that is easy to get wrong in the other
 * direction: an act that does *not* need rights must not ask for them.
 * Two of the three Panels turn out to need nothing — `pactl`,
 * `powerprofilesctl` and `powercfg` all act on the signed-in person's
 * own session — and a Panel that raised a password prompt anyway,
 * because the first one did, would erode consent from the same end.
 *
 * ## And the limit that is declared rather than hidden
 *
 * Some subsystem has no first-party CLI on some target — audio devices
 * and bluetooth on native Windows are the ones red-dev has met. There
 * the act opens the host's own panel and says why, which is what
 * `NativeFallback` is: a surface to open and a reason to print beside
 * it. The alternative is a red-dev Panel with a list of devices in it
 * and no way to switch between them, which is worse than the limit.
 */

import type { Platform } from "./platform.ts";
import type { Gate } from "./rights.ts";

/**
 * The two adapters a Panel has.
 *
 * Not one per `Env`: Ubuntu desktop and an Ubuntu server drive the same
 * binaries, and WSL drives the Windows ones. Darwin and an unknown OS
 * are absent deliberately, failing closed as `providerFor` does and as
 * ADR 0001 requires.
 */
export type PanelTarget = "linux" | "windows";

/**
 * Which CLI answers for this machine, or nothing when none does.
 *
 * Windows first, and WSL with it, in the same order `hostNetState` asks
 * the question — a WSL distro is `os: "linux"`, so testing Linux first
 * would send it to `nmcli`, which is not installed and would not be
 * describing the right machine if it were.
 *
 * WSL folds into `windows` for every subsystem, for a different reason
 * each time and the same reason underneath: the distro is not where the
 * hardware is. It has no NetworkManager and its `/etc/resolv.conf` is
 * generated from the host. Its audio reaches WSLg's PulseAudio bridge,
 * so `pactl` does answer inside it — and switching WSLg's default sink
 * would change nothing about which speaker plays, because the endpoint
 * is chosen on the Windows side. And it has no battery at all.
 */
export function panelTarget(p: Platform): PanelTarget | null {
  if (p.os === "windows" || p.env === "wsl") return "windows";
  if (p.os === "linux") return "linux";
  return null;
}

// ----------------------------------------------------------- the plans

/**
 * What a Panel would run, decided before anything runs.
 *
 * The same split `firePlan` makes, for the same reason: a plan can be
 * read by a test, and a refusal arrives as a sentence for the status
 * line rather than as a process that failed off screen.
 */
export interface PanelPlan {
  /**
   * The one visible ask that raises the rights, before the acts.
   *
   * `sudo -v` where a gate needs a password, so it is typed once, in the
   * ordinary terminal, at the moment the operator asked — the same shape
   * `primeSudoInteractive` uses before the installer takes the screen.
   * Null on Windows, where consent is not a separate question: the UAC
   * dialog is raised by the act itself and cannot be raised early. Null
   * too for every act that passes no gate, which is most of them.
   */
  prime: readonly string[] | null;
  /** The acts, in order, each already carrying the rights it needs. */
  steps: readonly (readonly string[])[];
  /** Which gate those acts pass, or null when they pass none. */
  gate: Gate | null;
  /** One line, for the status line under the list. */
  note: string;
}

/**
 * Does this argv ask the machine for rights?
 *
 * Read off the words rather than taken on trust, because the claim worth
 * pinning is about what runs. Both spellings of each gate are here: the
 * Linux elevators as argv[0], and Windows' consent verb as it appears
 * inside a `-Command` string, where no amount of looking at argv[0]
 * would find it.
 *
 * The list below is why src/single-prompt.test.ts exempts this module by
 * name: these words are here to be *found* in somebody else's command,
 * and nothing in this file runs one.
 */
export function raisesRights(argv: readonly string[]): boolean {
  const head = argv[0]?.toLowerCase().replace(/\.exe$/, "") ?? "";
  if (["sudo", "pkexec", "doas", "su", "runas"].includes(head)) return true;
  return argv.some((word) => /-verb\s+runas/i.test(word));
}

/**
 * The host's own panel, and why red-dev is opening it instead of doing
 * the work itself.
 *
 * The reason is a field rather than a comment because it is shown. A
 * person who pressed Enter on a device and got a Settings window instead
 * of a switched device is owed the sentence explaining that, and a
 * `reason` nobody can print is a limit that has been hidden rather than
 * declared.
 */
export interface NativeFallback {
  /** What the host calls it, spelled the way the host spells it. */
  surface: string;
  /** One sentence: what red-dev cannot do here, and why. */
  reason: string;
}

/**
 * Open one of Windows' own pages, by the URI Windows publishes for it.
 *
 * Through `cmd /c start` with the empty title slot, exactly as
 * `terminal.new` opens a terminal and for the same two reasons. This
 * process is a console process on both sides of the WSL boundary, so
 * `start` is the shell asking Windows for a window rather than handing
 * the child the console red-dev is drawing in; and without the empty
 * argument `start` reads the first word as a window title.
 *
 * `explorer.exe ms-settings:…` opens the same page and is the form most
 * often written down, but it exits non-zero often enough that a Panel
 * using it would report a failure over a window that opened fine.
 */
export function windowsSurface(uri: string): string[] {
  return ["cmd.exe", "/c", "start", "", uri];
}

// ------------------------------------------------------------- the seam

/** Ran, and what it printed. Same shape as `lan-address.ts`'s. */
export interface Captured {
  out: string;
  code: number;
}

/** The seam the tests replace: how a question reaches the machine. */
export type Capture = (cmd: readonly string[]) => Promise<Captured>;

/** Run one argv attached to the terminal, and say how it ended. */
export type Run = (argv: readonly string[]) => Promise<number>;

/**
 * Ask the machine, with the child's streams captured.
 *
 * The same shape `lan-address.ts` uses, including the UTF-16LE decode:
 * PowerShell reached through WSL interop writes UTF-16LE when its stdout
 * is redirected, which is not JSON until it is decoded.
 */
export async function spawnCapture(cmd: readonly string[]): Promise<Captured> {
  const { readWindowsOutput } = await import("./windows-output.ts");
  try {
    const proc = Bun.spawn([...cmd], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const out = await readWindowsOutput(proc.stdout);
    return { out, code: await proc.exited };
  } catch {
    // A binary that is not there is an answer, not an exception: this
    // machine cannot be asked, so it reports nothing.
    return { out: "", code: 127 };
  }
}

// -------------------------------------------------------- carrying it out

/** Done, or the reason it was not — either way, one line. */
export interface PanelOutcome {
  done: boolean;
  detail: string;
}

/**
 * Carry a plan out: the visible ask, then the acts, stopping at the
 * first one that fails.
 *
 * Stopping matters wherever a plan has two acts and the second only
 * makes sense after the first — "record the choice" then "make it take
 * effect". Running the second after a failed first applies the setting
 * the machine already had and reports that as the change somebody asked
 * for, which is the quietest kind of wrong.
 *
 * A failure is described by the gate when there is one, because "sudo
 * needs a password" is the whole remedy and a non-zero exit is not. With
 * no gate the exit code is all there is, and inventing a rights problem
 * for a `pactl` that could not find the device would send whoever reads
 * it to the wrong place entirely.
 */
export async function runPlan(plan: PanelPlan, run: Run): Promise<PanelOutcome> {
  if (plan.prime) {
    const code = await run(plan.prime);
    if (code !== 0) {
      const { missingRights } = await import("./rights.ts");
      return { done: false, detail: missingRights(plan.gate ?? "sudo").cause };
    }
  }

  for (const step of plan.steps) {
    const code = await run(step);
    if (code === 0) continue;
    if (plan.gate !== null) {
      const { missingRights } = await import("./rights.ts");
      // A non-zero exit from an elevated Start-Process is what a declined
      // UAC dialog looks like from here; there is no separate signal for
      // it, and the remedy is the same either way.
      return { done: false, detail: `${step[0]} failed — ${missingRights(plan.gate).cause}` };
    }
    return { done: false, detail: `${step[0]} failed — exit ${code}` };
  }

  return { done: true, detail: plan.note };
}

// -------------------------------------------------------- the keyboard

/**
 * The keys a Panel reads, structurally — the same declaration `keys.ts`
 * makes, and for the same reason: tuiuiu's `Key` carries all of these,
 * so the component hands its own object straight in, and naming only
 * what is used keeps this module free of the renderer.
 */
export interface PanelKey {
  upArrow: boolean;
  downArrow: boolean;
  return: boolean;
  escape: boolean;
  backspace: boolean;
  delete: boolean;
  ctrl: boolean;
}

/** Where the cursor is in a Panel that is a list and nothing else. */
export interface ListState {
  index: number;
}

export interface ListStep {
  state: ListState;
  /** The row Enter asked for, when there was a row to ask for. */
  apply?: number;
  /** The Panel is finished. */
  quit?: boolean;
}

/**
 * One keystroke over a plain list, as a decision rather than as a side
 * effect.
 *
 * Typing is swallowed: this is a list of things to choose between, not a
 * search box, and a stray letter that did something invisible would be a
 * change nobody asked for. The network Panel keeps a step function of
 * its own because it has a field to type resolvers into; a Panel whose
 * rows are the devices the machine reported has nothing to type.
 *
 * `count` is passed rather than stored because the rows come from the
 * machine and change under the cursor — a headset unplugged between two
 * observations leaves an index pointing past the end, and clamping on
 * every keystroke is what stops Enter from applying a row that is no
 * longer there.
 */
export function listStep(
  state: ListState,
  count: number,
  input: string,
  key: PanelKey,
): ListStep {
  const clamp = (i: number): number => Math.max(0, Math.min(count - 1, i));

  // Ctrl+C leaves, whatever is on screen. Every other Ctrl chord is
  // swallowed rather than read as a movement.
  if (key.ctrl) return input === "c" ? { state, quit: true } : { state };

  if (key.escape) return { state, quit: true };

  if (key.return) {
    return count === 0 ? { state } : { state: { index: clamp(state.index) }, apply: clamp(state.index) };
  }

  if (key.upArrow) return { state: { index: clamp(state.index - 1) } };
  if (key.downArrow) return { state: { index: clamp(state.index + 1) } };

  return { state };
}
