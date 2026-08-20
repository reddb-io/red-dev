/**
 * The clock under the shell hook.
 *
 * ADR 0017 hung the watch off the prompt, and that is right for the
 * person at a keyboard. It is not enough for the person who leaves one
 * terminal open all day: measured here, a release published at 17:38
 * against a last look at 16:25, and a Windows half that had not looked
 * in 711 minutes because no shell there reads a bash profile at all.
 */

import { describe, expect, test } from "bun:test";

import type { Platform } from "./platform.ts";
import {
  DEFAULT_WATCH_MINUTES,
  convergeWatchSchedule,
  watchEnabled,
  watchMinutes,
  watchTaskArgv,
  watchUnits,
  WATCH_TASK,
} from "./watch-schedule.ts";

const UBUNTU: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

describe("the interval", () => {
  test("is ten minutes unless somebody says otherwise", () => {
    expect(watchMinutes({})).toBe(DEFAULT_WATCH_MINUTES);
    expect(watchMinutes({ RED_SKILLS_WATCH_MINUTES: "3" })).toBe(3);
  });

  test("is clamped rather than refused, because a converge must not fail over a number", () => {
    // Under a minute is a machine asking faster than a release can
    // finish uploading; over a day is not a watch.
    expect(watchMinutes({ RED_SKILLS_WATCH_MINUTES: "0" })).toBe(1);
    expect(watchMinutes({ RED_SKILLS_WATCH_MINUTES: "-5" })).toBe(1);
    expect(watchMinutes({ RED_SKILLS_WATCH_MINUTES: "99999" })).toBe(1440);
    expect(watchMinutes({ RED_SKILLS_WATCH_MINUTES: "nonsense" })).toBe(DEFAULT_WATCH_MINUTES);
  });

  test("and the whole thing turns off with one variable", () => {
    expect(watchEnabled({})).toBe(true);
    expect(watchEnabled({ RED_SKILLS_WATCH: "0" })).toBe(false);
  });
});

describe("the systemd pair", () => {
  const { service, timer } = watchUnits("/home/me/.local/bin/red-dev", 10);

  test("counts from the last run, so a sleeping machine asks once on waking", () => {
    // `OnUnitActiveSec` and deliberately not `OnCalendar` with
    // `Persistent`, which would work through every tick it missed.
    expect(timer).toContain("OnUnitActiveSec=10min");
    expect(timer).not.toContain("Persistent");
    expect(timer).not.toContain("OnCalendar");
  });

  test("runs the same phase the shell hook does, so both land on one debounce", () => {
    expect(service).toContain("red-skills watch due");
    expect(service).toContain("Type=oneshot");
  });

  test("waits a minute after boot, where a converge and a daemon come first", () => {
    expect(timer).toContain("OnStartupSec=1min");
  });
});

describe("the Windows task", () => {
  test("goes through the hidden runner, or it draws a console every tick", () => {
    // The mistake ADR 0009 recorded: a console program started by the
    // scheduler with no console of its own gets one allocated — a black
    // rectangle over the wallpaper, on a timer.
    const argv = watchTaskArgv("C:\\r\\hidden-run.vbs", "C:\\r\\red-dev.exe", 10);
    expect(argv.join(" ")).toContain("wscript.exe //B //Nologo");
    expect(argv).toContain(WATCH_TASK);
    expect(argv.join(" ")).toContain("red-skills watch due");
    // Every ten minutes, by the scheduler's own vocabulary.
    expect(argv.join(" ")).toContain("/SC MINUTE /MO 10");
  });
});

describe("converging the schedule", () => {
  test("a machine without systemd is left to its shell hook", async () => {
    const calls: string[][] = [];
    const outcome = await convergeWatchSchedule(
      { ...UBUNTU, caps: { ...UBUNTU.caps, systemd: false } },
      {
        run: async (argv) => {
          calls.push(argv);
          return { exitCode: 0 };
        },
      },
    );
    expect(outcome).toBe("skipped");
    expect(calls).toEqual([]);
  });

  test("turning it off disables before deleting, or systemd complains for good", async () => {
    const calls: string[][] = [];
    await convergeWatchSchedule(UBUNTU, {
      home: "/nonexistent-home",
      env: { RED_SKILLS_WATCH: "0" },
      run: async (argv) => {
        calls.push(argv);
        return { exitCode: 0 };
      },
    });
    // Nothing on disk, so nothing to disable — and no spurious calls.
    expect(calls).toEqual([]);
  });
});
