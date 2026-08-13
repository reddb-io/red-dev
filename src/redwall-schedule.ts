/**
 * The schedule that keeps a Redwall current.
 *
 * `redwall.ts` composes one image and writes it down. Nothing in it
 * decides when that happens, and until this module existed the answer on
 * every machine was "when somebody typed `red-dev redwall`" — which is
 * to say never, on the machines that most needed a status wallpaper. A
 * desktop showing a Worker count from three days ago is worse than one
 * showing none, because it is read as current.
 *
 * ## Why the OS runs it and not red-dev
 *
 * A long-lived process of our own would have to survive logout, reboot,
 * a WSL distro shutting down when its last shell exits, and an upgrade
 * that replaces the binary underneath it. Every target already has a
 * supervisor that solves all four — systemd user units on Linux and WSL,
 * Task Scheduler on Windows — so this module's whole job is to describe
 * the schedule to that supervisor and to stop describing it when the
 * preference goes off.
 *
 * A two-minute cadence is chosen against the cost of a run, not against
 * how fast the numbers move: an unchanged Redwall is a digest and an
 * `existsSync`, because the file name is a function of the bytes. So the
 * common tick writes nothing at all, and the rare one is the only one
 * that pays for a 4K compose.
 *
 * ## Write-if-changed, and why the units carry a header
 *
 * Rewriting identical unit files would move their timestamps on every
 * converge and make `systemctl --user daemon-reload` a per-converge
 * event on a machine where nothing changed. The header says the files
 * are red-dev's, so somebody reading `~/.config/systemd/user` months
 * later knows what put them there and that hand-edits do not survive.
 *
 * ## Doing nothing, successfully
 *
 * The three ways this legitimately does nothing are ordinary states, not
 * failures: a server has no screen to schedule work for, a WSL distro
 * without `systemd=true` in wsl.conf has no user manager to enable a
 * timer in, and a machine whose preference is off and which has no units
 * installed has already converged. The first two report a skip with a
 * line naming what to do about it; the third is silent, because a
 * message about a feature nobody enabled is noise on every converge for
 * the rest of the machine's life.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import {
  runBounded,
  type BoundedCommandOptions,
  type BoundedCommandResult,
} from "./bounded-command.ts";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import { resolveRedwall } from "./preferences.ts";

/** The unit that regenerates one Redwall. */
export const REDWALL_SERVICE = "red-dev-redwall.service";

/** The unit that decides when the one above runs. */
export const REDWALL_TIMER = "red-dev-redwall.timer";

/** What the Windows scheduled task is called, on both sides of its life. */
export const REDWALL_TASK = "red-dev-redwall";

/**
 * The script the Windows task runs instead of the binary.
 *
 * Task Scheduler starts what `/TR` names in a session of its own, and
 * red-dev.exe is a console program: Windows allocates a console for one
 * of those, so a task that named the binary directly flashed a black
 * window on the desktop every two minutes. `wscript.exe` is a
 * GUI-subsystem host and gets no console, and the script starts the
 * binary with a window style of 0 — so nothing is ever drawn.
 *
 * Beside the binary rather than with the images, because it names the
 * binary: the two go stale together, an upgrade that moves one moves the
 * other, and an uninstall that removes the directory removes both.
 */
export const REDWALL_TASK_WRAPPER = "red-dev-redwall.vbs";

/**
 * How often the supervisor fires, stated once for both targets.
 *
 * The systemd side spells it `2min` and Task Scheduler counts whole
 * minutes, so the number lives here and each side formats it.
 */
const EVERY_MINUTES = 2;

/** Why nothing was scheduled, when nothing was. */
export type RedwallScheduleSkip =
  /** No desktop here, so nothing would ever display the result. */
  | "headless"
  /** Linux or WSL without a user service manager to hold the timer. */
  | "no-systemd"
  /** A target red-dev has no scheduler for. */
  | "unsupported";

export type RedwallScheduleAction =
  /** The schedule was created, repaired, or re-enabled. */
  | "installed"
  /** It was already exactly this, down to the bytes of the units. */
  | "unchanged"
  /** The preference is off and a schedule was here, so it went. */
  | "removed"
  /** The preference is off and there was nothing to remove. */
  | "absent";

export interface RedwallScheduleOutcome {
  readonly action: RedwallScheduleAction;
  /** Null when the machine was able to hold a schedule at all. */
  readonly skipped: RedwallScheduleSkip | null;
  /** Unit files written this run; empty when they already said this. */
  readonly written: string[];
  /** Unit files removed this run. */
  readonly removed: string[];
}

/**
 * The seams a test replaces.
 *
 * Every default here reaches the operator's own machine — `systemctl
 * --user enable --now`, `schtasks /Create`, and a unit directory under a
 * real home — so a suite that let them run would schedule work on
 * whoever typed `bun test`. Injected at this level rather than deeper
 * because the question this module exists to answer is precisely "what
 * did we tell this machine's supervisor", and that is only observable as
 * the commands issued and the files left behind.
 */
export interface RedwallScheduleSeams {
  /** How host commands run. Defaults to the bounded runner. */
  readonly run?: (
    argv: string[],
    options?: BoundedCommandOptions,
  ) => Promise<BoundedCommandResult>;
  /** Where the user units live. Defaults to ~/.config/systemd/user. */
  readonly unitDir?: string;
  /** The binary the schedule invokes. Defaults to where red-dev installs itself. */
  readonly binary?: string;
  /**
   * Where the Windows task's hidden wrapper is written. Defaults to
   * beside the binary.
   *
   * A seam of its own rather than derived from `binary` in the tests,
   * because the default is derived from it: a test that injected only a
   * plausible Windows binary path would have this module create
   * `C:\Users\...` as a directory in whatever the suite's cwd happened
   * to be.
   */
  readonly wrapper?: string;
  /** Whether the preference is on. Defaults to the recorded preference. */
  readonly enabled?: () => Promise<boolean>;
  /** Whether a native Windows task already owns this WSL desktop. */
  readonly windowsOwns?: () => Promise<boolean>;
}

function home(): string {
  return (process.env["HOME"] ?? process.env["USERPROFILE"] ?? homedir()).replace(/\\/g, "/");
}

/**
 * Where systemd looks for this user's own units.
 *
 * Not `/etc/systemd/system`: a Redwall is drawn for one person's screen
 * out of one person's preference file, and a system unit would need root
 * to install and would run for a session that may not exist.
 */
export function redwallUnitDir(): string {
  return `${home()}/.config/systemd/user`;
}

/**
 * The binary the schedule has to name.
 *
 * `ExecStart` and `/TR` are read by a supervisor that has none of this
 * process's environment, so "red-dev" on its own is not an answer: the
 * directory red-dev installs itself into is on the PATH red-dev builds
 * for an interactive shell, and systemd's user manager does not read it.
 * The path is therefore absolute, and derived the same way the two
 * installers derive it — `RED_DEV_BIN_DIR` when the operator set one,
 * `~/.local/bin` on Linux and `%LOCALAPPDATA%\red-dev\bin` on Windows
 * otherwise (boot.sh and boot.ps1).
 */
export async function redwallBinary(p: Platform): Promise<string> {
  const override = process.env["RED_DEV_BIN_DIR"];
  if (p.os === "windows") {
    // Lazily, so a Linux target never loads the module that knows about
    // LOCALAPPDATA in order to write a systemd unit.
    const { windowsBinDir } = await import("./providers.ts");
    return `${override ?? windowsBinDir()}\\red-dev.exe`;
  }
  return `${override ?? `${home()}/.local/bin`}/red-dev`;
}

const MANAGED = "# Managed by red-dev — rewritten on every converge.";

/**
 * The exact bytes of both units, as a function of one path. PURE.
 *
 * Exported because it is the contract with the operator's machine, and
 * the only way to assert what red-dev asks systemd to do without a
 * systemd to ask.
 */
export function redwallUnits(binary: string): { service: string; timer: string } {
  return {
    service: [
      MANAGED,
      "[Unit]",
      "Description=Regenerate the red-dev Redwall",
      "",
      "[Service]",
      "Type=oneshot",
      // A regeneration reaches a daemon, a route lookup and the GitHub
      // budget cache, and every one of those has a way to hang. Bounded
      // so a stuck probe costs one tick rather than the timer's slot
      // forever; a 4K compose is seconds, so this is not a deadline the
      // healthy path can hit.
      "TimeoutStartSec=60",
      `ExecStart=${binary} redwall`,
      "",
    ].join("\n"),
    timer: [
      MANAGED,
      "[Unit]",
      `Description=Regenerate the red-dev Redwall every ${EVERY_MINUTES} minutes`,
      "",
      "[Timer]",
      // OnBootSec as well as OnUnitActiveSec: without it a machine that
      // has just come up waits a full interval before its wallpaper
      // stops describing the state it was shut down in.
      "OnBootSec=1min",
      `OnUnitActiveSec=${EVERY_MINUTES}min`,
      // Loose enough for systemd to batch this with whatever else it
      // wakes for. A status wallpaper is not worth its own wakeup.
      "AccuracySec=30s",
      `Unit=${REDWALL_SERVICE}`,
      "",
      "[Install]",
      "WantedBy=timers.target",
      "",
    ].join("\n"),
  };
}

/**
 * Where the wrapper goes: beside the binary it names. PURE.
 *
 * Both separators, because the binary path is Windows' own and a seam
 * may hand this a posix one in a test.
 */
export function redwallWrapperPath(binary: string): string {
  const separator = binary.includes("\\") ? "\\" : "/";
  return `${parentOf(binary)}${separator}${REDWALL_TASK_WRAPPER}`;
}

/**
 * The directory part of a path spelled either way. PURE.
 *
 * Not `node:path`'s: that one is posix or win32 according to the machine
 * running it, and this module reasons about Windows paths from a test
 * suite that runs on Linux.
 */
function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut === -1 ? "." : path.slice(0, cut);
}

/**
 * The exact bytes of the wrapper, as a function of one path. PURE.
 *
 * Exported for the same reason `redwallUnits` is, and needed for one
 * more: these bytes are half of what "the task is stale" means. Task
 * Scheduler only knows it runs a script, so an upgrade that moved the
 * binary changes nothing the task can be asked about — the wrapper is
 * the only place the new path shows up.
 *
 * CRLF, because it is a Windows script file that a person may open.
 */
export function redwallTaskWrapper(binary: string): string {
  return [
    "' Managed by red-dev — rewritten on every converge.",
    "'",
    "' wscript.exe hosts this and is a GUI-subsystem image, so Windows",
    "' allocates no console for it; 0 hides the child, and False returns",
    "' at once rather than holding a Task Scheduler slot for the run.",
    "Option Explicit",
    "Dim shell",
    'Set shell = CreateObject("WScript.Shell")',
    // Doubled quotes are VBScript's escape for one: the binary sits
    // under a profile that can contain a space, and unquoted,
    // C:\Users\First Last\... starts C:\Users\First.
    `shell.Run """${binary}"" redwall", 0, False`,
    "",
  ].join("\r\n");
}

/**
 * Whether this machine can hold a schedule at all, and why not when it
 * cannot. PURE.
 *
 * The same two questions `generateRedwall` asks before it composes
 * anything, plus the one only a scheduler cares about. A server is
 * "headless" here for exactly the reason it is there: nothing on it will
 * ever display the image, so a timer regenerating one every two minutes
 * is a process factory with no reader.
 */
export function redwallScheduleSkip(p: Platform): RedwallScheduleSkip | null {
  if (p.env === "server") return "headless";
  if (p.os === "windows") return null;
  if (p.os !== "linux") return "unsupported";
  return p.caps.systemd ? null : "no-systemd";
}

/**
 * Bring this machine's Redwall schedule in line with the preference.
 *
 * Never throws for a machine that cannot hold one, and never for a
 * preference that is off: both are ordinary answers, and a converge step
 * that failed because somebody had not enabled an optional wallpaper
 * feature would turn an entirely healthy machine red.
 */
export async function applyRedwallSchedule(
  p: Platform,
  seams: RedwallScheduleSeams = {},
): Promise<RedwallScheduleOutcome> {
  const skip = redwallScheduleSkip(p);
  if (skip !== null) {
    reportSkip(p, skip);
    return { action: "absent", skipped: skip, written: [], removed: [] };
  }

  const wanted = await (seams.enabled ?? (() => resolveRedwall(p)))();
  if (!wanted) return await unschedule(p, seams);
  if (p.env === "wsl" && await windowsOwnsRedwall(seams)) {
    // Windows and WSL point at the same preference and paint the same
    // Windows desktop. Keeping both supervisors made two binaries race
    // every two minutes (and let an older distro binary repaint after a
    // newer native one). Native Windows survives the distro shutting
    // down, so it is the canonical owner when its task is healthy.
    return await unscheduleSystemd(seams, "windows");
  }
  return p.os === "windows" ? await scheduleWindows(p, seams) : await scheduleSystemd(p, seams);
}

/**
 * Whether Windows has a complete native Redwall producer.
 *
 * A task name alone is not enough: an old task can outlive the binary or
 * wrapper it names. All three pieces must exist before WSL gives up its
 * fallback timer. The injectable answer keeps tests away from the real
 * host scheduler.
 */
async function windowsOwnsRedwall(seams: RedwallScheduleSeams): Promise<boolean> {
  if (seams.windowsOwns) return await seams.windowsOwns();

  try {
    const { windowsLocalAppData } = await import("./wsl.ts");
    const root = `${await windowsLocalAppData()}/red-dev/bin`;
    if (!existsSync(`${root}/red-dev.exe`) || !existsSync(`${root}/${REDWALL_TASK_WRAPPER}`)) {
      return false;
    }

    // A systemd user manager does not inherit WSL's augmented PATH.
    // Resolve the host executable absolutely when needed, just as the
    // rest of the WSL boundary does for PowerShell and cmd.exe.
    const absolute = "/mnt/c/Windows/System32/schtasks.exe";
    const schtasks = Bun.which("schtasks.exe") ?? (existsSync(absolute) ? absolute : "schtasks.exe");
    const task = await runner(seams)([schtasks, "/Query", "/TN", REDWALL_TASK], {
      timeoutMs: 5_000,
    });
    return task.exitCode === 0;
  } catch {
    // Host interop being unavailable is not evidence that Windows owns
    // the refresh. Keep the local fallback alive.
    return false;
  }
}

/**
 * Take the schedule away, whatever the preference says.
 *
 * Uninstall's half. Separate from the branch inside `applyRedwallSchedule`
 * only in that it never consults the preference: a machine being
 * uninstalled keeps its answer to "did you want a Redwall" so that
 * reinstalling restores it, and a timer left behind would then fire
 * `red-dev` from a path with no binary at it every two minutes.
 */
export async function removeRedwallSchedule(
  p: Platform,
  seams: RedwallScheduleSeams = {},
): Promise<RedwallScheduleOutcome> {
  const skip = redwallScheduleSkip(p);
  // Silently, unlike the converge path: an uninstall that could not have
  // installed a schedule has nothing to report about one.
  if (skip !== null) return { action: "absent", skipped: skip, written: [], removed: [] };
  return await unschedule(p, seams);
}

function reportSkip(p: Platform, skip: RedwallScheduleSkip): void {
  if (skip === "headless") {
    log.skip("redwall schedule: no desktop on this machine");
    return;
  }
  if (skip === "no-systemd") {
    log.skip("redwall schedule: no systemd here, so nothing can hold the timer");
    log.plain("       set systemd=true in /etc/wsl.conf to have it run on its own");
    return;
  }
  log.skip(`redwall schedule: no scheduler red-dev knows on ${p.os}`);
}

async function unschedule(
  p: Platform,
  seams: RedwallScheduleSeams,
): Promise<RedwallScheduleOutcome> {
  return p.os === "windows" ? await unscheduleWindows(p, seams) : await unscheduleSystemd(seams);
}

function runner(
  seams: RedwallScheduleSeams,
): (argv: string[], options?: BoundedCommandOptions) => Promise<BoundedCommandResult> {
  return seams.run ?? runBounded;
}

/**
 * Write a file only when its bytes would change, and say whether they
 * did.
 *
 * The whole of the idempotence claim. `daemon-reload` is issued off the
 * back of this answer, so a wrong "changed" is a systemd reload on every
 * converge and a wrong "unchanged" is a unit file systemd never re-reads.
 */
async function writeIfChanged(path: string, body: string): Promise<boolean> {
  if (existsSync(path)) {
    const current = await Bun.file(path).text().catch(() => null);
    if (current === body) return false;
  }
  await Bun.write(path, body);
  return true;
}

async function scheduleSystemd(
  p: Platform,
  seams: RedwallScheduleSeams,
): Promise<RedwallScheduleOutcome> {
  const dir = seams.unitDir ?? redwallUnitDir();
  const binary = seams.binary ?? (await redwallBinary(p));
  const units = redwallUnits(binary);
  mkdirSync(dir, { recursive: true });

  const written: string[] = [];
  for (const [name, body] of [
    [REDWALL_SERVICE, units.service],
    [REDWALL_TIMER, units.timer],
  ] as const) {
    if (await writeIfChanged(`${dir}/${name}`, body)) written.push(`${dir}/${name}`);
  }

  const run = runner(seams);
  // Asked rather than assumed, because the answer is what makes an
  // unchanged machine cost two short probes instead of a reload and an
  // enable. A user manager that cannot answer counts as "not enabled":
  // enabling something already enabled is free, and skipping the enable
  // on a machine that never had one is the failure that leaves a
  // preference on and a wallpaper frozen.
  const enabled = await run(["systemctl", "--user", "is-enabled", REDWALL_TIMER], {
    timeoutMs: 5_000,
  });
  const already = enabled.exitCode === 0 && enabled.stdout.trim() === "enabled";
  if (written.length === 0 && already) {
    return { action: "unchanged", skipped: null, written, removed: [] };
  }

  // Only when something moved. daemon-reload is cheap but not free, and
  // issuing it on every converge of an unchanged machine is exactly the
  // churn the write-if-changed above exists to avoid.
  if (written.length > 0) await run(["systemctl", "--user", "daemon-reload"], { timeoutMs: 10_000 });

  // `--now` so the first regeneration does not wait for a reboot, and
  // the timer rather than the service: enabling a oneshot service would
  // ask systemd to run it at boot and never again.
  const up = await run(["systemctl", "--user", "enable", "--now", REDWALL_TIMER], {
    timeoutMs: 15_000,
  });
  if (up.exitCode !== 0) {
    // Reported, not thrown. The units are on disk and correct, so the
    // machine is one `systemctl --user enable --now` from converged —
    // and a converge that failed here would report a broken machine over
    // a wallpaper timer.
    log.warn(`redwall schedule: ${firstLine(up.stderr) || "systemctl could not enable the timer"}`);
  }
  return { action: "installed", skipped: null, written, removed: [] };
}

async function unscheduleSystemd(
  seams: RedwallScheduleSeams,
  owner: "off" | "windows" = "off",
): Promise<RedwallScheduleOutcome> {
  const dir = seams.unitDir ?? redwallUnitDir();
  const paths = [`${dir}/${REDWALL_TIMER}`, `${dir}/${REDWALL_SERVICE}`];
  const present = paths.filter((path) => existsSync(path));
  // Silent, and without asking systemd anything. A machine that never
  // turned Redwall on is the common machine, and it has to converge
  // without spawning a process or printing a line about a feature
  // nobody chose.
  if (present.length === 0) {
    return { action: "absent", skipped: null, written: [], removed: [] };
  }

  const run = runner(seams);
  // Before the files go: disabling a unit whose file has already been
  // deleted leaves the symlink in `timers.target.wants` behind, and
  // systemd then complains about it on every reload for good.
  await run(["systemctl", "--user", "disable", "--now", REDWALL_TIMER], { timeoutMs: 15_000 });
  for (const path of present) rmSync(path, { force: true });
  await run(["systemctl", "--user", "daemon-reload"], { timeoutMs: 10_000 });

  log.ok(
    owner === "windows"
      ? "redwall schedule: removed from WSL — Windows owns this desktop"
      : "redwall schedule: removed — the preference is off",
  );
  return { action: "removed", skipped: null, written: [], removed: present };
}

/**
 * The command line the task holds.
 *
 * `//B` so a script error is an exit code rather than a dialog nobody is
 * sitting in front of, and `//Nologo` so the host prints no banner into
 * a stream nothing reads. PURE.
 */
function wrapperCommand(wrapper: string): string {
  return `wscript.exe //B //Nologo "${wrapper}"`;
}

async function scheduleWindows(
  p: Platform,
  seams: RedwallScheduleSeams,
): Promise<RedwallScheduleOutcome> {
  const run = runner(seams);
  const binary = seams.binary ?? (await redwallBinary(p));
  const wrapper = seams.wrapper ?? redwallWrapperPath(binary);

  mkdirSync(parentOf(wrapper), { recursive: true });
  const rewritten = await writeIfChanged(wrapper, redwallTaskWrapper(binary));

  const existing = await run(["schtasks", "/Query", "/TN", REDWALL_TASK, "/FO", "LIST", "/V"], {
    timeoutMs: 15_000,
  });
  // Matched on a path rather than parsed: `schtasks /Query` renders in
  // the machine's own language, so every label around the value is a
  // locale away from meaning nothing.
  //
  // Two questions now, not one. The task names the wrapper, and the
  // wrapper names the binary — so a task that still points at the binary
  // directly is stale (it is the one that flashes a window), and so is a
  // correct-looking task whose wrapper had to be rewritten because an
  // upgrade moved red-dev.exe under it. Task Scheduler cannot be asked
  // about the second: the wrapper's own bytes are the only place the
  // binary path appears, and `rewritten` is the answer.
  const current = !rewritten && existing.exitCode === 0 &&
    existing.stdout.toLowerCase().includes(wrapper.toLowerCase());
  if (current) return { action: "unchanged", skipped: null, written: [], removed: [] };

  const written = rewritten ? [wrapper] : [];
  const created = await run([
    "schtasks",
    "/Create",
    "/TN",
    REDWALL_TASK,
    // Quoted inside the argument because Task Scheduler stores this as
    // one command line and splits it itself: an unquoted path through
    // `C:\Users\First Last\...` becomes a task that runs `C:\Users\First`.
    "/TR",
    wrapperCommand(wrapper),
    "/SC",
    "MINUTE",
    "/MO",
    String(EVERY_MINUTES),
    // The task exists but names the wrong thing is the case that got us
    // here, and without /F schtasks refuses to replace it.
    "/F",
  ], { timeoutMs: 20_000 });
  if (created.exitCode !== 0) {
    log.warn(`redwall schedule: ${firstLine(created.stderr) || "schtasks could not create the task"}`);
    // The wrapper is already on disk and correct, so this is the whole
    // of what is left to do — and it has to name the wrapper rather than
    // the binary, or a hand-repaired machine goes back to flashing a
    // console every two minutes.
    log.plain(
      `       create it by hand: schtasks /Create /TN ${REDWALL_TASK} ` +
        `/TR "wscript.exe //B //Nologo \\"${wrapper}\\"" /SC MINUTE /MO ${EVERY_MINUTES} /F`,
    );
  }
  return { action: "installed", skipped: null, written, removed: [] };
}

async function unscheduleWindows(
  p: Platform,
  seams: RedwallScheduleSeams,
): Promise<RedwallScheduleOutcome> {
  const run = runner(seams);
  const wrapper = seams.wrapper ?? redwallWrapperPath(seams.binary ?? (await redwallBinary(p)));
  const orphan = existsSync(wrapper);

  const existing = await run(["schtasks", "/Query", "/TN", REDWALL_TASK], { timeoutMs: 15_000 });
  // A non-zero query is how Task Scheduler says "no such task". Silent
  // for the same reason the systemd side is — unless the wrapper is
  // still there, which is a file red-dev wrote and nothing else on the
  // machine would ever explain.
  if (existing.exitCode !== 0 && !orphan) {
    return { action: "absent", skipped: null, written: [], removed: [] };
  }

  const removed: string[] = [];
  if (existing.exitCode === 0) {
    await run(["schtasks", "/Delete", "/TN", REDWALL_TASK, "/F"], { timeoutMs: 15_000 });
    removed.push(REDWALL_TASK);
  }
  // After the task, not before: a wrapper deleted while a task still
  // names it is a task that fails every two minutes until somebody looks.
  if (orphan) {
    rmSync(wrapper, { force: true });
    removed.push(wrapper);
  }

  log.ok("redwall schedule: removed — the preference is off");
  return { action: "removed", skipped: null, written: [], removed };
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
}
