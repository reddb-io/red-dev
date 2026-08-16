/**
 * What the power Panel runs, and what it never runs.
 *
 * The argv is the artefact under test, for the reason the network
 * Panel's tests give: this process runs on one machine and the Panel has
 * to be right about two, one of which it meets only through WSL
 * interop. So every command is pinned word for word, per target, for the
 * read and for each of the three profiles.
 *
 * Two claims are this Panel's own.
 *
 * The reads are unprivileged, which is a real claim here rather than a
 * formality: most of `powercfg`'s switches need administrator, and
 * `/list` is one of the ones that does not. So is the *change* — the
 * host's own menu switches profiles in one click on both platforms — and
 * a test pins that too, because the failure mode this Panel has is the
 * opposite of the network Panel's. Growing a password prompt for an act
 * that never needed one teaches people that prompts mean nothing just as
 * effectively as a missing one does.
 *
 * And the Panel offers what the machine has, never what the platform is
 * supposed to have. Windows 11 hides the classic schemes on most
 * modern-standby machines; a laptop without power-profiles-daemon lists
 * nothing at all. On those, a well-known GUID sent anyway is a command
 * that fails, and the refusal that names what the machine does offer is
 * the more useful answer.
 */

import { describe, expect, test } from "bun:test";
import { applicableScopes } from "./manifest.ts";
import {
  applyPower,
  observeArgv,
  observePlan,
  observePower,
  panelLines,
  parsePowercfgSchemes,
  parsePowerProfiles,
  parseUpower,
  parseWindowsBattery,
  POWER_PROFILES,
  powerPlan,
  WINDOWS_SCHEMES,
  type PowerView,
} from "./panel-power.ts";
import { raisesRights, type Captured } from "./panel.ts";
import type { Platform } from "./platform.ts";
import { batchScript, privilegedItems } from "./privileged.ts";

function machine(over: Partial<Platform>): Platform {
  return {
    os: "linux",
    distro: "ubuntu",
    version: "24.04",
    codename: "noble",
    env: "desktop",
    arch: "x64",
    caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
    ...over,
  };
}

const desktop = machine({});
const wsl = machine({
  env: "wsl",
  caps: { apt: true, gui: false, systemd: false, winget: true, flatpak: false },
});
const windows = machine({ os: "windows", env: "windows", distro: null, version: null, codename: null });
const mac = machine({ os: "darwin", env: "desktop", distro: null, version: null, codename: null });

/** A laptop with all three profiles, as observation would report it. */
const onUbuntu: PowerView = {
  target: "linux",
  profile: "balanced",
  offered: ["power-saver", "balanced", "performance"],
  battery: { percent: 74, state: "discharging" },
};

const onWindows: PowerView = {
  target: "windows",
  profile: "balanced",
  offered: ["power-saver", "balanced", "performance"],
  battery: { percent: 91, state: "charging" },
};

describe("observation, pinned per target", () => {
  test("Ubuntu asks the profiles daemon what it has, and upower how long is left", () => {
    // `list` rather than `get`, because which profiles exist is the half
    // that decides what the Panel is allowed to offer.
    expect(observeArgv("linux")).toEqual([
      ["powerprofilesctl", "list"],
      ["upower", "-i", "/org/freedesktop/UPower/devices/DisplayDevice"],
    ]);
  });

  test("Windows asks powercfg for its schemes, and WMI for the battery", () => {
    expect(observeArgv("windows")).toEqual([
      ["powercfg.exe", "/list"],
      [
        "powershell.exe",
        "-NoProfile",
        "-Command",
        "$ErrorActionPreference = 'SilentlyContinue'; " +
          "$battery = @(Get-CimInstance Win32_Battery | ForEach-Object { [pscustomobject]@{" +
          " percent = [int]$_.EstimatedChargeRemaining; status = [int]$_.BatteryStatus } }); " +
          "[pscustomobject]@{ battery = $battery } | ConvertTo-Json -Depth 4 -Compress",
      ],
    ]);
  });

  test("in two round trips on both, because the two answers cannot go stale on each other", () => {
    // The network Panel folds its Windows reads into one script because
    // an interface index joins them. A battery percentage and a list of
    // schemes are independent, so there is nothing to synchronise.
    for (const target of ["linux", "windows"] as const) {
      expect(observeArgv(target)).toHaveLength(2);
    }
  });
});

describe("looking is never a privileged act", () => {
  for (const target of ["linux", "windows"] as const) {
    test(`on ${target}, no observation argv reaches for rights`, () => {
      const plan = observePlan(target);
      expect(plan.gate).toBeNull();
      expect(plan.prime).toBeNull();
      for (const step of plan.steps) expect(raisesRights(step)).toBe(false);
    });

    test(`on ${target}, every observation command is a read`, () => {
      // powercfg is the one worth naming: most of its switches need
      // administrator, and /list is not one of them. A read that had
      // drifted to /setactive would still pass raisesRights.
      for (const step of observePlan(target).steps) {
        const words = step.join(" ");
        expect(words).not.toContain("sudo");
        expect(words).not.toContain("RunAs");
        expect(words).not.toContain("/setactive");
        expect(words).not.toContain("Set-");
        expect(words).not.toMatch(/\bset\b/);
      }
    });
  }
});

describe("each profile, pinned per target", () => {
  test("Ubuntu hands the name straight to the daemon GNOME's own menu uses", () => {
    const plan = powerPlan(onUbuntu, "performance");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.steps).toEqual([["powerprofilesctl", "set", "performance"]]);
    expect(plan.prime).toBeNull();
    expect(plan.gate).toBeNull();
  });

  test("Windows activates the scheme by GUID, because the name is translated", () => {
    const plan = powerPlan(onWindows, "performance");
    expect(plan.ok && plan.steps).toEqual([
      ["powercfg.exe", "/setactive", "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"],
    ]);
  });

  test("and the other two carry the other two built-in GUIDs", () => {
    expect(powerPlan(onWindows, "power-saver").ok && powerPlan(onWindows, "power-saver")).toMatchObject({
      steps: [["powercfg.exe", "/setactive", "a1841308-3541-4fab-bc81-f71556f20b4a"]],
    });
    expect(powerPlan(onWindows, "balanced").ok && powerPlan(onWindows, "balanced")).toMatchObject({
      steps: [["powercfg.exe", "/setactive", "381b4222-f694-41f0-9685-ff5bb260df2e"]],
    });
  });

  test("the same three words drive both targets, which is the point of the Panel", () => {
    // A person who learned "performance" on their laptop should not have
    // to learn "High performance" again on the other machine.
    for (const profile of POWER_PROFILES) {
      expect(powerPlan(onUbuntu, profile).ok).toBe(true);
      expect(powerPlan(onWindows, profile).ok).toBe(true);
    }
  });

  test("no target builds a switch that asks for a password", () => {
    // The inverse of the network Panel's rule, and the reason it is
    // pinned: both hosts change this from their own menus without a
    // prompt, so a Panel that grew one would be asking for consent it
    // does not need — which is how consent stops meaning anything.
    for (const view of [onUbuntu, onWindows]) {
      for (const profile of POWER_PROFILES) {
        const plan = powerPlan(view, profile);
        expect(plan.ok).toBe(true);
        if (!plan.ok) continue;
        expect(plan.gate).toBeNull();
        expect(plan.prime).toBeNull();
        expect(plan.steps.some((step) => raisesRights(step))).toBe(false);
      }
    }
  });
});

describe("a change the Panel cannot make", () => {
  test("to a profile the machine does not have, names what it does have", () => {
    // Windows 11 hides the classic schemes on most modern-standby
    // machines. Sending the well-known GUID anyway is a command that
    // fails; this is the more useful answer.
    const plan = powerPlan({ ...onWindows, offered: ["balanced"] }, "performance");
    expect(plan.ok).toBe(false);
    expect(plan.ok || plan.detail).toBe("this machine has no Performance profile — it offers Balanced");
  });

  test("on a machine offering nothing at all, says so rather than listing an empty set", () => {
    const plan = powerPlan({ ...onUbuntu, offered: [] }, "balanced");
    expect(plan.ok || plan.detail).toContain("it offers none");
  });

  test("on a platform with no adapter, is refused by name", () => {
    const plan = powerPlan({ ...onUbuntu, target: null }, "balanced");
    expect(plan.ok).toBe(false);
    expect(plan.ok || plan.detail).toContain("no power adapter");
  });
});

describe("reading what Ubuntu said", () => {
  const LIST = [
    "* balanced:",
    "    CpuDriver:  intel_pstate",
    "    Degraded:   no",
    "",
    "  performance:",
    "    CpuDriver:  intel_pstate",
    "",
    "  power-saver:",
    "    CpuDriver:  intel_pstate",
  ].join("\n");

  const UPOWER = [
    "Device: /org/freedesktop/UPower/devices/DisplayDevice",
    "  power supply:         yes",
    "  updated:              Sun 16 Aug 2026 03:00:00 (12 seconds ago)",
    "  battery",
    "    present:             yes",
    "    state:               discharging",
    "    warning-level:       none",
    "    percentage:          74%",
    "    icon-name:          'battery-good-symbolic'",
  ].join("\n");

  test("takes the marked profile as the active one, and lists them in the Panel's order", () => {
    // The daemon prints the active one first; the Panel's order is
    // saver to performance, and a list that reordered itself per machine
    // would put a different row under the cursor on each.
    expect(parsePowerProfiles(LIST)).toEqual({
      offered: ["power-saver", "balanced", "performance"],
      active: "balanced",
    });
  });

  test("a daemon that is not there offers nothing, rather than the three by default", () => {
    expect(parsePowerProfiles("")).toEqual({ offered: [], active: null });
  });

  test("reads the battery off the composite device", () => {
    expect(parseUpower(UPOWER)).toEqual({ percent: 74, state: "discharging" });
  });

  test("a machine that says it has no battery is believed", () => {
    // Printing "0% — unknown" on a workstation would be a fault report
    // about a machine with nothing wrong with it.
    const desktopOut = ["  battery", "    present:             no", "    state:               unknown"].join("\n");
    expect(parseUpower(desktopOut)).toEqual({ percent: null, state: "none" });
    expect(parseUpower("")).toEqual({ percent: null, state: "none" });
  });

  test("plugged in and not charging is its own answer, not charging", () => {
    const pending = ["    present:             yes", "    state:               pending-charge", "    percentage:          80%"].join("\n");
    expect(parseUpower(pending)).toEqual({ percent: 80, state: "mains" });
  });

  test("and puts the two answers together into one view", async () => {
    const capture = async (cmd: readonly string[]): Promise<Captured> =>
      cmd[0] === "powerprofilesctl" ? { out: LIST, code: 0 } : { out: UPOWER, code: 0 };

    expect(await observePower(desktop, capture)).toEqual({
      target: "linux",
      profile: "balanced",
      offered: ["power-saver", "balanced", "performance"],
      battery: { percent: 74, state: "discharging" },
    });
  });

  test("a battery probe that could not run is unknown, and not a machine without one", async () => {
    const capture = async (cmd: readonly string[]): Promise<Captured> =>
      cmd[0] === "powerprofilesctl" ? { out: LIST, code: 0 } : { out: "", code: 127 };
    const view = await observePower(desktop, capture);
    expect(view.battery).toEqual({ percent: null, state: "unknown" });
  });

  test("and a platform red-dev has no adapter for says so rather than guessing", async () => {
    expect(await observePower(mac, async () => ({ out: "", code: 0 }))).toMatchObject({
      target: null,
      offered: [],
    });
  });
});

describe("reading what Windows said", () => {
  /** A Portuguese install, to prove nothing is matched on the name. */
  const SCHEMES = [
    "",
    "Esquemas de Energia Existentes (* Ativo)",
    "-----------------------------------",
    "GUID do Esquema de Energia: 381b4222-f694-41f0-9685-ff5bb260df2e  (Equilibrado) *",
    "GUID do Esquema de Energia: a1841308-3541-4fab-bc81-f71556f20b4a  (Economia de energia)",
    "GUID do Esquema de Energia: e9a42b02-d5df-448d-aa00-03f14749eb61  (Fabricante)",
  ].join("\r\n");

  test("matches the built-in schemes by GUID, and the active one by its asterisk", () => {
    // The bracketed names are translated; the GUIDs are the same on
    // every Windows since Vista, and the `*` is the only mark on the
    // line that is not localised.
    expect(parsePowercfgSchemes(SCHEMES)).toEqual({
      offered: ["power-saver", "balanced"],
      active: "balanced",
    });
  });

  test("a machine on an OEM scheme is on none of the three, rather than on a guess", () => {
    const oem = "GUID do Esquema de Energia: e9a42b02-d5df-448d-aa00-03f14749eb61  (Fabricante) *";
    expect(parsePowercfgSchemes(oem)).toEqual({ offered: [], active: null });
  });

  test("every profile's GUID is one powercfg would recognise", () => {
    for (const profile of POWER_PROFILES) {
      expect(WINDOWS_SCHEMES[profile]).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    }
  });

  test("reads the battery, and the on-AC state WMI will not call charging", () => {
    const charging = JSON.stringify({ battery: [{ percent: 91, status: 6 }] });
    expect(parseWindowsBattery(charging)).toEqual({ percent: 91, state: "charging" });

    // BatteryStatus 2 is documented as "the system has access to AC,
    // however the battery is not necessarily charging".
    const onMains = JSON.stringify({ battery: [{ percent: 100, status: 2 }] });
    expect(parseWindowsBattery(onMains)).toEqual({ percent: 100, state: "mains" });
  });

  test("a desktop with no Win32_Battery has no battery, which is an answer", () => {
    expect(parseWindowsBattery(JSON.stringify({ battery: [] }))).toEqual({
      percent: null,
      state: "none",
    });
  });

  test("PowerShell writing an error where the JSON belonged is not a machine to guess about", () => {
    expect(parseWindowsBattery("Get-CimInstance : not recognized")).toEqual({
      percent: null,
      state: "unknown",
    });
  });

  test("and WSL is asked the Windows host's questions, because the battery is the host's", async () => {
    const capture = async (cmd: readonly string[]): Promise<Captured> =>
      cmd[0] === "powercfg.exe"
        ? { out: SCHEMES, code: 0 }
        : { out: JSON.stringify({ battery: [{ percent: 55, status: 1 }] }), code: 0 };

    for (const p of [windows, wsl]) {
      expect(await observePower(p, capture)).toEqual({
        target: "windows",
        profile: "balanced",
        offered: ["power-saver", "balanced"],
        battery: { percent: 55, state: "discharging" },
      });
    }
  });
});

describe("carrying a plan out", () => {
  test("runs the one command and reports the change", async () => {
    const ran: string[][] = [];
    const outcome = await applyPower(powerPlan(onUbuntu, "power-saver"), async (argv) => {
      ran.push([...argv]);
      return 0;
    });
    expect(ran).toEqual([["powerprofilesctl", "set", "power-saver"]]);
    expect(outcome).toEqual({ changed: true, detail: "power: Power saver" });
  });

  test("a command that failed names the exit code, not a rights problem", async () => {
    // There is no gate here. A machine whose scheme is locked by policy
    // says so through powercfg; inventing "this needs administrator"
    // would send whoever reads it looking for a prompt that never was.
    const outcome = await applyPower(powerPlan(onWindows, "performance"), async () => 1);
    expect(outcome.changed).toBe(false);
    expect(outcome.detail).toBe("powercfg.exe failed — exit 1");
  });

  test("a refusal runs nothing at all", async () => {
    let calls = 0;
    const outcome = await applyPower(powerPlan({ ...onUbuntu, offered: [] }, "balanced"), async () => {
      calls++;
      return 0;
    });
    expect(calls).toBe(0);
    expect(outcome.changed).toBe(false);
  });
});

describe("no Panel act reaches the converge's privileged batch", () => {
  test("the composed batch script carries none of the Panel's commands", async () => {
    // The same decision the network Panel's tests pin, read for this
    // Panel's binaries: a power act in the batch would take effect at
    // the end of somebody's next converge instead of when it was asked
    // for.
    for (const p of [desktop, wsl, windows]) {
      const script = await batchScript(privilegedItems(p, applicableScopes(p)), "C:\\tmp\\r.txt");
      expect(script).not.toContain("powerprofilesctl");
      expect(script).not.toContain("powercfg");
      expect(script).not.toContain("upower");
    }
  });
});

describe("the Panel as text, for a terminal with none to draw", () => {
  test("carries the profile, what else is on offer, and the battery", () => {
    expect(panelLines(onUbuntu)).toEqual([
      "profile  Balanced",
      "offered  Power saver, Balanced, Performance",
      "battery  74% — discharging",
    ]);
  });

  test("says a machine is on none of the three rather than picking one", () => {
    const lines = panelLines({ ...onWindows, profile: null, offered: ["balanced"] });
    expect(lines[0]).toBe("profile  not one of the three");
    expect(lines[1]).toBe("offered  Balanced");
  });

  test("and a machine with no battery says none, not a percentage it does not have", () => {
    const lines = panelLines({ ...onUbuntu, battery: { percent: null, state: "none" } });
    expect(lines[2]).toBe("battery  none");
  });
});
