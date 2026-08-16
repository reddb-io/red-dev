/**
 * What the audio Panel runs, what it never runs, and what it admits it
 * cannot do.
 *
 * The argv is the artefact under test, for the reason the network
 * Panel's tests give: the machine this process runs on has one sound
 * stack, the Panel has to be right about two, and one of those two it
 * will only ever meet through WSL interop. So every command is pinned
 * word for word, per target, for the read and for the switch.
 *
 * The third claim is the one this Panel adds to the family. Windows
 * ships no first-party command that sets the default audio device, and
 * the decision (spec #134) is that the act opens the host's own page and
 * says why, rather than red-dev drawing a switch that cannot switch. A
 * reason nobody can print is a limit that has been hidden, so the test
 * holds both halves: the argv opens `ms-settings:sound`, and the plan
 * carries a sentence explaining it.
 */

import { describe, expect, test } from "bun:test";
import { applicableScopes } from "./manifest.ts";
import {
  applyAudio,
  audioPlan,
  endpointDirection,
  observeArgv,
  observeAudio,
  observePlan,
  panelLines,
  parsePactlDefaults,
  parsePactlDevices,
  parseWindowsEndpoints,
  WINDOWS_SOUND,
  type AudioView,
} from "./panel-audio.ts";
import { listStep, raisesRights, type Captured, type PanelKey } from "./panel.ts";
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

/** A laptop with its speakers and a plugged-in headset, as observed. */
const onUbuntu: AudioView = {
  target: "linux",
  devices: [
    {
      id: "alsa_output.pci-0000_00_1f.3.analog-stereo",
      name: "Built-in Audio Analog Stereo",
      direction: "output",
      current: true,
    },
    { id: "alsa_output.usb-Headset", name: "USB Headset", direction: "output", current: false },
    {
      id: "alsa_input.pci-0000_00_1f.3.analog-stereo",
      name: "Built-in Audio Analog Stereo",
      direction: "input",
      current: true,
    },
  ],
  native: null,
};

/** The same machine on Windows: endpoints listed, nothing marked current. */
const onWindows: AudioView = {
  target: "windows",
  devices: [
    {
      id: "SWD\\MMDEVAPI\\{0.0.0.00000000}.{aaaa}",
      name: "Speakers (Realtek Audio)",
      direction: "output",
      current: false,
    },
    {
      id: "SWD\\MMDEVAPI\\{0.0.1.00000000}.{bbbb}",
      name: "Microphone (Realtek Audio)",
      direction: "input",
      current: false,
    },
  ],
  native: WINDOWS_SOUND,
};

/** No key pressed; each test turns on the one it means. */
function press(over: Partial<PanelKey> = {}): PanelKey {
  return {
    upArrow: false,
    downArrow: false,
    return: false,
    escape: false,
    backspace: false,
    delete: false,
    ctrl: false,
    ...over,
  };
}

describe("observation, pinned per target", () => {
  test("Ubuntu asks the sound server three questions, because it answers one at a time", () => {
    // The defaults come from `info` and not from the lists: neither list
    // marks its own default, and taking the first row instead is how a
    // Panel ends up pointing at the HDMI output on every machine.
    expect(observeArgv("linux")).toEqual([
      ["pactl", "-f", "json", "info"],
      ["pactl", "-f", "json", "list", "sinks"],
      ["pactl", "-f", "json", "list", "sources"],
    ]);
  });

  test("Windows asks once, and gets the endpoints back as JSON", () => {
    // Pinned whole, because the script is the argv.
    expect(observeArgv("windows")).toEqual([
      [
        "powershell.exe",
        "-NoProfile",
        "-Command",
        "$ErrorActionPreference = 'SilentlyContinue'; " +
          "$endpoints = @(Get-PnpDevice -Class AudioEndpoint | ForEach-Object { [pscustomobject]@{" +
          " id = [string]$_.InstanceId; name = [string]$_.FriendlyName;" +
          " status = [string]$_.Status } }); " +
          "[pscustomobject]@{ endpoints = $endpoints } | ConvertTo-Json -Depth 4 -Compress",
      ],
    ]);
  });

  test("asks in JSON on both, rather than parsing prose meant for reading", () => {
    // `pactl`'s human-readable output is indented paragraphs, and a
    // parser walking them starts failing the day a device description
    // contains a colon.
    for (const step of observeArgv("linux")) expect(step).toContain("json");
    expect(observeArgv("windows")[0]?.[3]).toContain("ConvertTo-Json");
  });
});

describe("looking is never a privileged act", () => {
  for (const target of ["linux", "windows"] as const) {
    test(`on ${target}, no observation argv reaches for rights`, () => {
      const plan = observePlan(target);
      // Both halves. `gate` is the claim the code makes about itself and
      // `raisesRights` reads the words that actually run, so a plan
      // cannot say null while quietly carrying a sudo.
      expect(plan.gate).toBeNull();
      expect(plan.prime).toBeNull();
      for (const step of plan.steps) expect(raisesRights(step)).toBe(false);
    });

    test(`on ${target}, every observation command is a read`, () => {
      // Named rather than implied by raisesRights: a cmdlet that writes
      // without elevating is still not something opening a Panel does.
      for (const step of observePlan(target).steps) {
        const words = step.join(" ");
        expect(words).not.toContain("Set-");
        expect(words).not.toContain("sudo");
        expect(words).not.toContain("RunAs");
        expect(words).not.toContain("set-default");
      }
    });
  }
});

describe("switching, pinned per target", () => {
  test("Ubuntu moves the sound server's default sink, and asks for nothing", () => {
    // No sudo and no prime. This is the signed-in person's own session,
    // and a password prompt for an act that never needed one teaches
    // people that the prompt means nothing.
    const plan = audioPlan(onUbuntu, "alsa_output.usb-Headset");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.steps).toEqual([["pactl", "set-default-sink", "alsa_output.usb-Headset"]]);
    expect(plan.prime).toBeNull();
    expect(plan.gate).toBeNull();
    expect(plan.native).toBeNull();
    expect(raisesRights(plan.steps[0] ?? [])).toBe(false);
  });

  test("an input row moves the source instead, because they are two settings", () => {
    const plan = audioPlan(onUbuntu, "alsa_input.pci-0000_00_1f.3.analog-stereo");
    expect(plan.ok && plan.steps).toEqual([
      ["pactl", "set-default-source", "alsa_input.pci-0000_00_1f.3.analog-stereo"],
    ]);
  });

  test("Windows opens its own Sound page, and carries the reason it does", () => {
    // The claim spec #134 makes about a subsystem with no first-party
    // CLI: the act resolves to the host's surface, and the limit is
    // stated rather than hidden.
    const plan = audioPlan(onWindows, "SWD\\MMDEVAPI\\{0.0.0.00000000}.{aaaa}");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.steps).toEqual([["cmd.exe", "/c", "start", "", "ms-settings:sound"]]);
    expect(plan.native?.surface).toBe("Settings > System > Sound");
    expect(plan.native?.reason).toContain("no first-party command");
    expect(plan.note).toContain(WINDOWS_SOUND.reason);
  });

  test("and it does not reach for rights to open a page either", () => {
    const plan = audioPlan(onWindows, "SWD\\MMDEVAPI\\{0.0.1.00000000}.{bbbb}");
    expect(plan.ok && plan.gate).toBeNull();
    expect(plan.ok && plan.prime).toBeNull();
    for (const step of plan.ok ? plan.steps : []) expect(raisesRights(step)).toBe(false);
  });

  test("no target builds a switch that asks for a password", () => {
    // The complement of the network Panel's rule, and the reason this
    // one is worth pinning: changing DNS is system configuration and
    // costs a prompt; moving your own session's default speaker is not,
    // and must not grow one because the neighbouring Panel has it.
    for (const view of [onUbuntu, onWindows]) {
      for (const device of view.devices) {
        const plan = audioPlan(view, device.id);
        expect(plan.ok).toBe(true);
        if (!plan.ok) continue;
        expect(plan.gate).toBeNull();
        expect(plan.steps.some((step) => raisesRights(step))).toBe(false);
      }
    }
  });
});

describe("a switch the Panel cannot make", () => {
  test("to a device this machine never reported, is refused rather than passed through", () => {
    // `pactl` accepts the name of a sink that no longer exists and
    // reports nothing, which is the quietest way for a Panel to be wrong.
    const plan = audioPlan(onUbuntu, "alsa_output.usb-Gone");
    expect(plan.ok).toBe(false);
    expect(plan.ok || plan.detail).toContain("not a device this machine reported");
  });

  test("on a platform with no adapter, is refused by name", () => {
    const plan = audioPlan({ ...onUbuntu, target: null }, "alsa_output.usb-Headset");
    expect(plan.ok).toBe(false);
    expect(plan.ok || plan.detail).toContain("no audio adapter");
  });
});

describe("reading what Ubuntu said", () => {
  const INFO = JSON.stringify({
    default_sink_name: "alsa_output.pci-0000_00_1f.3.analog-stereo",
    default_source_name: "alsa_input.pci-0000_00_1f.3.analog-stereo",
  });

  const SINKS = JSON.stringify([
    {
      index: 47,
      name: "alsa_output.pci-0000_00_1f.3.analog-stereo",
      description: "Built-in Audio Analog Stereo",
    },
    { index: 52, name: "alsa_output.usb-Headset", description: "USB Headset" },
  ]);

  const SOURCES = JSON.stringify([
    {
      index: 48,
      name: "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor",
      description: "Monitor of Built-in Audio Analog Stereo",
    },
    {
      index: 49,
      name: "alsa_input.pci-0000_00_1f.3.analog-stereo",
      description: "Built-in Audio Analog Stereo",
    },
  ]);

  test("takes the current device from info, and the names from the lists", () => {
    expect(parsePactlDefaults(INFO).sink).toBe("alsa_output.pci-0000_00_1f.3.analog-stereo");
    expect(parsePactlDevices(SINKS, "output", parsePactlDefaults(INFO).sink)).toEqual([
      {
        id: "alsa_output.pci-0000_00_1f.3.analog-stereo",
        name: "Built-in Audio Analog Stereo",
        direction: "output",
        current: true,
      },
      {
        id: "alsa_output.usb-Headset",
        name: "USB Headset",
        direction: "output",
        current: false,
      },
    ]);
  });

  test("never offers a monitor source as a microphone", () => {
    // Every sink has one, it sits in the source list beside the real
    // microphones, and choosing it records silence.
    const inputs = parsePactlDevices(SOURCES, "input", null);
    expect(inputs.map((d) => d.id)).toEqual(["alsa_input.pci-0000_00_1f.3.analog-stereo"]);
  });

  test("and puts the three answers together into one view", async () => {
    const capture = async (cmd: readonly string[]): Promise<Captured> => {
      if (cmd.includes("info")) return { out: INFO, code: 0 };
      if (cmd.includes("sinks")) return { out: SINKS, code: 0 };
      return { out: SOURCES, code: 0 };
    };

    const view = await observeAudio(desktop, capture);
    expect(view.target).toBe("linux");
    expect(view.native).toBeNull();
    expect(view.devices.map((d) => d.name)).toEqual([
      "Built-in Audio Analog Stereo",
      "USB Headset",
      "Built-in Audio Analog Stereo",
    ]);
    expect(view.devices.filter((d) => d.current).map((d) => d.direction)).toEqual([
      "output",
      "input",
    ]);
  });

  test("a machine with no sound server reports nothing rather than inventing a device", async () => {
    const capture = async (): Promise<Captured> => ({ out: "", code: 127 });
    expect(await observeAudio(desktop, capture)).toEqual({
      target: "linux",
      devices: [],
      native: null,
    });
  });

  test("and a platform red-dev has no adapter for says so rather than guessing", async () => {
    expect(await observeAudio(mac, async () => ({ out: "", code: 0 }))).toEqual({
      target: null,
      devices: [],
      native: null,
    });
  });
});

describe("reading what Windows said", () => {
  const JSON_OUT = JSON.stringify({
    endpoints: [
      {
        id: "SWD\\MMDEVAPI\\{0.0.0.00000000}.{aaaa}",
        name: "Speakers (Realtek Audio)",
        status: "OK",
      },
      {
        id: "SWD\\MMDEVAPI\\{0.0.1.00000000}.{bbbb}",
        name: "Microphone (Realtek Audio)",
        status: "OK",
      },
      {
        id: "SWD\\MMDEVAPI\\{0.0.0.00000000}.{cccc}",
        name: "Headphones (Old Headset)",
        status: "Unknown",
      },
    ],
  });

  test("reads the direction off the endpoint id, which is where Windows keeps it", () => {
    expect(endpointDirection("SWD\\MMDEVAPI\\{0.0.0.00000000}.{aaaa}")).toBe("output");
    expect(endpointDirection("SWD\\MMDEVAPI\\{0.0.1.00000000}.{bbbb}")).toBe("input");
    // Neither: dropped rather than guessed at, because a row in the
    // wrong half is a person choosing a speaker as their microphone.
    expect(endpointDirection("USB\\VID_1234")).toBeNull();
  });

  test("keeps the endpoints Windows has and drops the ones it merely remembers", () => {
    expect(parseWindowsEndpoints(JSON_OUT)).toEqual([
      {
        id: "SWD\\MMDEVAPI\\{0.0.0.00000000}.{aaaa}",
        name: "Speakers (Realtek Audio)",
        direction: "output",
        current: false,
      },
      {
        id: "SWD\\MMDEVAPI\\{0.0.1.00000000}.{bbbb}",
        name: "Microphone (Realtek Audio)",
        direction: "input",
        current: false,
      },
    ]);
  });

  test("marks nothing as current, because the PnP read never says which is", () => {
    // Guessing — the first one, the enabled one — would be wrong on
    // every machine with two speakers, and wrong silently.
    expect(parseWindowsEndpoints(JSON_OUT).some((d) => d.current)).toBe(false);
  });

  test("PowerShell writing an error where the JSON belonged yields no devices", () => {
    expect(parseWindowsEndpoints("Get-PnpDevice : not recognized")).toEqual([]);
  });

  test("a machine that could not answer still carries the limit, from WSL too", async () => {
    // The reason does not depend on the read: Windows cannot switch
    // whether or not it managed to list anything.
    for (const p of [windows, wsl]) {
      const view = await observeAudio(p, async () => ({ out: "", code: 1 }));
      expect(view).toEqual({ target: "windows", devices: [], native: WINDOWS_SOUND });
    }
  });
});

describe("carrying a plan out", () => {
  test("Ubuntu runs the one command and reports the change", async () => {
    const ran: string[][] = [];
    const outcome = await applyAudio(audioPlan(onUbuntu, "alsa_output.usb-Headset"), async (argv) => {
      ran.push([...argv]);
      return 0;
    });
    expect(ran).toEqual([["pactl", "set-default-sink", "alsa_output.usb-Headset"]]);
    expect(outcome).toEqual({ changed: true, detail: "audio: USB Headset for output" });
  });

  test("opening the host's page is reported as what it is, and not as a switch", async () => {
    // The window opens, the command exits zero, and the machine is
    // playing through exactly what it was playing through. Calling that
    // a change would be the Panel taking credit for a page it opened.
    const outcome = await applyAudio(
      audioPlan(onWindows, "SWD\\MMDEVAPI\\{0.0.0.00000000}.{aaaa}"),
      async () => 0,
    );
    expect(outcome.changed).toBe(false);
    expect(outcome.detail).toContain("Settings > System > Sound");
  });

  test("a command that failed names the exit code, not a rights problem", async () => {
    // There is no gate here, so inventing one would send whoever reads
    // the line looking for a password prompt that never existed.
    const outcome = await applyAudio(audioPlan(onUbuntu, "alsa_output.usb-Headset"), async () => 3);
    expect(outcome.changed).toBe(false);
    expect(outcome.detail).toBe("pactl failed — exit 3");
  });

  test("a refusal runs nothing at all", async () => {
    let calls = 0;
    const outcome = await applyAudio(audioPlan(onUbuntu, "nothing.like.this"), async () => {
      calls++;
      return 0;
    });
    expect(calls).toBe(0);
    expect(outcome.changed).toBe(false);
  });
});

describe("no Panel act reaches the converge's privileged batch", () => {
  // The same decision the network Panel's tests pin, read for this
  // Panel's binaries: "make this machine correct" and "change this now"
  // are different things, and an audio act in the batch would take
  // effect at the end of somebody's next converge.
  test("the composed batch script carries none of the Panel's commands", async () => {
    for (const p of [desktop, wsl, windows]) {
      const script = await batchScript(privilegedItems(p, applicableScopes(p)), "C:\\tmp\\r.txt");
      expect(script).not.toContain("pactl");
      expect(script).not.toContain("set-default-sink");
      expect(script).not.toContain("ms-settings:sound");
    }
  });
});

describe("the Panel as text, for a terminal with none to draw", () => {
  test("names what is playing and what is listening", () => {
    expect(panelLines(onUbuntu)).toEqual([
      "output   Built-in Audio Analog Stereo",
      "input    Built-in Audio Analog Stereo",
      "devices  2 out, 1 in",
    ]);
  });

  test("and on Windows says where switching lives, so two blanks are not a broken probe", () => {
    const lines = panelLines(onWindows);
    expect(lines.slice(0, 3)).toEqual([
      "output   not reported",
      "input    not reported",
      "devices  1 out, 1 in",
    ]);
    expect(lines[3]).toContain("Settings > System > Sound");
    expect(lines[3]).toContain("no first-party command");
  });
});

describe("the keyboard, shared by every Panel that is a list", () => {
  test("the arrows move between the rows and stop at the ends", () => {
    let state = listStep({ index: 0 }, 3, "", press({ upArrow: true })).state;
    expect(state.index).toBe(0);
    for (let i = 0; i < 9; i++) state = listStep(state, 3, "", press({ downArrow: true })).state;
    expect(state.index).toBe(2);
  });

  test("enter asks for the highlighted row", () => {
    expect(listStep({ index: 1 }, 3, "", press({ return: true })).apply).toBe(1);
  });

  test("a cursor left past the end by a device disappearing is clamped, not applied", () => {
    // The rows come from the machine and change underneath the cursor: a
    // headset unplugged between two observations leaves an index
    // pointing at a device that is gone.
    const step = listStep({ index: 7 }, 2, "", press({ return: true }));
    expect(step.apply).toBe(1);
    expect(step.state.index).toBe(1);
  });

  test("with no rows at all, enter asks for nothing", () => {
    expect(listStep({ index: 0 }, 0, "", press({ return: true })).apply).toBeUndefined();
  });

  test("typing is swallowed, because this is a list and not a search box", () => {
    expect(listStep({ index: 1 }, 3, "9", press())).toEqual({ state: { index: 1 } });
  });

  test("escape and ctrl+c leave, and every other ctrl chord is swallowed", () => {
    expect(listStep({ index: 1 }, 3, "", press({ escape: true })).quit).toBe(true);
    expect(listStep({ index: 1 }, 3, "c", press({ ctrl: true })).quit).toBe(true);
    expect(listStep({ index: 1 }, 3, "a", press({ ctrl: true })).quit).toBeUndefined();
  });
});
