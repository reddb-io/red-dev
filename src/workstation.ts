import type { Platform } from "./platform.ts";
import type { Preferences } from "./preferences.ts";

export type Placement = "host" | "linux" | "both";
export function windowsWsl(p: Platform): boolean {
  return p.os === "windows" && p.workstation === "windows-wsl";
}
/** Scope chooses features; placement chooses the owner in a Windows/WSL pair. */
export function runsHere(placement: Placement, p: Platform): boolean {
  if (windowsWsl(p)) return placement !== "linux";
  if (p.env === "wsl") return placement !== "host";
  return true;
}
export function applyWorkstationPreferences(p: Platform, prefs: Preferences): Platform {
  if (p.os !== "windows") return p;
  p.workstation = prefs.terminalShell === "gitbash" ? "windows-native" : "windows-wsl";
  p.wslDistro = typeof prefs.distro === "string" && prefs.distro.trim() ? prefs.distro : undefined;
  return p;
}
export async function resolveWorkstation(p: Platform): Promise<Platform> {
  if (p.os !== "windows") return p;
  const { readPreferences } = await import("./preferences.ts");
  return applyWorkstationPreferences(p, await readPreferences(p));
}
