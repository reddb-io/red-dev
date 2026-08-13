/**
 * What red-dev tells this machine's supervisor, checked without one.
 *
 * The subject is not "does the Redwall regenerate" — `redwall-generate.test.ts`
 * owns that — but the promise around it: that a machine with the
 * preference on ends up with a timer somebody else has to keep running,
 * that a machine with it off ends up with nothing, and that neither of
 * those costs a `systemctl` call on the ordinary converge where nothing
 * changed.
 *
 * Every command is captured rather than run. The defaults here reach
 * `systemctl --user enable --now` and `schtasks /Create` on whoever
 * typed `bun test`, and a suite that scheduled two-minute work on a
 * maintainer's laptop would be a worse bug than any it could catch. The
 * captured argv is also the only place the contract is visible: "the
 * timer, not the service" and "--now, not at next boot" are claims about
 * arguments and nothing else.
 */

import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { BoundedCommandResult } from "./bounded-command.ts";
import { captureStart, captureStop } from "./log.ts";
import type { Platform } from "./platform.ts";
import {
  applyRedwallSchedule,
  redwallBinary,
  redwallTaskWrapper,
  redwallUnits,
  redwallWrapperPath,
  removeRedwallSchedule,
  REDWALL_SERVICE,
  REDWALL_TASK,
  REDWALL_TASK_WRAPPER,
  REDWALL_TIMER,
} from "./redwall-schedule.ts";

const desktop: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

const wsl: Platform = { ...desktop, env: "wsl", caps: { ...desktop.caps, gui: false } };

const wslNoSystemd: Platform = { ...wsl, caps: { ...wsl.caps, systemd: false } };

const server: Platform = { ...desktop, env: "server", caps: { ...desktop.caps, gui: false } };

const windows: Platform = {
  os: "windows",
  distro: null,
  version: "11",
  codename: null,
  env: "windows",
  arch: "x64",
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
};

/**
 * A machine whose unit directory is a temporary one, torn down with the
 * process.
 *
 * HOME is moved as well as the directory injected, because the default
 * binary path is derived from it — a test that only redirected the units
 * would assert a path out of the maintainer's home.
 */
async function onFreshMachine<T>(run: (unitDir: string) => Promise<T>): Promise<T> {
  const previous = process.env["HOME"];
  const home = mkdtempSync(`${tmpdir()}/red-dev-redwall-schedule-`);
  process.env["HOME"] = home;
  try {
    return await run(`${home}/.config/systemd/user`);
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
  }
}

const ok = (stdout = ""): BoundedCommandResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  groupGone: true,
});

const failed = (stderr = "no such unit"): BoundedCommandResult => ({
  exitCode: 1,
  stdout: "",
  stderr,
  timedOut: false,
  groupGone: true,
});

/**
 * A supervisor that answers whatever it is told to and remembers every
 * question.
 *
 * `answers` is keyed on a distinguishing fragment of the command rather
 * than the whole argv, so a test states the one thing it is pretending
 * about the machine — "the timer is already enabled", "there is no such
 * scheduled task" — and nothing else.
 */
function supervisor(answers: Record<string, BoundedCommandResult> = {}) {
  const calls: string[][] = [];
  return {
    calls,
    ran: (fragment: string): boolean => calls.some((argv) => argv.join(" ").includes(fragment)),
    run: async (argv: string[]): Promise<BoundedCommandResult> => {
      calls.push(argv);
      const line = argv.join(" ");
      for (const [fragment, result] of Object.entries(answers)) {
        if (line.includes(fragment)) return result;
      }
      return ok();
    },
  };
}

const on = async (): Promise<boolean> => true;
const off = async (): Promise<boolean> => false;

/** The log lines one call emitted, with the console left alone. */
async function lines<T>(run: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  captureStart();
  try {
    const value = await run();
    return { value, logged: captureStop() };
  } catch (err) {
    captureStop();
    throw err;
  }
}

describe("with the preference on", () => {
  test("writes both units and enables the timer, not the service", async () => {
    await onFreshMachine(async (unitDir) => {
      const host = supervisor({ "is-enabled": failed() });

      const outcome = await applyRedwallSchedule(desktop, {
        unitDir,
        run: host.run,
        enabled: on,
      });

      expect(outcome.action).toBe("installed");
      expect(outcome.skipped).toBeNull();
      expect(outcome.written.sort()).toEqual(
        [`${unitDir}/${REDWALL_SERVICE}`, `${unitDir}/${REDWALL_TIMER}`].sort(),
      );
      expect(existsSync(`${unitDir}/${REDWALL_SERVICE}`)).toBe(true);
      // The timer is what gets enabled. Enabling the oneshot service
      // would ask systemd to run it once at boot and never again, which
      // looks identical until the wallpaper stops moving.
      expect(host.ran(`enable --now ${REDWALL_TIMER}`)).toBe(true);
      expect(host.ran(`enable --now ${REDWALL_SERVICE}`)).toBe(false);
      // --now, so the first Redwall does not wait for a reboot.
      expect(host.ran("daemon-reload")).toBe(true);
    });
  });

  test("names an absolute path to the installed binary in ExecStart", async () => {
    await onFreshMachine(async (unitDir) => {
      const host = supervisor({ "is-enabled": failed() });

      await applyRedwallSchedule(desktop, { unitDir, run: host.run, enabled: on });

      const service = await Bun.file(`${unitDir}/${REDWALL_SERVICE}`).text();
      // Absolute and derived, never "red-dev": systemd's user manager
      // does not read the PATH red-dev builds for an interactive shell,
      // and a hardcoded home is one machine's answer.
      expect(service).toContain(`ExecStart=${process.env["HOME"]}/.local/bin/red-dev redwall`);
      expect(await redwallBinary(desktop)).toBe(`${process.env["HOME"]}/.local/bin/red-dev`);
    });
  });

  test("asks for a two-minute cadence that survives a reboot", async () => {
    const { timer } = redwallUnits("/home/somebody/.local/bin/red-dev");

    expect(timer).toContain("OnUnitActiveSec=2min");
    expect(timer).toContain("OnBootSec=1min");
    expect(timer).toContain(`Unit=${REDWALL_SERVICE}`);
    expect(timer).toContain("WantedBy=timers.target");
  });

  test("leaves unchanged units alone and asks systemd for nothing", async () => {
    await onFreshMachine(async (unitDir) => {
      const first = supervisor({ "is-enabled": failed() });
      await applyRedwallSchedule(desktop, { unitDir, run: first.run, enabled: on });
      const stamped = statSync(`${unitDir}/${REDWALL_TIMER}`).mtimeMs;

      // The second converge of a machine nothing has happened to. Its
      // whole cost has to be the two probes below, because this is the
      // run that happens over and over.
      const again = supervisor({ "is-enabled": ok("enabled\n") });
      const outcome = await applyRedwallSchedule(desktop, {
        unitDir,
        run: again.run,
        enabled: on,
      });

      expect(outcome.action).toBe("unchanged");
      expect(outcome.written).toEqual([]);
      expect(statSync(`${unitDir}/${REDWALL_TIMER}`).mtimeMs).toBe(stamped);
      expect(again.ran("daemon-reload")).toBe(false);
      expect(again.ran("enable --now")).toBe(false);
      expect(again.calls.length).toBe(1);
    });
  });

  test("re-enables a timer somebody turned off, without rewriting the units", async () => {
    await onFreshMachine(async (unitDir) => {
      await applyRedwallSchedule(desktop, {
        unitDir,
        run: supervisor({ "is-enabled": failed() }).run,
        enabled: on,
      });

      const host = supervisor({ "is-enabled": ok("disabled\n") });
      const outcome = await applyRedwallSchedule(desktop, {
        unitDir,
        run: host.run,
        enabled: on,
      });

      expect(outcome.action).toBe("installed");
      expect(outcome.written).toEqual([]);
      expect(host.ran(`enable --now ${REDWALL_TIMER}`)).toBe(true);
      // Nothing moved on disk, so systemd has nothing to re-read.
      expect(host.ran("daemon-reload")).toBe(false);
    });
  });

  test("rewrites the units when the binary moved under them", async () => {
    await onFreshMachine(async (unitDir) => {
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(`${unitDir}/${REDWALL_SERVICE}`, "ExecStart=/opt/old/red-dev redwall\n");

      const host = supervisor({ "is-enabled": ok("enabled\n") });
      const outcome = await applyRedwallSchedule(desktop, {
        unitDir,
        run: host.run,
        enabled: on,
        binary: "/home/somebody/.local/bin/red-dev",
      });

      expect(outcome.action).toBe("installed");
      expect(outcome.written).toContain(`${unitDir}/${REDWALL_SERVICE}`);
      expect(await Bun.file(`${unitDir}/${REDWALL_SERVICE}`).text()).toContain(
        "ExecStart=/home/somebody/.local/bin/red-dev redwall",
      );
      expect(host.ran("daemon-reload")).toBe(true);
    });
  });

  test("reports a user manager that refused rather than failing the converge", async () => {
    await onFreshMachine(async (unitDir) => {
      const host = supervisor({
        "is-enabled": failed(),
        "enable --now": failed("Failed to connect to bus"),
      });

      const { value, logged } = await lines(() =>
        applyRedwallSchedule(desktop, { unitDir, run: host.run, enabled: on }),
      );

      // The units are on disk and correct, so the machine is one command
      // from converged. Throwing here would paint a healthy machine red
      // over a wallpaper timer.
      expect(value.action).toBe("installed");
      expect(logged.join("\n")).toContain("Failed to connect to bus");
    });
  });
});

describe("with the preference off", () => {
  test("disables and removes units that are there", async () => {
    await onFreshMachine(async (unitDir) => {
      await applyRedwallSchedule(desktop, {
        unitDir,
        run: supervisor({ "is-enabled": failed() }).run,
        enabled: on,
      });

      const host = supervisor();
      const outcome = await applyRedwallSchedule(desktop, {
        unitDir,
        run: host.run,
        enabled: off,
      });

      expect(outcome.action).toBe("removed");
      expect(outcome.removed.sort()).toEqual(
        [`${unitDir}/${REDWALL_SERVICE}`, `${unitDir}/${REDWALL_TIMER}`].sort(),
      );
      expect(existsSync(`${unitDir}/${REDWALL_TIMER}`)).toBe(false);
      expect(existsSync(`${unitDir}/${REDWALL_SERVICE}`)).toBe(false);
      // Disabled before the files went. A unit disabled after its file
      // is deleted leaves the wants-symlink behind, and systemd
      // complains about it on every reload from then on.
      const order = host.calls.map((argv) => argv.join(" "));
      expect(order[0]).toContain(`disable --now ${REDWALL_TIMER}`);
      expect(host.ran("daemon-reload")).toBe(true);
    });
  });

  test("does nothing at all, and says nothing, when there is no schedule", async () => {
    await onFreshMachine(async (unitDir) => {
      const host = supervisor();

      const { value, logged } = await lines(() =>
        applyRedwallSchedule(desktop, { unitDir, run: host.run, enabled: off }),
      );

      expect(value.action).toBe("absent");
      expect(value.removed).toEqual([]);
      // Not one process and not one line: this is the state of every
      // machine that never enabled Redwall, on every converge it ever
      // runs.
      expect(host.calls).toEqual([]);
      expect(logged).toEqual([]);
      expect(existsSync(unitDir)).toBe(false);
    });
  });
});

describe("on a machine that cannot hold a schedule", () => {
  test("a server skips with a line and touches nothing", async () => {
    await onFreshMachine(async (unitDir) => {
      const host = supervisor();

      const { value, logged } = await lines(() =>
        applyRedwallSchedule(server, { unitDir, run: host.run, enabled: on }),
      );

      expect(value.skipped).toBe("headless");
      expect(host.calls).toEqual([]);
      expect(existsSync(unitDir)).toBe(false);
      expect(logged.join("\n")).toContain("no desktop");
    });
  });

  test("WSL without systemd skips and says how to change that", async () => {
    await onFreshMachine(async (unitDir) => {
      const host = supervisor();

      const { value, logged } = await lines(() =>
        applyRedwallSchedule(wslNoSystemd, { unitDir, run: host.run, enabled: on }),
      );

      expect(value.skipped).toBe("no-systemd");
      expect(host.calls).toEqual([]);
      expect(existsSync(unitDir)).toBe(false);
      expect(logged.join("\n")).toContain("wsl.conf");
    });
  });

  test("WSL with systemd is an ordinary Linux target", async () => {
    await onFreshMachine(async (unitDir) => {
      // The images live on the Windows disk, but the binary that writes
      // them can run in here when the Windows host has no native owner.
      const outcome = await applyRedwallSchedule(wsl, {
        unitDir,
        run: supervisor({ "is-enabled": failed() }).run,
        enabled: on,
        windowsOwns: async () => false,
      });

      expect(outcome.skipped).toBeNull();
      expect(outcome.action).toBe("installed");
    });
  });

  test("WSL removes its timer when the Windows task already owns this desktop", async () => {
    await onFreshMachine(async (unitDir) => {
      await applyRedwallSchedule(wsl, {
        unitDir,
        run: supervisor({ "is-enabled": failed() }).run,
        enabled: on,
        windowsOwns: async () => false,
      });

      const host = supervisor();
      const outcome = await applyRedwallSchedule(wsl, {
        unitDir,
        run: host.run,
        enabled: on,
        windowsOwns: async () => true,
      });

      expect(outcome.action).toBe("removed");
      expect(outcome.removed.sort()).toEqual(
        [`${unitDir}/${REDWALL_SERVICE}`, `${unitDir}/${REDWALL_TIMER}`].sort(),
      );
      expect(host.ran(`disable --now ${REDWALL_TIMER}`)).toBe(true);
      expect(existsSync(`${unitDir}/${REDWALL_TIMER}`)).toBe(false);
    });
  });
});

/**
 * Windows, where the schedule runs a script and the script runs red-dev.
 *
 * The indirection is the feature. Task Scheduler starts `/TR` in a
 * session of its own and red-dev.exe is a console program, so Windows
 * allocates a console for it — a black window flashing over the desktop
 * every two minutes, which is what the wallpaper is for. `wscript.exe`
 * is a GUI-subsystem host and gets none, and the script it runs starts
 * the binary hidden.
 *
 * It also splits what "stale" means in two, which is most of what these
 * tests are about: the task knows only the script, so the binary path
 * has moved out of the one field Task Scheduler could be asked about and
 * into the script's own bytes.
 */
describe("on Windows", () => {
  /** A wrapper written somewhere the suite is allowed to write. */
  async function onFreshWindows<T>(run: (wrapper: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(`${tmpdir()}/red-dev-redwall-wrapper-`);
    return await run(`${dir}/${REDWALL_TASK_WRAPPER}`);
  }

  const binary = "C:\\Users\\First Last\\AppData\\Local\\red-dev\\bin\\red-dev.exe";

  test("creates a two-minute task that runs the wrapper through wscript", async () => {
    await onFreshWindows(async (wrapper) => {
      const host = supervisor({ "/Query": failed("ERROR: The system cannot find the file") });

      const outcome = await applyRedwallSchedule(windows, {
        run: host.run,
        enabled: on,
        binary,
        wrapper,
      });

      expect(outcome.action).toBe("installed");
      expect(outcome.written).toEqual([wrapper]);
      const created = host.calls.find((argv) => argv.includes("/Create"));
      expect(created).toBeDefined();
      // wscript, never the binary. A task naming red-dev.exe directly is
      // the bug: it works, and it flashes a console every two minutes.
      expect(created).toContain(`wscript.exe //B //Nologo "${wrapper}"`);
      expect(created?.join(" ")).not.toContain("red-dev.exe redwall");
      expect(created?.join(" ")).toContain("/SC MINUTE /MO 2");
      expect(created).toContain("/F");
    });
  });

  test("the wrapper starts the binary hidden, with its path quoted", async () => {
    const body = redwallTaskWrapper(binary);

    // 0 is the window style and is the whole point. False rather than
    // True so the script returns at once instead of holding a Task
    // Scheduler slot for the length of a 4K compose.
    expect(body).toContain(`shell.Run """${binary}"" redwall", 0, False`);
    // Doubled quotes are VBScript's escape for one: unquoted, a path
    // through "First Last" starts C:\Users\First.
    expect(body).toContain('"""C:\\Users\\First Last\\');
    expect(body).toContain("Managed by red-dev");
    // CRLF: it is a Windows script file, and somebody will open it.
    expect(body.split("\r\n").length).toBeGreaterThan(5);
  });

  test("goes beside the binary, so an upgrade moves both", async () => {
    expect(redwallWrapperPath(binary)).toBe(
      "C:\\Users\\First Last\\AppData\\Local\\red-dev\\bin\\red-dev-redwall.vbs",
    );
  });

  test("leaves a task that already names this wrapper alone", async () => {
    await onFreshWindows(async (wrapper) => {
      const settled = supervisor({ "/Query": failed() });
      await applyRedwallSchedule(windows, { run: settled.run, enabled: on, binary, wrapper });

      const host = supervisor({
        "/Query": ok(`Task To Run: wscript.exe //B //Nologo "${wrapper}"\n`),
      });
      const outcome = await applyRedwallSchedule(windows, {
        run: host.run,
        enabled: on,
        binary,
        wrapper,
      });

      expect(outcome.action).toBe("unchanged");
      expect(outcome.written).toEqual([]);
      expect(host.ran("/Create")).toBe(false);
    });
  });

  test("re-creates a task that still names the binary directly", async () => {
    // The machine this change was written for: a task installed by the
    // previous release, running red-dev.exe with a console of its own.
    await onFreshWindows(async (wrapper) => {
      const settled = supervisor({ "/Query": failed() });
      await applyRedwallSchedule(windows, { run: settled.run, enabled: on, binary, wrapper });

      const host = supervisor({ "/Query": ok(`Task To Run: "${binary}" redwall\n`) });
      const outcome = await applyRedwallSchedule(windows, {
        run: host.run,
        enabled: on,
        binary,
        wrapper,
      });

      expect(outcome.action).toBe("installed");
      expect(host.ran("/Create")).toBe(true);
    });
  });

  test("re-creates a task whose wrapper the upgrade moved out from under", async () => {
    // Nothing Task Scheduler can be asked about changed: the task names
    // the same script it always did. The binary inside that script is
    // the field that went stale, and rewriting it is the only signal.
    await onFreshWindows(async (wrapper) => {
      writeFileSync(wrapper, redwallTaskWrapper("C:\\Old\\red-dev.exe"));

      const host = supervisor({
        "/Query": ok(`Task To Run: wscript.exe //B //Nologo "${wrapper}"\n`),
      });
      const outcome = await applyRedwallSchedule(windows, {
        run: host.run,
        enabled: on,
        binary,
        wrapper,
      });

      expect(outcome.action).toBe("installed");
      expect(outcome.written).toEqual([wrapper]);
      expect(await Bun.file(wrapper).text()).toContain(binary);
      expect(host.ran("/Create")).toBe(true);
    });
  });

  test("writes the wrapper when the task exists but the script never did", async () => {
    await onFreshWindows(async (wrapper) => {
      const host = supervisor({
        "/Query": ok(`Task To Run: wscript.exe //B //Nologo "${wrapper}"\n`),
      });
      const outcome = await applyRedwallSchedule(windows, {
        run: host.run,
        enabled: on,
        binary,
        wrapper,
      });

      expect(outcome.action).toBe("installed");
      expect(existsSync(wrapper)).toBe(true);
      expect(host.ran("/Create")).toBe(true);
    });
  });

  test("leaves an unchanged wrapper's bytes exactly where they were", async () => {
    await onFreshWindows(async (wrapper) => {
      const first = supervisor({ "/Query": failed() });
      await applyRedwallSchedule(windows, { run: first.run, enabled: on, binary, wrapper });
      const stamped = statSync(wrapper).mtimeMs;

      const host = supervisor({
        "/Query": ok(`Task To Run: wscript.exe //B //Nologo "${wrapper}"\n`),
      });
      await applyRedwallSchedule(windows, { run: host.run, enabled: on, binary, wrapper });

      expect(statSync(wrapper).mtimeMs).toBe(stamped);
    });
  });

  test("names the wrapper, not the binary, in the hand-repair hint", async () => {
    await onFreshWindows(async (wrapper) => {
      const host = supervisor({
        "/Query": failed(),
        "/Create": failed("ERROR: Access is denied."),
      });

      const { logged } = await lines(() =>
        applyRedwallSchedule(windows, { run: host.run, enabled: on, binary, wrapper }),
      );

      // A hint that told somebody to point the task at red-dev.exe would
      // hand them back the console flash this change removed.
      const text = logged.join("\n");
      expect(text).toContain("Access is denied");
      expect(text).toContain(`wscript.exe //B //Nologo \\"${wrapper}\\"`);
      expect(text).not.toContain(`\\"${binary}\\" redwall`);
    });
  });

  test("deletes the task and the wrapper when the preference goes off", async () => {
    await onFreshWindows(async (wrapper) => {
      const settled = supervisor({ "/Query": failed() });
      await applyRedwallSchedule(windows, { run: settled.run, enabled: on, binary, wrapper });

      const host = supervisor({
        "/Query": ok(`Task To Run: wscript.exe //B //Nologo "${wrapper}"\n`),
      });
      const outcome = await applyRedwallSchedule(windows, {
        run: host.run,
        enabled: off,
        binary,
        wrapper,
      });

      expect(outcome.action).toBe("removed");
      expect(outcome.removed).toEqual([REDWALL_TASK, wrapper]);
      // The script goes too. Left behind it is a file under a removed
      // feature's name that nothing on the machine would explain.
      expect(existsSync(wrapper)).toBe(false);
      // After the delete, never before: a wrapper removed while the task
      // still named it is a task that fails every two minutes in silence.
      const order = host.calls.map((argv) => argv.join(" "));
      expect(order.some((line) => line.includes("/Delete"))).toBe(true);
    });
  });

  test("removes a wrapper the task delete already left behind", async () => {
    await onFreshWindows(async (wrapper) => {
      writeFileSync(wrapper, redwallTaskWrapper(binary));
      const host = supervisor({ "/Query": failed("ERROR: The system cannot find the file") });

      const outcome = await applyRedwallSchedule(windows, {
        run: host.run,
        enabled: off,
        binary,
        wrapper,
      });

      expect(outcome.action).toBe("removed");
      expect(outcome.removed).toEqual([wrapper]);
      expect(host.ran("/Delete")).toBe(false);
    });
  });

  test("deletes nothing when there is neither a task nor a wrapper", async () => {
    await onFreshWindows(async (wrapper) => {
      const host = supervisor({ "/Query": failed("ERROR: The system cannot find the file") });

      const outcome = await applyRedwallSchedule(windows, {
        run: host.run,
        enabled: off,
        binary,
        wrapper,
      });

      expect(outcome.action).toBe("absent");
      expect(host.ran("/Delete")).toBe(false);
    });
  });

  test("uninstalling takes the wrapper with the task", async () => {
    await onFreshWindows(async (wrapper) => {
      const settled = supervisor({ "/Query": failed() });
      await applyRedwallSchedule(windows, { run: settled.run, enabled: on, binary, wrapper });

      const host = supervisor({
        "/Query": ok(`Task To Run: wscript.exe //B //Nologo "${wrapper}"\n`),
      });
      const outcome = await removeRedwallSchedule(windows, { run: host.run, binary, wrapper });

      expect(outcome.removed).toEqual([REDWALL_TASK, wrapper]);
      expect(existsSync(wrapper)).toBe(false);
    });
  });
});

describe("uninstalling", () => {
  test("takes the units out whatever the preference still says", async () => {
    await onFreshMachine(async (unitDir) => {
      await applyRedwallSchedule(desktop, {
        unitDir,
        run: supervisor({ "is-enabled": failed() }).run,
        enabled: on,
      });

      // No `enabled` seam: uninstall does not ask. The preference is
      // kept so that reinstalling restores the choice, and a timer left
      // behind would fire a binary that no longer exists.
      const host = supervisor();
      const outcome = await removeRedwallSchedule(desktop, { unitDir, run: host.run });

      expect(outcome.action).toBe("removed");
      expect(existsSync(`${unitDir}/${REDWALL_TIMER}`)).toBe(false);
      expect(host.ran(`disable --now ${REDWALL_TIMER}`)).toBe(true);
    });
  });

  test("is silent on a machine that never scheduled anything", async () => {
    await onFreshMachine(async (unitDir) => {
      const host = supervisor();

      const outcome = await removeRedwallSchedule(desktop, { unitDir, run: host.run });

      expect(outcome.action).toBe("absent");
      expect(outcome.removed).toEqual([]);
      expect(host.calls).toEqual([]);
    });
  });
});
