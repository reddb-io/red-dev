/**
 * The audio Panel: which speaker the machine plays through, which
 * microphone it listens on, and what it takes to change either.
 *
 * The second Panel, built on the shape src/panel.ts holds and the
 * network Panel established. The same rule decides what it drives: the
 * platform's *first-party* CLI, never the files underneath it. `pactl`
 * on Ubuntu is that CLI — it speaks to the sound server the desktop is
 * already using, which under Ubuntu 24.04 is PipeWire wearing
 * pipewire-pulse — and writing a default into `~/.config/pulse` behind
 * its back would leave the running server and the Panel disagreeing
 * until the next login.
 *
 * ## Nothing here asks for rights, and that is the honest answer
 *
 * Observation is a read, as it is in every Panel. The change is a read's
 * neighbour: `pactl set-default-sink` moves the default of the sound
 * server running in the signed-in person's own session, which is theirs
 * to move. There is no sudo in this file at all, and adding one to match
 * the network Panel's shape would be the same erosion from the other
 * end — a password prompt for an act that never needed one teaches
 * people that the prompt means nothing.
 *
 * ## Windows has no first-party command for this, and says so
 *
 * Windows can be *asked* what audio endpoints exist —
 * `Get-PnpDevice -Class AudioEndpoint` is a shipped cmdlet and a read.
 * What it cannot be told, by anything Microsoft ships, is which endpoint
 * to make the default: the API behind its own Sound page (`IPolicyConfig`)
 * is undocumented and reachable from no shipped CLI. The honest options
 * were a Panel that lists devices and cannot switch between them, a
 * dependency on somebody's third-party cmdlet module, or opening the
 * page Windows already has and saying why. This Panel does the third —
 * `NativeFallback` carries the surface and the reason, and the reason is
 * printed rather than buried here (spec #134, `interaction/CONTEXT.md`).
 *
 * That is also why the fallback belongs to the *act* and not to the
 * Panel. Observation works on both targets, so opening the Panel on
 * Windows still answers "what does this machine have"; it is only the
 * switch that crosses to the host's own surface.
 */

import { panelTarget, runPlan, spawnCapture, windowsSurface } from "./panel.ts";
import type { Capture, NativeFallback, PanelPlan, PanelTarget, Run } from "./panel.ts";
import type { Platform } from "./platform.ts";

/** Which way the sound goes. */
export type AudioDirection = "output" | "input";

/** The two, in the order the Panel lists them. */
export const AUDIO_DIRECTIONS: readonly AudioDirection[] = ["output", "input"];

export interface AudioDevice {
  /**
   * What this platform's CLI takes back to make it the default.
   *
   * PulseAudio's sink or source name on Ubuntu — the long
   * `alsa_output.pci-…` string, not the index, because indices are
   * handed out afresh every time the server restarts and a Panel that
   * remembered one across a suspend would switch to whatever now holds
   * it. On Windows it is the endpoint's device instance id, which
   * nothing switches with; it is the row's identity and no more.
   */
  id: string;
  /** The name a person would recognise on the box in front of them. */
  name: string;
  direction: AudioDirection;
  /**
   * True when the machine is using it now.
   *
   * False for every Windows row, and not because they are all idle: the
   * PnP read says which endpoints exist and never which is default. A
   * Panel that guessed — the first one, the one that is enabled — would
   * be wrong on every machine with two speakers, and it would be wrong
   * silently.
   */
  current: boolean;
}

/** What the Panel shows, once the machine has been asked. */
export interface AudioView {
  target: PanelTarget | null;
  /** Outputs first, then inputs, each in the order the CLI gave them. */
  devices: AudioDevice[];
  /**
   * Null where this target can switch, and the reason it cannot where
   * it cannot.
   *
   * Carried on the view rather than discovered when Enter is pressed, so
   * the Panel can say what it will do before somebody asks it to do
   * something else.
   */
  native: NativeFallback | null;
}

/**
 * Windows' own Sound page, and why the Panel hands over to it.
 *
 * The surface is spelled the way Windows spells it, because a person
 * reading the sentence is about to go looking for it.
 */
export const WINDOWS_SOUND: NativeFallback = {
  surface: "Settings > System > Sound",
  reason:
    "Windows ships no first-party command that sets the default audio device, so red-dev opens the page that does rather than showing a switch that cannot switch",
};

const NOTHING: AudioView = { target: null, devices: [], native: null };

// ------------------------------------------------------- the observation

/**
 * The reads. Three commands on Ubuntu, one round trip on Windows.
 *
 * Ubuntu is asked three times because `pactl` answers one question per
 * invocation and the three answers do not correlate: a sink list, a
 * source list, and the two names the server currently calls default.
 * The defaults have to come from `info` — neither list marks its own
 * default, and inferring one from the order is how a Panel ends up
 * pointing at the HDMI output on every machine.
 *
 * `-f json` on all three. `pactl`'s human-readable form is indented
 * prose meant for reading, and a parser that walks it starts failing the
 * day a device description contains a colon.
 */
export function observeArgv(target: PanelTarget): readonly (readonly string[])[] {
  if (target === "linux") {
    return [
      ["pactl", "-f", "json", "info"],
      ["pactl", "-f", "json", "list", "sinks"],
      ["pactl", "-f", "json", "list", "sources"],
    ];
  }
  return [["powershell.exe", "-NoProfile", "-Command", WINDOWS_OBSERVE]];
}

/**
 * Observation as a plan, so it can be held to the rule every Panel keeps.
 *
 * `gate: null` is the claim; `observeArgv` is the evidence. Keeping them
 * in one object is what lets one test read both.
 */
export function observePlan(target: PanelTarget): PanelPlan {
  return {
    prime: null,
    steps: observeArgv(target),
    gate: null,
    note: "reads this machine and changes nothing",
  };
}

/**
 * The whole Windows read, in one script.
 *
 * `Get-PnpDevice -Class AudioEndpoint` is the shipped way to enumerate
 * what the Sound page lists, and it is a `Get-`, which is the whole
 * reason opening this Panel needs nothing. Errors are silenced rather
 * than thrown, exactly as the neighbouring probe in `lan-address.ts`
 * does — a machine without the PnpDevice module produces an empty list,
 * which the parser already reads as "no answer".
 */
const WINDOWS_OBSERVE = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$endpoints = @(Get-PnpDevice -Class AudioEndpoint |" +
    " ForEach-Object { [pscustomobject]@{ id = [string]$_.InstanceId;" +
    " name = [string]$_.FriendlyName; status = [string]$_.Status } })",
  "[pscustomobject]@{ endpoints = $endpoints } | ConvertTo-Json -Depth 4 -Compress",
].join("; ");

// -------------------------------------------------------------- ubuntu

type Record_ = { [key: string]: unknown };

function records(value: unknown): Record_[] {
  const many = Array.isArray(value) ? value : [value];
  return many.filter((v): v is Record_ => typeof v === "object" && v !== null);
}

function stringOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** The two names `pactl -f json info` reports as current. */
export function parsePactlDefaults(json: string): { sink: string | null; source: string | null } {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return { sink: null, source: null };
  }
  if (typeof payload !== "object" || payload === null) return { sink: null, source: null };
  const root = payload as Record_;
  return {
    sink: stringOf(root["default_sink_name"]),
    source: stringOf(root["default_source_name"]),
  };
}

/**
 * Read one `pactl -f json list` answer into rows.
 *
 * Monitor sources are dropped. Every sink has one — it is the loopback
 * that lets a screen recorder capture what is playing — and it appears
 * in the source list beside the real microphones. Offering them as
 * inputs would put "Monitor of Built-in Audio" one keystroke away from
 * being the machine's microphone, which records silence and sounds like
 * a broken headset.
 */
export function parsePactlDevices(
  json: string,
  direction: AudioDirection,
  current: string | null,
): AudioDevice[] {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return [];
  }

  const devices: AudioDevice[] = [];
  for (const entry of records(payload)) {
    const id = stringOf(entry["name"]);
    if (id === null || id.endsWith(".monitor")) continue;
    devices.push({
      id,
      // The description is the human name — "Built-in Audio Analog
      // Stereo" — and the name is the handle. A Panel that showed the
      // handle would be a list of `alsa_output.pci-0000_00_1f.3` rows.
      name: stringOf(entry["description"]) ?? id,
      direction,
      current: id === current,
    });
  }
  return devices;
}

// ------------------------------------------------------------- windows

/**
 * Which way a Windows audio endpoint points, read off its instance id.
 *
 * MMDEVAPI endpoint ids carry the data flow in their first brace:
 * `{0.0.0.00000000}` is render and `{0.0.1.00000000}` is capture. It is
 * a convention rather than a documented field, which is why an id that
 * matches neither is dropped rather than guessed at — a row in the wrong
 * half of the list is a person choosing a speaker as their microphone.
 */
export function endpointDirection(id: string): AudioDirection | null {
  if (id.includes("{0.0.0.00000000}")) return "output";
  if (id.includes("{0.0.1.00000000}")) return "input";
  return null;
}

/**
 * Read what the Windows script printed.
 *
 * Only endpoints Windows reports as `OK` are kept. The others are
 * devices it remembers rather than devices it has — a headset unplugged
 * three weeks ago is still in the PnP tree — and the Sound page does not
 * offer them either.
 */
export function parseWindowsEndpoints(json: string): AudioDevice[] {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    // PowerShell writes its errors where the JSON was meant to go, and a
    // machine that cannot answer is not a machine to guess about.
    return [];
  }
  if (typeof payload !== "object" || payload === null) return [];

  const devices: AudioDevice[] = [];
  for (const entry of records((payload as Record_)["endpoints"])) {
    const id = stringOf(entry["id"]);
    if (id === null) continue;
    if (stringOf(entry["status"]) !== "OK") continue;
    const direction = endpointDirection(id);
    if (direction === null) continue;
    devices.push({ id, name: stringOf(entry["name"]) ?? id, direction, current: false });
  }
  // Outputs first, then inputs, so the flat list the Panel draws reads
  // the way the two questions are asked.
  return [
    ...devices.filter((d) => d.direction === "output"),
    ...devices.filter((d) => d.direction === "input"),
  ];
}

// ------------------------------------------------------------- the seam

async function observeLinux(capture: Capture): Promise<AudioView> {
  const [info, sinks, sources] = observeArgv("linux");
  // Not `?? []` on the argv: these three are pinned by a test, and a
  // missing one is a programming error rather than a machine's answer.
  const defaults = info ? await capture(info) : { out: "", code: 127 };
  const outputs = sinks ? await capture(sinks) : { out: "", code: 127 };
  const inputs = sources ? await capture(sources) : { out: "", code: 127 };

  const current = defaults.code === 0
    ? parsePactlDefaults(defaults.out)
    : { sink: null, source: null };

  return {
    target: "linux",
    devices: [
      ...(outputs.code === 0 ? parsePactlDevices(outputs.out, "output", current.sink) : []),
      ...(inputs.code === 0 ? parsePactlDevices(inputs.out, "input", current.source) : []),
    ],
    // Ubuntu switches with the same binary it was asked with, so there
    // is nothing to hand over to.
    native: null,
  };
}

/** What this machine says about the sound it plays and hears. */
export async function observeAudio(
  p: Platform,
  capture: Capture = spawnCapture,
): Promise<AudioView> {
  const target = panelTarget(p);
  if (target === null) return NOTHING;
  if (target === "linux") return await observeLinux(capture);

  const [argv] = observeArgv("windows");
  // The limit does not depend on the read: Windows cannot switch whether
  // or not it managed to answer, so the reason is on the view either way.
  if (!argv) return { target, devices: [], native: WINDOWS_SOUND };
  const { out, code } = await capture(argv);
  return {
    target,
    devices: code === 0 ? parseWindowsEndpoints(out) : [],
    native: WINDOWS_SOUND,
  };
}

// ---------------------------------------------------------------- acting

/** Chosen, and the argv that carries it out — or the reason it cannot. */
export type AudioPlan =
  | ({ ok: true; device: AudioDevice; native: NativeFallback | null } & PanelPlan)
  | { ok: false; detail: string };

/**
 * What making `id` the default costs, given what the Panel is showing.
 *
 * Built from the observed view rather than from a target and a name, for
 * the reason `dnsPlan` gives: the id is what the platform's own CLI
 * takes back, so the device this switches to is by construction a device
 * on screen. A Panel that took an id from anywhere else could set the
 * default to a sink that no longer exists, which `pactl` accepts.
 */
export function audioPlan(view: AudioView, id: string): AudioPlan {
  if (view.target === null) {
    return { ok: false, detail: "red-dev has no audio adapter for this platform" };
  }

  const device = view.devices.find((d) => d.id === id);
  if (!device) {
    // Refused rather than passed through. An id the machine did not
    // report is either a device that has just been unplugged or a bug,
    // and `pactl` says nothing useful about either.
    return { ok: false, detail: `not a device this machine reported: ${id}` };
  }

  if (view.target === "linux") {
    return {
      ok: true,
      device,
      native: null,
      prime: null,
      // One act, and no elevation: this moves the default of the sound
      // server in this session. Streams that follow the default follow
      // it here; one an application has pinned to a device stays where
      // it was put, which is the application's choice to have made and
      // not something a default is allowed to override.
      steps: [
        ["pactl", device.direction === "output" ? "set-default-sink" : "set-default-source", device.id],
      ],
      gate: null,
      note: `${device.name} for ${device.direction}`,
    };
  }

  return {
    ok: true,
    device,
    native: WINDOWS_SOUND,
    prime: null,
    steps: [windowsSurface("ms-settings:sound")],
    gate: null,
    note: `${WINDOWS_SOUND.surface} — ${WINDOWS_SOUND.reason}`,
  };
}

/** Changed, or the reason it was not — either way, one line. */
export interface AudioOutcome {
  changed: boolean;
  detail: string;
}

/**
 * Carry a plan out, and be exact about what happened.
 *
 * Opening the host's own page is not a switch. The window opens, the
 * command exits zero, and the machine is playing through exactly what it
 * was playing through a moment ago — so `changed` stays false and the
 * line says where the switch now lives. Reporting it as a change would
 * be the Panel taking credit for a page it opened.
 */
export async function applyAudio(plan: AudioPlan, run: Run): Promise<AudioOutcome> {
  if (!plan.ok) return { changed: false, detail: plan.detail };
  const outcome = await runPlan(plan, run);
  if (!outcome.done) return { changed: false, detail: outcome.detail };
  return { changed: plan.native === null, detail: `audio: ${plan.note}` };
}

/**
 * The view as text, for a terminal with no Panel to draw.
 *
 * Not a degraded mode: this is the form a bug report pastes and a script
 * greps. The limit is a line of its own where there is one, because a
 * Windows machine printing "not reported" twice with no explanation
 * reads as a broken probe rather than as a stated boundary.
 */
export function panelLines(view: AudioView): string[] {
  const current = (direction: AudioDirection): string =>
    view.devices.find((d) => d.direction === direction && d.current)?.name ?? "not reported";
  const count = (direction: AudioDirection): number =>
    view.devices.filter((d) => d.direction === direction).length;

  const lines = [
    `output   ${current("output")}`,
    `input    ${current("input")}`,
    `devices  ${count("output")} out, ${count("input")} in`,
  ];
  if (view.native !== null) {
    lines.push(`switch   ${view.native.surface} — ${view.native.reason}`);
  }
  return lines;
}
