/** Provider selection and observed action shared by plan and converge. */
import { describeProvider, providerFor, toolsInScope, needsAdmin, compareVersions, parseVersion, type InstallState, type Provider, type Scope, type Tool } from "./manifest.ts";
import { existsSync, realpathSync } from "node:fs";
import { miseToolBin } from "./mise-config.ts";
import type { Platform } from "./platform.ts";
import { profileToolEnabled } from "./machine-profile.ts";
import { toolPolicy, type ToolPolicy } from "./tool-policy.ts";
import { providerUsesSudo } from "./sudo-preflight.ts";

export type PlanAction = "install" | "upgrade" | "replace" | "reconcile" | "keep" | "skip" | "unmanage";
export interface ProvisionStep {
  tool: Tool;
  provider: Provider;
  target: "Windows" | "Ubuntu" | "Ubuntu/WSL";
  action: PlanAction;
  state: InstallState;
  policy?: ToolPolicy;
  reason?: string;
  /** false when rendering a remote environment that has not been queried. */
  observed: boolean;
  foundVersion?: string | null;
}
/** No vendor processes: even --version can install caches or start an application. */
function filesystemObservation(tool: Tool, provider: Provider): { state: InstallState; foundVersion?: string | null; uncertain?: boolean } {
  if (tool.managed) return { state: "absent" };
  if (tool.file) return { state: existsSync(tool.file) ? "ok" : "absent" };
  const paths = (tool.cmd ?? [tool.name]).map(cmd => {
    const expanded = cmd.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, key: string) => process.env[key] ?? m);
    return /[\\/]/.test(expanded) ? existsSync(expanded) ? expanded : null : Bun.which(expanded);
  }).filter((path): path is string => path !== null);
  if (!paths.length) return { state: "absent" };
  const alias = provider.kind === "mise" ? provider.alias ?? provider.spec : tool.name;
  if (provider.kind === "mise") {
    const managed = miseToolBin(alias, tool.cmd?.[0] ?? tool.name);
    if (managed) paths.push(managed);
  }
  const versions = paths.map(path => {
    try {
      const resolved = realpathSync(path).replaceAll("\\", "/");
      const marker = `/installs/${alias}/`;
      const folder = resolved.includes(marker) ? resolved.split(marker)[1]!.split("/")[0]! : null;
      return folder ? parseVersion(folder) : null;
    } catch { return null; }
  });
  const foundVersion = versions.find(v => v !== null) ?? null;
  // A colliding command (GNU red) cannot establish publisher identity.
  if (tool.signature && !foundVersion) return { state: "absent", uncertain: true };
  const exact = tool.pinVersion ?? (provider.kind === "mise" && /^v?\d+\.\d+/.test(provider.version ?? "") ? provider.version : undefined);
  if ((exact || tool.minVersion) && !foundVersion) return { state: "absent", uncertain: true };
  if (exact) return { state: compareVersions(foundVersion!, exact.replace(/^v/, "")) !== 0 ? "mismatched" : "ok", foundVersion };
  if (provider.kind === "mise" && toolPolicy(provider.alias ?? provider.spec, provider.spec).mode === "fixed") return { state: "ok", foundVersion };
  if (tool.minVersion && compareVersions(foundVersion!, tool.minVersion) < 0) return { state: "outdated", foundVersion };
  return { state: "ok", foundVersion };
}
export function planTool(tool: Tool, p: Platform, seams: { state?: (t: Tool) => InstallState; observed?: boolean } = {}): ProvisionStep {
  const provider = providerFor(tool, p);
  const observed = seams.observed !== false;
  const target = p.os === "windows" ? "Windows" : p.env === "wsl" ? "Ubuntu/WSL" : "Ubuntu";
  if (provider.kind === "skip") {
    const unmanage = !profileToolEnabled(p, tool.name, tool.scope) || provider.reason.startsWith("externally managed");
    return { tool, provider, target, action: unmanage ? "unmanage" : "skip", reason: provider.reason, state: "absent", observed };
  }
  const observation = observed ? seams.state ? { state: seams.state(tool) } : filesystemObservation(tool, provider) : { state: "absent" as const };
  const state = observation.state;
  const policy = provider.kind === "mise" ? toolPolicy(provider.alias ?? provider.spec, provider.spec) : undefined;
  const action: PlanAction = !observed ? (tool.managed ? "reconcile" : "install") : state === "ok" ? "keep" : tool.managed || observation.uncertain ? "reconcile" : state === "outdated" ? "upgrade" : state === "mismatched" ? "replace" : "install";
  return { tool, provider, target, action, state, policy, observed, foundVersion: observation.foundVersion,
    ...(observation.uncertain ? { reason: "version or publisher identity not observed; reconcile through the declared provider" } : {}) };
}
export function provisionPlan(p: Platform, scopes: readonly Scope[], seams: Parameters<typeof planTool>[2] = {}): ProvisionStep[] {
  return scopes.flatMap(scope => toolsInScope(scope).map(tool => planTool(tool, p, seams)));
}
export function planLine(step: ProvisionStep): string {
  const { tool, provider } = step;
  const ownership = step.policy ? `; ${step.policy.mode}${step.policy.mode === "fixed" ? ` ${step.policy.version}` : ""}` : "";
  const rights = needsAdmin(provider) ? "; administrator" : providerUsesSudo(provider) ? "; sudo if needed" : "";
  const reason = step.action === "unmanage" ? "; preserve installed package and personal files" : step.reason ? `; ${step.reason}` : "";
  const observation = step.observed ? "" : "; desired destination only, installation not observed";
  return `${tool.name.padEnd(25)} ${step.action.padEnd(10)} ${step.target} · ${describeProvider(provider)}${ownership}${rights}${reason}${observation}`;
}
/** Only probe version where a replacement/upgrade was already decided. */
export function plannedFoundVersion(step: ProvisionStep): string | null {
  return step.foundVersion ?? null;
}
