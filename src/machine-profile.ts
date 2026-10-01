/** Durable desired configuration. Observations and credentials never belong here. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Platform } from "./platform.ts";
import { devConfigPath, legacyProfilePath, readDevConfig, writeDevConfig, renderDevConfig, legacyDevConfig } from "./dev-config.ts";
import { parseResourceSettings, type ResourceSettings } from "./resource-settings.ts";

export const PROFILE_NAMES = ["ubuntu-desktop", "ubuntu-server", "ubuntu-wsl", "windows-wsl", "windows-native"] as const;
export type ProfileName = typeof PROFILE_NAMES[number];
export interface MachineProfile {
  schema: 1;
  name: ProfileName;
  /** Explicit package/configuration choices; false preserves installed bytes. */
  tools: Record<string, boolean>;
  agents?: string[];
  runtimes?: string[];
  apps?: string[];
  distro?: string;
  /** User-selected resources; ordinary install/update never reapplies them. */
  resources?: ResourceSettings;
}
export const REQUIRED_TOOLS = new Set(["mise", "red-dev", "retired-resource-controls", "maintenance-schedule", "wsl-sync"]);
export function profilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RED_DEV_PROFILE_FILE || devConfigPath(env);
}
export function parseMachineProfile(value: unknown): MachineProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid machine profile");
  const p = value as MachineProfile;
  if (p.schema !== 1 || !PROFILE_NAMES.includes(p.name) || !p.tools || typeof p.tools !== "object" || Array.isArray(p.tools)) throw new Error("invalid machine profile schema, name or tools");
  for (const [name, enabled] of Object.entries(p.tools)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || typeof enabled !== "boolean") throw new Error(`invalid profile tool: ${name}`);
    if (!enabled && REQUIRED_TOOLS.has(name)) throw new Error(`${name} is required for configuration lifecycle`);
  }
  for (const key of ["agents", "runtimes", "apps"] as const) {
    if (p[key] !== undefined && (!Array.isArray(p[key]) || p[key]!.some(v => typeof v !== "string" || !v.trim()))) throw new Error(`invalid profile ${key}`);
  }
  if (p.distro !== undefined && (typeof p.distro !== "string" || !p.distro.trim() || /[\r\n\0]/.test(p.distro))) throw new Error("invalid profile distro");
  if (p.resources !== undefined) parseResourceSettings(p.resources);
  return p;
}
export function readMachineProfile(env: NodeJS.ProcessEnv = process.env): MachineProfile | null {
  if (!env.RED_DEV_PROFILE_FILE) {
    const config = readDevConfig(env);
    if (config) return config.profile === undefined ? null : parseMachineProfile(config.profile);
  }
  const path = legacyProfilePath(env);
  return existsSync(path) ? parseMachineProfile(JSON.parse(readFileSync(path, "utf8"))) : null;
}
export function writeMachineProfile(profile: MachineProfile, env: NodeJS.ProcessEnv = process.env): void {
  readMachineProfile(env); // Never replace malformed or unknown existing data.
  if (!env.RED_DEV_PROFILE_FILE) {
    writeDevConfig(current => ({ ...current, profile: parseMachineProfile(profile) as unknown as Record<string, unknown> }), env);
    return;
  }
  const path = profilePath(env);
  const bytes = JSON.stringify(parseMachineProfile(profile), null, 2) + "\n";
  if (existsSync(path) && readFileSync(path, "utf8") === bytes) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes, { mode: 0o600 });
  renameSync(tmp, path);
}
export function renderMachineProfile(profile: MachineProfile, env: NodeJS.ProcessEnv = process.env): string {
  parseMachineProfile(profile);
  if (env.RED_DEV_PROFILE_FILE) return JSON.stringify(profile, null, 2) + "\n";
  const path = devConfigPath(env);
  const current = readDevConfig(env) ?? legacyDevConfig(env);
  return renderDevConfig({ ...current, profile: profile as unknown as Record<string, unknown> }, existsSync(path) ? readFileSync(path, "utf8") : undefined);
}
export function compatibleProfile(name: ProfileName, p: Platform): boolean {
  return p.os === "windows" ? name.startsWith("windows-") : p.env === "wsl" ? name === "ubuntu-wsl"
    : p.os === "linux" && (name === "ubuntu-desktop" || name === "ubuntu-server");
}
export function inferredProfileName(p: Platform, shell?: string): ProfileName {
  if (p.os === "windows") return shell === "gitbash" ? "windows-native" : "windows-wsl";
  return p.env === "wsl" ? "ubuntu-wsl" : p.env === "server" ? "ubuntu-server" : "ubuntu-desktop";
}
export function profileToolEnabled(p: Platform, name: string, scope?: string): boolean {
  const profile = p.profile;
  if (!profile || REQUIRED_TOOLS.has(name)) return true;
  if (profile.tools[name] !== undefined) return profile.tools[name]!;
  if (scope === "optional") return profile.apps?.includes(name) ?? false;
  return true;
}
