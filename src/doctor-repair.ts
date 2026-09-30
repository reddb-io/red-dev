import { windowsWsl } from "./workstation.ts";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";

export const DOCTOR_REPAIRS = ["mise-auth", "workloads", "desktop"] as const;
export type DoctorRepair = typeof DOCTOR_REPAIRS[number];
export const REPAIR_CHANGES: Record<DoctorRepair, readonly string[]> = {
  "mise-auth": ["replace the managed gh credential helper without calling mise", "refresh the owned mise fragment; back up obsolete personal gh overrides", "keep tokens in gh storage; install or upgrade no packages"],
  workloads: ["archive and remove obsolete red-dev Cargo settings, shell wrappers and systemd resource definitions", "disable the retired disk guardian and release live red-dev resource controls without restarting processes", "retire marked WSL resource rows while preserving settings of other owners"],
  desktop: ["reconcile the managed GNOME menu and shortcuts; a fresh login may remain necessary"],
};

async function repairLocal(p: Platform, repair: DoctorRepair, apply = false,
  injected?: (repair: DoctorRepair) => Promise<number>,
): Promise<number> {
  log.step(`repair plan: ${repair}`);
  for (const change of REPAIR_CHANGES[repair]) log.plain(`  - ${change}`);
  if ((repair === "desktop" && (p.os !== "linux" || p.env !== "desktop")) ||
    (repair === "workloads" && p.os !== "linux" && p.os !== "windows")) {
    log.err(`${repair} repair is unavailable on this target`); return 1;
  }
  if (!apply) {
    log.plain(`Preview only. Apply with: red-dev doctor --repair ${repair} --apply`);
    return 0;
  }
  if (injected) return injected(repair);
  if (repair === "mise-auth") {
    const { convergeMiseConfig } = await import("./mise-config.ts");
    const result = convergeMiseConfig(p);
    log.ok(`mise authentication ${result.changed ? "repaired" : "already current"}`);
    return 0;
  }
  if (repair === "workloads") {
    const { convergeBuildResources } = await import("./build-resources.ts");
    await convergeBuildResources(p);
    const { inspectBuildResources } = await import("./build-resources.ts");
    const findings = await inspectBuildResources(p);
    const problems = findings.filter(finding => finding.status === "drift");
    for (const problem of problems) log.warn(problem.detail);
    return problems.length > 0 ? 1 : 0;
  }
  const { desktopCommand } = await import("./desktop.ts");
  return desktopCommand(p, "reconcile");
}

export async function doctorRepair(p: Platform, repair: DoctorRepair, apply = false,
  injected?: (repair: DoctorRepair) => Promise<number>,
): Promise<number> {
  const own = await repairLocal(p, repair, apply, injected);
  if (!windowsWsl(p) || repair === "desktop") return own;
  const { relayWslCommand } = await import("./wsl-sync.ts");
  const child = await relayWslCommand(p, `red-dev doctor --repair ${repair}${apply ? " --apply" : ""}`);
  return own === 0 && child === 0 ? 0 : 1;
}
