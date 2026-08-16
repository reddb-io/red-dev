/**
 * The power Panel: how hard this machine is allowed to work, and how
 * long it has left.
 *
 * The third Panel, on the shape src/panel.ts holds. The first-party CLI
 * rule picks what it drives on each side: `powerprofilesctl` on Ubuntu,
 * which is the command GNOME's own power menu goes through, and
 * `powercfg` on Windows, which has been the shipped tool for power
 * schemes since Vista. Neither side is written to by hand — a profile
 * poked into sysfs is one that power-profiles-daemon overwrites the next
 * time anything asks it for anything.
 *
 * ## The same three words on both, which is the whole point
 *
 * Ubuntu names its profiles `power-saver`, `balanced` and `performance`.
 * Windows ships three schemes meaning the same three things under
 * different names and behind GUIDs. The Panel speaks the first set on
 * both targets, because a person who learns "performance" on their
 * laptop should not have to learn "High performance" again on the other
 * machine — that is the same promise ADR 0006 makes about chords, kept
 * one layer down.
 *
 * ## Nothing here asks for rights either
 *
 * Observation is a read on both sides. So, near enough, is the change:
 * power-profiles-daemon lets the active session switch profiles without
 * a polkit prompt, which is why GNOME's menu can do it in one click, and
 * Windows lets the signed-in person pick their own scheme without a
 * consent shield on its own Settings page. So this Panel raises nothing.
 * If a machine's policy has locked the scheme, the command says so and
 * `applyPower` reports the exit code rather than inventing a rights
 * problem the person would then go looking for.
 *
 * ## What the machine offers is what the Panel offers
 *
 * Both plans are built from the observed view, so the Panel never sends
 * a name the machine did not list. That is not defensiveness: a laptop
 * without power-profiles-daemon lists nothing, and Windows 11 hides the
 * classic schemes on most modern-standby machines and keeps the
 * three-way choice in its battery flyout instead. On those, `powercfg`
 * really has no High performance scheme to activate, and a Panel that
 * sent the well-known GUID anyway would report a switch that the machine
 * refused.
 */

import { panelTarget, runPlan, spawnCapture } from "./panel.ts";
import type { Capture, PanelPlan, PanelTarget, Run } from "./panel.ts";
import type { Platform } from "./platform.ts";

/** The three, in the order the Panel offers them. */
export type PowerProfile = "power-saver" | "balanced" | "performance";

export const POWER_PROFILES: readonly PowerProfile[] = ["power-saver", "balanced", "performance"];

/** What the Panel calls each one, and the sentence under it. */
export const POWER_LABELS: Record<PowerProfile, { label: string; detail: string }> = {
  "power-saver": { label: "Power saver", detail: "quieter and slower, longer on a charge" },
  balanced: { label: "Balanced", detail: "what the machine ships on" },
  performance: { label: "Performance", detail: "faster and hotter, shorter on a charge" },
};

/**
 * The Windows scheme behind each profile, by GUID.
 *
 * By GUID and never by name, because the name is translated: the scheme
 * called "Balanced" on this machine is "Equilibrado" on the next one,
 * and a parser matching the word would work on English installs and
 * quietly find nothing everywhere else. These three GUIDs are the
 * built-in schemes and are the same on every Windows since Vista.
 */
export const WINDOWS_SCHEMES: Record<PowerProfile, string> = {
  "power-saver": "a1841308-3541-4fab-bc81-f71556f20b4a",
  balanced: "381b4222-f694-41f0-9685-ff5bb260df2e",
  performance: "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c",
};

/**
 * What the battery is doing, in the words both sides can honestly
 * produce.
 *
 * `mains` is its own answer rather than a synonym for charging, because
 * both platforms report exactly that state and neither means charging by
 * it: upower's `pending-charge` is a battery that is plugged in and not
 * taking current, and WMI's BatteryStatus 2 is documented as "the system
 * has access to AC, however the battery is not necessarily charging".
 * Folding either into `charging` would be the Panel making a claim the
 * machine declined to make.
 */
export type BatteryState = "charging" | "discharging" | "full" | "mains" | "none" | "unknown";

export interface Battery {
  /** Null when the machine has no battery, or would not say. */
  percent: number | null;
  state: BatteryState;
}

/** What the Panel shows, once the machine has been asked. */
export interface PowerView {
  target: PanelTarget | null;
  /**
   * The profile the machine is on, when it is one of the three.
   *
   * Null covers a machine running an OEM or hand-made scheme. Saying
   * "Balanced" about it would be a guess, and the person looking at the
   * Panel is the one who would have to discover it was wrong.
   */
  profile: PowerProfile | null;
  /** The ones this machine actually has, in the Panel's own order. */
  offered: PowerProfile[];
  battery: Battery;
}

const NO_BATTERY: Battery = { percent: null, state: "none" };

const NOTHING: PowerView = {
  target: null,
  profile: null,
  offered: [],
  battery: NO_BATTERY,
};

// ------------------------------------------------------- the observation

/**
 * The reads. Two commands per target, and two round trips on both.
 *
 * Two rather than one, unlike the network Panel, because nothing here
 * correlates: a battery percentage and a list of power schemes are
 * independent answers, and there is no index to go stale between them.
 * The network Panel folds its Windows reads into one script precisely
 * because its three answers are joined by an interface index that two
 * adapters coming up mid-read would invalidate.
 */
export function observeArgv(target: PanelTarget): readonly (readonly string[])[] {
  if (target === "linux") {
    return [
      // `list` rather than `get`: it answers both questions at once,
      // marking the active profile with a `*` among the ones the daemon
      // has — and which ones exist is the half that decides what the
      // Panel may offer.
      ["powerprofilesctl", "list"],
      // The composite device, not a numbered one. UPower publishes
      // DisplayDevice as the single battery a desktop would draw, which
      // is the same thing this Panel wants and saves it choosing between
      // BAT0 and BAT1 on a ThinkPad.
      ["upower", "-i", "/org/freedesktop/UPower/devices/DisplayDevice"],
    ];
  }
  return [
    ["powercfg.exe", "/list"],
    ["powershell.exe", "-NoProfile", "-Command", WINDOWS_BATTERY],
  ];
}

/**
 * Observation as a plan, so it can be held to the rule every Panel keeps.
 *
 * `gate: null` is the claim; `observeArgv` is the evidence. `powercfg`
 * is the interesting one here — most of its switches need administrator
 * and `/list` is not one of them, which is exactly why the read is
 * pinned rather than assumed.
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
 * The Windows battery read.
 *
 * `Win32_Battery` is absent on a desktop rather than empty, which is the
 * answer the Panel wants: no battery, said by the machine. Errors are
 * silenced as the neighbouring probe in `lan-address.ts` does, so a
 * machine without the CIM class produces an empty list instead of
 * PowerShell's error text where the JSON belonged.
 */
const WINDOWS_BATTERY = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$battery = @(Get-CimInstance Win32_Battery |" +
    " ForEach-Object { [pscustomobject]@{ percent = [int]$_.EstimatedChargeRemaining;" +
    " status = [int]$_.BatteryStatus } })",
  "[pscustomobject]@{ battery = $battery } | ConvertTo-Json -Depth 4 -Compress",
].join("; ");

// -------------------------------------------------------------- ubuntu

/**
 * Parse `powerprofilesctl list` into what the daemon has and what it is
 * on.
 *
 * The output is a block per profile, each headed by its name and the
 * active one marked with a `*`. Only the three names the Panel knows are
 * kept: a daemon that grows a fourth is reporting something this Panel
 * has no word for, and listing it would offer a row whose meaning is
 * unknown on the other target.
 */
export function parsePowerProfiles(out: string): { offered: PowerProfile[]; active: PowerProfile | null } {
  const offered: PowerProfile[] = [];
  let active: PowerProfile | null = null;

  for (const line of out.split(/\r?\n/)) {
    const m = /^(\*?)\s*([a-z][a-z-]*):\s*$/.exec(line.trim());
    const name = m?.[2];
    if (!name || !POWER_PROFILES.includes(name as PowerProfile)) continue;
    const profile = name as PowerProfile;
    if (!offered.includes(profile)) offered.push(profile);
    if (m?.[1] === "*") active = profile;
  }

  // In the Panel's order, not the daemon's: the rows mean saver to
  // performance, and a list that reordered itself between machines would
  // put a different profile under the cursor on each one.
  return { offered: POWER_PROFILES.filter((p) => offered.includes(p)), active };
}

/**
 * upower's states, in the Panel's words.
 *
 * `empty` and `unknown` both land on `unknown`: a running machine whose
 * battery reports empty is a machine whose battery is not being read
 * properly, and there is nothing true to say about it in one word.
 */
const UPOWER_STATES: Record<string, BatteryState> = {
  charging: "charging",
  discharging: "discharging",
  "fully-charged": "full",
  "pending-charge": "mains",
  "pending-discharge": "mains",
};

/**
 * Parse `upower -i` on the composite battery device.
 *
 * `present: no` is the desktop answer and is taken at its word — a
 * machine that says it has no battery is not a machine with an unknown
 * one, and printing "0% — unknown" on a workstation would be a fault
 * report about a machine with nothing wrong with it.
 */
export function parseUpower(out: string): Battery {
  const field = (name: string): string | null => {
    const m = new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, "m").exec(out);
    return m?.[1] ?? null;
  };

  if (field("present") === "no") return NO_BATTERY;

  const state = field("state");
  if (state === null) return NO_BATTERY;

  const percentage = field("percentage");
  const percent = percentage === null ? null : Number.parseInt(percentage, 10);

  return {
    percent: percent === null || Number.isNaN(percent) ? null : percent,
    state: UPOWER_STATES[state] ?? "unknown",
  };
}

// ------------------------------------------------------------- windows

type Record_ = { [key: string]: unknown };

function records(value: unknown): Record_[] {
  const many = Array.isArray(value) ? value : [value];
  return many.filter((v): v is Record_ => typeof v === "object" && v !== null);
}

/**
 * Parse `powercfg /list` into the schemes this machine has.
 *
 * The GUID is found by its shape, anywhere on the line, because every
 * word around it is translated — the label reads `Power Scheme GUID:` on
 * an English install and `GUID do Esquema de Energia:` on a Portuguese
 * one, and anchoring on either spelling finds nothing on the other. The
 * GUID and the trailing `*` are the two things on the line that are the
 * same on every machine.
 *
 * A scheme this build has no word for is skipped, and an active one that
 * is skipped leaves `active` null, which is how a machine on an OEM
 * scheme is reported as being on none of the three rather than on
 * whichever GUID sorted first.
 */
export function parsePowercfgSchemes(out: string): {
  offered: PowerProfile[];
  active: PowerProfile | null;
} {
  const byGuid = new Map<string, PowerProfile>(
    POWER_PROFILES.map((p) => [WINDOWS_SCHEMES[p].toLowerCase(), p]),
  );

  const offered: PowerProfile[] = [];
  let active: PowerProfile | null = null;

  for (const line of out.split(/\r?\n/)) {
    const m = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(.*)$/i.exec(line);
    const guid = m?.[1]?.toLowerCase();
    if (guid === undefined) continue;
    const profile = byGuid.get(guid);
    if (profile === undefined) continue;
    if (!offered.includes(profile)) offered.push(profile);
    // The trailing `*` is how powercfg marks the active scheme, and it
    // is the only mark on the line that is not translated.
    if ((m?.[2] ?? "").trimEnd().endsWith("*")) active = profile;
  }

  return { offered: POWER_PROFILES.filter((p) => offered.includes(p)), active };
}

/**
 * WMI's BatteryStatus, in the Panel's words.
 *
 * 1 is the documented "Other", which every machine that reports it means
 * discharging by; 4 and 5 are Low and Critical, which are discharging
 * with an adjective. 2 is the on-AC-but-not-necessarily-charging state
 * that `mains` exists for, and 11 (partially charged, on AC) is the
 * same claim.
 */
const WMI_BATTERY_STATES: Record<number, BatteryState> = {
  1: "discharging",
  2: "mains",
  3: "full",
  4: "discharging",
  5: "discharging",
  6: "charging",
  7: "charging",
  8: "charging",
  9: "charging",
  11: "mains",
};

/** Read what the Windows battery script printed. */
export function parseWindowsBattery(json: string): Battery {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    // PowerShell writes its errors where the JSON was meant to go, and a
    // machine that cannot answer is not a machine to guess about.
    return { percent: null, state: "unknown" };
  }
  if (typeof payload !== "object" || payload === null) return { percent: null, state: "unknown" };

  const [battery] = records((payload as Record_)["battery"]);
  // No Win32_Battery at all is a desktop saying it has none, which is an
  // answer rather than a silence.
  if (!battery) return NO_BATTERY;

  const percent = battery["percent"];
  const status = battery["status"];
  return {
    percent: typeof percent === "number" && Number.isFinite(percent) ? percent : null,
    state: typeof status === "number" ? (WMI_BATTERY_STATES[status] ?? "unknown") : "unknown",
  };
}

// ------------------------------------------------------------- the seam

async function observeOne(
  capture: Capture,
  argv: readonly string[] | undefined,
): Promise<{ out: string; code: number }> {
  // Not `?? []` on the argv: these are pinned by a test, and a missing
  // one is a programming error rather than a machine's answer.
  return argv ? await capture(argv) : { out: "", code: 127 };
}

/** What this machine says about how hard it may work, and for how long. */
export async function observePower(
  p: Platform,
  capture: Capture = spawnCapture,
): Promise<PowerView> {
  const target = panelTarget(p);
  if (target === null) return NOTHING;

  const [profilesArgv, batteryArgv] = observeArgv(target);
  const profiles = await observeOne(capture, profilesArgv);
  const battery = await observeOne(capture, batteryArgv);

  const read = profiles.code === 0
    ? target === "linux"
      ? parsePowerProfiles(profiles.out)
      : parsePowercfgSchemes(profiles.out)
    : { offered: [] as PowerProfile[], active: null };

  return {
    target,
    profile: read.active,
    offered: read.offered,
    battery: battery.code !== 0
      // A battery probe that could not run says nothing about whether
      // there is a battery, so this is `unknown` and not `none`.
      ? { percent: null, state: "unknown" }
      : target === "linux"
        ? parseUpower(battery.out)
        : parseWindowsBattery(battery.out),
  };
}

// ---------------------------------------------------------------- acting

/** Chosen, and the argv that carries it out — or the reason it cannot. */
export type PowerPlan =
  | ({ ok: true; profile: PowerProfile } & PanelPlan)
  | { ok: false; profile: PowerProfile; detail: string };

/**
 * What switching to `profile` costs, given what the Panel is showing.
 *
 * Built from the observed view for the reason `dnsPlan` gives, with one
 * addition of its own: the view is also what says the profile exists
 * here. Sending Windows the High performance GUID on a machine that
 * lists only Balanced is a command that fails, and a refusal naming what
 * the machine does offer is more use than that failure.
 */
export function powerPlan(view: PowerView, profile: PowerProfile): PowerPlan {
  const target = view.target;

  if (target === null) {
    return { ok: false, profile, detail: "red-dev has no power adapter for this platform" };
  }

  if (!view.offered.includes(profile)) {
    const has = view.offered.length === 0
      ? "none"
      : view.offered.map((p) => POWER_LABELS[p].label).join(", ");
    return {
      ok: false,
      profile,
      detail: `this machine has no ${POWER_LABELS[profile].label} profile — it offers ${has}`,
    };
  }

  return {
    ok: true,
    profile,
    // No prime and no gate on either target: the host's own menu makes
    // this change in one click without a password or a consent shield,
    // and a Panel that asked for one anyway would be teaching people to
    // wave prompts through.
    prime: null,
    steps: [
      target === "linux"
        ? ["powerprofilesctl", "set", profile]
        : ["powercfg.exe", "/setactive", WINDOWS_SCHEMES[profile]],
    ],
    gate: null,
    note: POWER_LABELS[profile].label,
  };
}

/** Changed, or the reason it was not — either way, one line. */
export interface PowerOutcome {
  changed: boolean;
  detail: string;
}

/** Carry a plan out, and say how it ended. */
export async function applyPower(plan: PowerPlan, run: Run): Promise<PowerOutcome> {
  if (!plan.ok) return { changed: false, detail: plan.detail };
  const outcome = await runPlan(plan, run);
  return {
    changed: outcome.done,
    detail: outcome.done ? `power: ${plan.note}` : outcome.detail,
  };
}

/**
 * The view as text, for a terminal with no Panel to draw.
 *
 * Not a degraded mode: this is the form a bug report pastes and a script
 * greps. `offered` is on it because the interesting fault on this Panel
 * is a machine that offers one profile, and a view that printed only the
 * active one would look identical to a machine with all three.
 */
export function panelLines(view: PowerView): string[] {
  const offered = view.offered.length === 0
    ? "none reported"
    : view.offered.map((p) => POWER_LABELS[p].label).join(", ");
  const percent = view.battery.percent === null ? "" : `${view.battery.percent}% — `;
  return [
    `profile  ${view.profile === null ? "not one of the three" : POWER_LABELS[view.profile].label}`,
    `offered  ${offered}`,
    `battery  ${view.battery.state === "none" ? "none" : `${percent}${view.battery.state}`}`,
  ];
}
