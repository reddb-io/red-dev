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
  /** Whether the preference is on. Defaults to the recorded preference. */
  readonly enabled?: () => Promise<boolean>;
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
  return p.os === "windows" ? await scheduleWindows(p, seams) : await scheduleSystemd(p, seams);
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
  return p.os === "windows" ? await unscheduleWindows(seams) : await unscheduleSystemd(seams);
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

  log.ok("redwall schedule: removed — the preference is off");
  return { action: "removed", skipped: null, written: [], removed: present };
}

async function scheduleWindows(
  p: Platform,
  seams: RedwallScheduleSeams,
): Promise<RedwallScheduleOutcome> {
  const run = runner(seams);
  const binary = seams.binary ?? (await redwallBinary(p));
  const existing = await run(["schtasks", "/Query", "/TN", REDWALL_TASK, "/FO", "LIST", "/V"], {
    timeoutMs: 15_000,
  });
  // Matched on the binary path rather than parsed: `schtasks /Query`
  // renders in the machine's own language, so every label around the
  // value is a locale away from meaning nothing. The path is the one
  // field that is the same on every Windows, and it is also the field
  // that goes stale — an upgrade that moves the binary is exactly what
  // has to force a re-create.
  const current = existing.exitCode === 0 &&
    existing.stdout.toLowerCase().includes(binary.toLowerCase());
  if (current) return { action: "unchanged", skipped: null, written: [], removed: [] };

  const created = await run([
    "schtasks",
    "/Create",
    "/TN",
    REDWALL_TASK,
    // Quoted inside the argument because Task Scheduler stores this as
    // one command line and splits it itself: an unquoted path through
    // `C:\Users\First Last\...` becomes a task that runs `C:\Users\First`.
    "/TR",
    `"${binary}" redwall`,
    "/SC",
    "MINUTE",
    "/MO",
    String(EVERY_MINUTES),
    // The task exists but names the wrong binary is the case that got
    // us here, and without /F schtasks refuses to replace it.
    "/F",
  ], { timeoutMs: 20_000 });
  if (created.exitCode !== 0) {
    log.warn(`redwall schedule: ${firstLine(created.stderr) || "schtasks could not create the task"}`);
    log.plain(
      `       create it by hand: schtasks /Create /TN ${REDWALL_TASK} ` +
        `/TR "\\"${binary}\\" redwall" /SC MINUTE /MO ${EVERY_MINUTES} /F`,
    );
  }
  return { action: "installed", skipped: null, written: [], removed: [] };
}

async function unscheduleWindows(
  seams: RedwallScheduleSeams,
): Promise<RedwallScheduleOutcome> {
  const run = runner(seams);
  const existing = await run(["schtasks", "/Query", "/TN", REDWALL_TASK], { timeoutMs: 15_000 });
  // A non-zero query is how Task Scheduler says "no such task", which is
  // the state the preference asks for. Silent for the same reason the
  // systemd side is.
  if (existing.exitCode !== 0) {
    return { action: "absent", skipped: null, written: [], removed: [] };
  }
  await run(["schtasks", "/Delete", "/TN", REDWALL_TASK, "/F"], { timeoutMs: 15_000 });
  log.ok("redwall schedule: removed — the preference is off");
  return { action: "removed", skipped: null, written: [], removed: [REDWALL_TASK] };
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
}
