/** Compatibility entry points for retiring the resource policy installed by older releases. */
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import { resourceRetirementPlan, retireResourceControls } from "./resource-retirement.ts";
import { localPath } from "./shared-root.ts";
import { windowsUserProfile } from "./wsl.ts";
import { existsSync } from "node:fs";

async function wslConfigPath(p: Platform): Promise<string | undefined> {
  if (p.os === "windows") return process.env.USERPROFILE ? `${process.env.USERPROFILE}/.wslconfig` : undefined;
  if (p.env !== "wsl") return undefined;
  return `${localPath(await windowsUserProfile(), "wsl")}/.wslconfig`;
}

export async function convergeBuildResources(p: Platform): Promise<void> {
  const result = await retireResourceControls(p, { wslConfigPath: await wslConfigPath(p) });
  for (const path of result.retired) log.ok(`retired resource definition: ${path}`);
  if (result.retired.length) log.info("Old red-dev resource controls removed; open new shells to discard already-loaded wrappers");
  else log.skip("no retired red-dev resource controls remain");
}

/** Report leftovers without treating absent old policies as missing configuration. */
export async function inspectBuildResources(p: Platform): Promise<Array<{
  name: string; status: "ok" | "drift"; detail: string; fix?: string;
}>> {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return [];
  const plan = resourceRetirementPlan(home, await wslConfigPath(p));
  const pendingReload = existsSync(`${home}/.local/state/red-dev/retired-resource-controls/pending-reload`);
  const drift = plan.changes.length > 0 || pendingReload;
  return [{ name: "retired resource controls", status: drift ? "drift" : "ok",
    detail: pendingReload ? "resource retirement still needs a systemd user reload" : plan.changes.length ? `${plan.changes.length} obsolete managed definition(s) remain` : "no recognised obsolete red-dev resource definitions remain",
    ...(drift ? { fix: "red-dev doctor --repair workloads --apply" } : {}),
  }];
}
