/**
 * The clock under `latest`.
 *
 * A `latest` selector is only as current as the last upgrade that read
 * it. Measured here: Claude Code 2.1.284 published and the copy on PATH
 * still on 2.1.283, because nothing had asked mise since.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTO_UPDATE_SERVICE,
  AUTO_UPDATE_TIMER,
  DEFAULT_AUTO_UPDATE_MINUTES,
  autoUpdateEnabled,
  autoUpdateMinutes,
  autoUpdateUnits,
  convergeAutoUpdateSchedule,
} from "./auto-update-schedule.ts";
import type { Platform } from "./platform.ts";

const UBUNTU: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

const WINDOWS: Platform = {
  ...UBUNTU,
  os: "windows",
  distro: "windows",
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
};

describe("the interval", () => {
  test("is an hour unless somebody says otherwise", () => {
    expect(autoUpdateMinutes({})).toBe(DEFAULT_AUTO_UPDATE_MINUTES);
    expect(DEFAULT_AUTO_UPDATE_MINUTES).toBe(60);
    expect(autoUpdateMinutes({ RED_DEV_AUTO_UPDATE_MINUTES: "30" })).toBe(30);
  });

  test("is clamped rather than refused", () => {
    expect(autoUpdateMinutes({ RED_DEV_AUTO_UPDATE_MINUTES: "1" })).toBe(15);
    expect(autoUpdateMinutes({ RED_DEV_AUTO_UPDATE_MINUTES: "99999" })).toBe(1440);
    expect(autoUpdateMinutes({ RED_DEV_AUTO_UPDATE_MINUTES: "soon" })).toBe(60);
  });

  test("and the whole thing turns off with one variable", () => {
    expect(autoUpdateEnabled({})).toBe(true);
    expect(autoUpdateEnabled({ RED_DEV_AUTO_UPDATE: "0" })).toBe(false);
  });
});

describe("the systemd pair", () => {
  const { service, timer } = autoUpdateUnits("/home/me/.local/bin/red-dev", 60, "/usr/bin:/home/me/.local/bin");

  test("runs the unattended update and nothing that needs a person", () => {
    expect(service).toContain("red-dev update --unattended");
    expect(service).toContain("Type=oneshot");
  });

  test("runs through a login shell with the converge's PATH behind it", () => {
    expect(service).toContain("ExecStart=/bin/bash -lc");
    expect(service).toContain('PATH="$PATH:$RED_DEV_PATH"');
    expect(service).toContain('Environment="RED_DEV_PATH=/usr/bin:/home/me/.local/bin"');
  });

  test("stays out of the way of whoever is working", () => {
    expect(service).toContain("Nice=15");
    expect(service).toContain("IOSchedulingClass=idle");
    expect(service).toContain("TimeoutStartSec=30min");
  });

  test("counts from the last run and never replays missed ticks", () => {
    expect(timer).toContain("OnUnitActiveSec=60min");
    expect(timer).not.toContain("Persistent=");
    expect(timer).not.toContain("OnCalendar");
    expect(timer).toContain(`Unit=${AUTO_UPDATE_SERVICE}`);
  });
});

describe("converging the schedule", () => {
  const recorder = () => {
    const calls: string[][] = [];
    return {
      calls,
      run: async (argv: string[]) => {
        calls.push(argv);
        return { exitCode: 0 };
      },
    };
  };

  test("Windows is left manual for now", async () => {
    const r = recorder();
    expect(await convergeAutoUpdateSchedule(WINDOWS, { run: r.run })).toBe("skipped");
    expect(r.calls).toEqual([]);
  });

  test("a machine without systemd is left manual", async () => {
    const r = recorder();
    const outcome = await convergeAutoUpdateSchedule(
      { ...UBUNTU, caps: { ...UBUNTU.caps, systemd: false } },
      { run: r.run },
    );
    expect(outcome).toBe("skipped");
    expect(r.calls).toEqual([]);
  });

  test("writes the pair, enables it, and is quiet the second time", async () => {
    const home = mkdtempSync(join(tmpdir(), "red-dev-auto-update-"));
    try {
      const r = recorder();
      const seams = { home, env: { PATH: "/usr/bin" }, run: r.run, binary: "/opt/red-dev" };
      expect(await convergeAutoUpdateSchedule(UBUNTU, seams)).toBe("installed");
      const dir = join(home, ".config/systemd/user");
      expect(readFileSync(join(dir, AUTO_UPDATE_SERVICE), "utf8")).toContain("/opt/red-dev update --unattended");
      expect(existsSync(join(dir, AUTO_UPDATE_TIMER))).toBe(true);
      expect(r.calls).toContainEqual(["systemctl", "--user", "enable", "--now", AUTO_UPDATE_TIMER]);

      r.calls.length = 0;
      expect(await convergeAutoUpdateSchedule(UBUNTU, seams)).toBe("unchanged");
      expect(r.calls).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("turning it off disables before deleting", async () => {
    const home = mkdtempSync(join(tmpdir(), "red-dev-auto-update-"));
    try {
      const r = recorder();
      await convergeAutoUpdateSchedule(UBUNTU, { home, env: {}, run: r.run, binary: "/opt/red-dev" });
      r.calls.length = 0;

      const outcome = await convergeAutoUpdateSchedule(UBUNTU, {
        home,
        env: { RED_DEV_AUTO_UPDATE: "0" },
        run: r.run,
      });
      expect(outcome).toBe("removed");
      expect(r.calls[0]).toEqual(["systemctl", "--user", "disable", "--now", AUTO_UPDATE_TIMER]);
      expect(existsSync(join(home, ".config/systemd/user", AUTO_UPDATE_TIMER))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
