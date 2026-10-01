import type { Platform } from "./platform.ts";
import type { Invocation } from "./cli.ts";
import { log } from "./log.ts";
import { confirm, interactive, number, select, text } from "./ui.ts";
import { resourceOverview, resourceReport, resourceSnapshot, type ResourceSnapshot } from "./resource-diagnostics.ts";
import { machineResourcePlan, projectResourcePlan, resourceProjectRoot, readProjectResources, type ResourcePlan } from "./resource-plan.ts";
import { applyResourceEdits, resourceHistoryPath, undoResourceEdits, undoResourcePlan } from "./resource-files.ts";
import { suggestedWslMemory, type ResourceSettings } from "./resource-settings.ts";
import { withUpdateLock } from "./update-coordinator.ts";
import { readMachineProfile } from "./machine-profile.ts";

export function resourcePreview(plan: ResourcePlan): string[] {
  return ["Review resource changes", ...plan.details,
    ...plan.edits.filter(e => e.before !== e.after).map(e => `File: ${e.path} (${e.before === null ? "create" : e.after === null ? "remove" : "update"})`),
    "Undo restores the exact previous bytes if those files have not been changed elsewhere."];
}
async function apply(plan: ResourcePlan, approved: boolean): Promise<number> {
  log.plain(resourcePreview(plan).join("\n"));
  if (!approved) { log.plain("Preview only. Add --apply to save these choices."); return 0; }
  const result = await withUpdateLock(async () => { applyResourceEdits(plan.edits, plan.historyPath); return 0; });
  if (result.busy) { log.warn("another configuration or update is running; retry later"); return 2; }
  log.ok("resource choices saved");
  if (plan.restartWsl) log.info("WSL settings are pending your next restart; running workloads remain active");
  return 0;
}
async function undo(project: string | undefined, approved: boolean): Promise<number> {
  const path = resourceHistoryPath(project ? resourceProjectRoot(project) : undefined);
  const edits = undoResourcePlan(path);
  if (!edits.length) { log.plain("No resource changes to undo in this environment."); return 0; }
  log.plain(["Restore the previous resource change", ...edits.map(e => `File: ${e.path}`), "WSL changes take effect at your next restart."].join("\n"));
  if (!approved) { log.plain("Preview only. Add --apply to restore."); return 0; }
  const result = await withUpdateLock(async () => { undoResourceEdits(path); return 0; });
  if (result.busy) { log.warn("another configuration or update is running; retry later"); return 2; }
  log.ok("previous bytes restored; existing workloads remain active"); return 0;
}
function commandSettings(p: Platform, inv: Invocation, snapshot: ResourceSnapshot): ResourceSettings {
  const mode = inv.resourceMode;
  if (mode === "system") {
    if (inv.resourceMemory !== undefined || inv.resourceSwap !== undefined || inv.resourceSlots !== undefined) throw Error("system mode takes no resource limits");
    return { mode: "system" };
  }
  if (mode !== "custom" && mode !== "responsive") throw Error("configure expects system, responsive or custom");
  const wsl = p.os === "windows" || p.env === "wsl";
  const memory = inv.resourceMemory ?? (mode === "responsive" && wsl ? suggestedWslMemory(snapshot.windows?.total ?? null) : undefined);
  if (mode === "responsive" && wsl && memory === null) throw Error("Windows RAM could not be measured; choose custom with an explicit memory value");
  if (inv.resourceSwap !== undefined && memory === undefined) throw Error("--swap requires --memory");
  return { mode, ...(memory !== undefined && memory !== null ? { wsl: { memoryGiB: memory, swapGiB: inv.resourceSwap ?? 4 } } : {}),
    ...(inv.resourceSlots !== undefined || mode === "responsive" ? { buildSlots: inv.resourceSlots ?? 1 } : {}) };
}
export async function resourceWizard(p: Platform): Promise<number> {
  if (!interactive()) { log.plain(resourceReport(await resourceSnapshot(p)).join("\n")); return 0; }
  for (;;) {
    const snapshot = await resourceSnapshot(p); log.plain(resourceOverview(snapshot).join("\n"));
    const wsl = p.os === "windows" || p.env === "wsl";
    const choice = await select("Resources: choose what to configure", ["Keep current settings", "Use system settings", ...(wsl ? ["Preserve Windows responsiveness"] : []), "Customize", "Rust project", "Undo", "Details", "Inspect again"], "Keep current settings");
    if (choice === "Keep current settings") return 0;
    if (choice === "Inspect again") continue;
    if (choice === "Details") { log.plain(resourceReport(snapshot).join("\n")); await select("Resources", ["Back"], "Back"); continue; }
    if (choice === "Undo") {
      const scope = await select("Undo which resource choice?", ["Machine", "Rust project", "Back"], "Back");
      if (scope === "Back") continue;
      const project = scope === "Rust project" ? await text("Rust project directory", process.cwd()) : undefined;
      await undo(project, false);
      if (await confirm("Restore these files?", false)) return undo(project, true);
      continue;
    }
    try {
      let plan: ResourcePlan;
      if (choice === "Rust project") {
        const project = await text("Rust project directory", process.cwd());
        log.plain("Fewer jobs can reduce simultaneous compiler memory use. Direct Cargo and rust-analyzer retain their own configuration.");
        const jobs = await number("Cargo jobs for builds started through red-dev", 4, { min: 1, max: 256 });
        plan = projectResourcePlan(project, jobs);
      } else {
        const current = readMachineProfile()?.resources;
        const settings: ResourceSettings = { mode: choice === "Use system settings" ? "system" : choice === "Customize" ? "custom" : "responsive" };
        if (settings.mode !== "system") {
          if (p.os === "windows" || p.env === "wsl") {
            if (!snapshot.wsl.path) { log.warn("Windows configuration unavailable. Restore the Windows bridge, then inspect again."); continue; }
            const suggested = suggestedWslMemory(snapshot.windows?.total ?? null);
            log.plain(`WSL memory is shared by WSL 2 distributions. A ceiling leaves room for Windows but can cause OOM inside Linux.${suggested ? ` Suggested starting ceiling: ${suggested} GiB, based on host RAM.` : " Host RAM is unknown; enter a value you verified on Windows."}`);
            const memory = current?.wsl?.memoryGiB ?? suggested;
            settings.wsl = { memoryGiB: memory === null || memory === undefined ? Number(await text("Verified WSL memory ceiling in GiB")) : await number("WSL memory ceiling (GiB)", memory, { min: 1, max: 1024 }),
              swapGiB: await number("WSL swap (GiB); swap can absorb peaks but prolonged swapping slows builds", current?.wsl?.swapGiB ?? 4, { min: 0, max: 1024 }) };
          }
          if (await confirm("Coordinate builds started through red-dev in this environment?", false)) settings.buildSlots = await number("Concurrent participating builds", current?.buildSlots ?? 1, { min: 1, max: 64 });
          if (!settings.wsl && settings.buildSlots === undefined) { log.plain("No resource changes selected."); continue; }
        }
        plan = await machineResourcePlan(p, settings, snapshot);
      }
      log.plain(resourcePreview(plan).join("\n"));
      if (await confirm("Save these resource choices?", false)) return apply(plan, true);
    } catch (error) { log.err(error instanceof Error ? error.message : String(error)); }
  }
}
async function executeResourceCommand(p: Platform, inv: Invocation): Promise<number> {
  const action = inv.resourceAction ?? (interactive() && !inv.json ? "configure" : "status");
  if (action === "run") {
    const { runResourceBuild } = await import("./resource-build.ts");
    return runResourceBuild(inv.passthrough, inv.resourceProject);
  }
  if (action === "undo") return undo(inv.resourceProject, inv.apply);
  if (action === "project") {
    if (inv.resourceJobs === undefined) throw Error("project requires --jobs with an explicit Cargo job count");
    return apply(projectResourcePlan(inv.resourceProject, inv.resourceJobs), inv.apply);
  }
  if (action === "configure" && !inv.resourceMode) {
    if (!interactive()) throw Error("configure requires an explicit mode outside a terminal");
    return resourceWizard(p);
  }
  const snapshot = await resourceSnapshot(p);
  if (action === "status") {
    const project = inv.resourceProject ? { root: resourceProjectRoot(inv.resourceProject), settings: readProjectResources(resourceProjectRoot(inv.resourceProject)) } : undefined;
    if (inv.json) {
      // The host config may carry unrelated private values. Export observations only.
      log.plain(JSON.stringify({ ...snapshot, project, wsl: { ...snapshot.wsl, source: undefined } }, null, 2));
    } else {
      log.plain(resourceReport(snapshot).join("\n"));
      if (project) log.plain(`Project: ${project.root}; participating Cargo jobs=${project.settings?.jobs ?? "Cargo default"}`);
    }
    return 0;
  }
  if (action !== "configure") throw Error("resources expects status, configure, project, run or undo");
  return apply(await machineResourcePlan(p, commandSettings(p, inv, snapshot), snapshot), inv.apply);
}
export async function resourceCommand(p: Platform, inv: Invocation): Promise<number> {
  try { return await executeResourceCommand(p, inv); }
  catch (error) { log.err(error instanceof Error ? error.message : String(error)); return 1; }
}
