import type { Platform } from "./platform.ts";
import { TOOLS } from "./manifest.ts";
import { AGENTS, currentAgentKeys } from "./agents.ts";
import { isKnownRuntimeId } from "./runtimes.ts";
import { readPreferences } from "./preferences.ts";
import { compatibleProfile, inferredProfileName, readMachineProfile, writeMachineProfile, profilePath, PROFILE_NAMES, type MachineProfile, type ProfileName } from "./machine-profile.ts";
import { withUpdateLock } from "./update-coordinator.ts";
import { log } from "./log.ts";

export function validateProfile(profile: MachineProfile, p: Platform): void {
  if (!compatibleProfile(profile.name, p)) throw new Error(`profile ${profile.name} is incompatible with ${p.os}/${p.env}`);
  for (const name of Object.keys(profile.tools)) if (!TOOLS.some(t => t.name === name)) throw new Error(`unknown profile tool: ${name}`);
  for (const key of profile.agents ?? []) if (!AGENTS.some(a => a.key === key)) throw new Error(`unknown profile agent: ${key}`);
  for (const id of profile.runtimes ?? []) if (!isKnownRuntimeId(id)) throw new Error(`unknown profile runtime: ${id}`);
  for (const name of profile.apps ?? []) if (!TOOLS.some(t => t.name === name && t.scope === "optional")) throw new Error(`unknown profile app: ${name}`);
}
export async function resolveMachineProfile(p: Platform): Promise<MachineProfile> {
  const recorded = readMachineProfile();
  const prefs = recorded ? {} : await readPreferences(p, { strict: true, raw: true });
  let profile: MachineProfile = recorded ?? { schema: 1, name: inferredProfileName(p, prefs.terminalShell), tools: {},
    ...(prefs.agents !== undefined ? { agents: currentAgentKeys(prefs.agents) } : {}),
    ...(prefs.runtimes !== undefined ? { runtimes: prefs.runtimes } : {}),
    ...(prefs.apps !== undefined ? { apps: prefs.apps } : {}),
    ...(prefs.distro !== undefined ? { distro: prefs.distro } : {}) };
  if (p.env === "wsl" && process.env.RED_DEV_WSL_CHILD === "1" && process.env.RED_DEV_WSL_PROFILE) {
    const { parseMachineProfile } = await import("./machine-profile.ts");
    const parent = parseMachineProfile(JSON.parse(process.env.RED_DEV_WSL_PROFILE));
    if (parent.name !== "windows-wsl") throw new Error("invalid Windows coordinator profile");
    profile = { ...profile, ...parent, name: "ubuntu-wsl", tools: { ...profile.tools, ...parent.tools } };
  }
  validateProfile(profile, p);
  return profile;
}
export async function attachMachineProfile(p: Platform): Promise<MachineProfile> {
  const profile = await resolveMachineProfile(p);
  p.profile = profile;
  if (p.os === "windows") { p.workstation = profile.name as "windows-wsl" | "windows-native"; p.wslDistro = profile.distro; }
  return profile;
}
/** Called only under the installation writer. Read-only commands never adopt. */
export async function adoptMachineProfile(p: Platform): Promise<MachineProfile> {
  const profile = await attachMachineProfile(p);
  if (JSON.stringify(readMachineProfile()) !== JSON.stringify(profile)) { writeMachineProfile(profile); log.ok(`profile: recorded ${profile.name}; legacy preferences preserved`); }
  return profile;
}
export async function profileCommand(p: Platform, action = "show", value?: string): Promise<number> {
  if (action === "show") {
    const profile = await resolveMachineProfile(p);
    log.plain(`${profilePath()}${readMachineProfile() ? "" : " (inferred; not written)"}\n${JSON.stringify(profile, null, 2)}`);
    return 0;
  }
  if (!["adopt", "use", "enable", "disable"].includes(action)) throw new Error("profile action must be show, adopt, use, enable or disable");
  if (action === "adopt" && value) throw new Error("profile adopt takes no value");
  if (action === "use" && !PROFILE_NAMES.includes(value as ProfileName)) throw new Error(`profile use expects ${PROFILE_NAMES.join(", ")}`);
  if (["enable", "disable"].includes(action) && !TOOLS.some(t => t.name === value)) throw new Error(`unknown profile tool: ${value}`);
  const held = await withUpdateLock(async () => {
    const profile = await resolveMachineProfile(p);
    const next: MachineProfile = { ...profile, tools: { ...profile.tools } };
    if (action === "use") next.name = value as ProfileName;
    if (action === "enable" || action === "disable") next.tools[value!] = action === "enable";
    validateProfile(next, p);
    writeMachineProfile(next);
    p.profile = next;
    log.ok(`profile: ${next.name}; run red-dev plan, then red-dev install to apply`);
    return 0;
  });
  if (held.busy) { log.warn("another installation or update is running"); return 2; }
  return held.value;
}
