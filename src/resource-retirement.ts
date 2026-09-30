import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBounded, type BoundedCommandResult } from "./bounded-command.ts";
import { applyRetirement, planRetirement, type RetirementPlan, type RetiredDefinition } from "./managed-retirements.ts";
import type { Platform } from "./platform.ts";

export const RETIRED_SLICES = [
  "red-dev.slice", "red-dev-heavy.slice", "red-dev-interactive.slice",
  "red-dev-heavy-panes.slice", "red-dev-heavy-agents.slice", "red-dev-heavy-builds.slice",
] as const;
const ATTACHMENTS = [
  "redskilled.service.d/50-red-dev-heavy-slice.conf",
  "red-worker-.service.d/50-red-dev-heavy-slice.conf",
  "red-fleet-.scope.d/50-red-dev-heavy-slice.conf",
];
const GUARDIAN = ["red-dev-disk-guardian.timer", "red-dev-disk-guardian.service"];
const OWNER = /^# Managed by red-dev\./m;

export function retireLegacyRc(source: string): string | undefined {
  const loop = "for _red_part in path shared build-resources zellij; do";
  if (!source.startsWith("# Entry point sourced from ~/.bashrc:") || !source.includes(loop)) return undefined;
  return source.replace(loop, "for _red_part in path shared zellij; do");
}

export function retireLegacyZellij(source: string): string | undefined {
  if (!source.startsWith("# Zellij as the session, not as a command you remember to type.")) return undefined;
  const first = source.indexOf("if declare -F _red_dev_run_control >/dev/null 2>&1; then\n");
  if (first < 0) return undefined;
  const last = source.indexOf("\nfi\n", first);
  if (last < 0 || !source.slice(first, last).includes("refusing uncontained zellij")) return undefined;
  return source.slice(0, first) + '_red_zellij_launch() { zellij "$@"; }\n' + source.slice(last + 4);
}

/** Retire only the generated include block, preserving the operator's Cargo settings. */
export function retireCargoInclude(source: string): string | undefined {
  const begin = "# red-dev:build-resources begin";
  const end = "# red-dev:build-resources end";
  if (!source.includes(begin)) return undefined;
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const first = lines.findIndex(line => line.trim() === begin);
  const last = lines.findIndex((line, i) => i > first && line.trim() === end);
  if (first < 0 || last < 0) return undefined;
  const body = lines.slice(first + 1, last).join("");
  try {
    const parsed = Bun.TOML.parse(body) as Record<string, unknown>;
    if (Object.keys(parsed).length !== 1 || !Array.isArray(parsed["include"]) || parsed["include"].length !== 1) return undefined;
    const include = parsed["include"][0];
    if (include !== "../.config/red-dev/cargo.toml" && !(include && typeof include === "object" &&
      include.path === "../.config/red-dev/cargo.toml" && Object.keys(include).every(key => ["path", "optional"].includes(key)))) return undefined;
  } catch { return undefined; }
  const after = [...lines.slice(0, first), ...lines.slice(last + 1)].join("");
  return source.startsWith("\uFEFF") && !after.startsWith("\uFEFF") ? `\uFEFF${after}` : after;
}

/** WSL files have incomplete historical provenance: remove only marked resource rows. */
export function retireWslResources(source: string): string | undefined {
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let owned = false;
  let changed = false;
  const output: string[] = [];
  for (const line of lines) {
    if (/^# Added by red-dev; (?:existing operator values are never replaced|unrelated operator values are preserved)\.\s*$/.test(line.trim())) {
      owned = true; changed = true; continue;
    }
    if (owned && /^\s*(memory|processors|swap|maxCrashDumpCount|autoMemoryReclaim)\s*=/i.test(line)) {
      changed = true; continue;
    }
    owned = false;
    output.push(line);
  }
  return changed ? output.join("") : undefined;
}

export function resourceRetirementPlan(home: string, wslConfigPath?: string): RetirementPlan {
  const systemd = join(home, ".config/systemd/user");
  const definitions: RetiredDefinition[] = [
    // Repair old readers before removing their adapter during standalone upgrades.
    { path: join(home, ".local/share/red-dev/config/bash/zellij.sh"), retire: retireLegacyZellij },
    { path: join(home, ".local/share/red-dev/config/bash/rc.sh"), retire: retireLegacyRc },
    ...RETIRED_SLICES.map(name => ({ path: join(systemd, name), retire: (text: string) =>
      /^Description=red-dev /m.test(text) && /^Documentation=https:\/\/github\.com\/reddb-io\/red-dev\s*$/m.test(text) ? null : undefined })),
    ...[...ATTACHMENTS, ...GUARDIAN].map(name => ({ path: join(systemd, name), retire: (text: string) => OWNER.test(text) ? null : undefined })),
    ...[".config/red-dev/cargo.toml", ".local/share/red-dev/config/bash/build-resources.sh", ".local/share/red-dev/bin/disk-guardian.sh"]
      .map(path => ({ path: join(home, path), retire: (text: string) => OWNER.test(text) ? null : undefined })),
    { path: join(home, ".cargo/config.toml"), retire: retireCargoInclude },
    ...(wslConfigPath ? [{ path: wslConfigPath, retire: retireWslResources }] : []),
  ];
  return planRetirement(definitions);
}

const DEFAULTS: Record<string, string> = {
  MemoryHigh: "infinity", MemoryMax: "infinity", MemorySwapMax: "infinity",
  MemoryLow: "0", MemoryMin: "0", CPUQuota: "", CPUWeight: "100",
  IOWeight: "100", TasksMax: "infinity",
};
type Command = (argv: string[]) => Promise<BoundedCommandResult>;
function properties(text: string): Record<string, string> {
  return Object.fromEntries(text.trim().split("\n").flatMap(line => {
    const at = line.indexOf("=");
    return at < 0 ? [] : [[line.slice(0, at), line.slice(at + 1)]];
  }));
}
function nativeDefaults(paths: string[]): Record<string, string> {
  const values = { ...DEFAULTS };
  for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const [key, value] of Object.entries(properties(readFileSync(path, "utf8")))) {
      if (key in DEFAULTS) values[key] = value.trim() || DEFAULTS[key]!;
    }
  }
  return values;
}

/** Reset our live slices/scopes without restarting terminals, agents or services. */
export async function releaseRetiredResources(plan: RetirementPlan, run: Command): Promise<string[]> {
  const failures: string[] = [];
  const listed = await run(["systemctl", "--user", "list-units", "--all", "--type=slice,scope,service", "--output=json", "--no-pager"]);
  if (listed.exitCode !== 0 || listed.timedOut) return ["list-units"];
  let rows: { unit?: unknown }[];
  try { rows = JSON.parse(listed.stdout); if (!Array.isArray(rows)) return ["list-units"]; }
  catch { return ["list-units"]; }
  for (const row of rows) {
    const unit = row.unit;
    if (typeof unit !== "string") continue;
    const slice = (RETIRED_SLICES as readonly string[]).includes(unit);
    const scope = /^run-[a-z0-9]+\.scope$/.test(unit);
    const fleet = /^red-fleet-.+\.scope$/.test(unit);
    const service = unit === "redskilled.service" || /^red-worker-.+\.service$/.test(unit);
    if (!slice && !scope && !service && !fleet) continue;
    if (slice && !plan.changes.some(change => change.path.endsWith(`/${unit}`))) continue;
    if (scope && !plan.changes.some(change => change.path.endsWith("/red-dev.slice"))) continue;
    const observed = await run(["systemctl", "--user", "show", unit, "--property=ControlGroup,FragmentPath,DropInPaths"]);
    if (observed.exitCode !== 0 || observed.timedOut) { failures.push(unit); continue; }
    const props = properties(observed.stdout);
    if (!/(?:^|\/)red-dev\.slice(?:\/|$)/.test(props.ControlGroup ?? "")) continue;
    let defaults = { ...DEFAULTS };
    if (service || fleet) {
      const drops = (props.DropInPaths ?? "").split(" ").filter(Boolean);
      const removed = plan.changes.filter(change => drops.includes(change.path));
      if (removed.length === 0) continue;
      const keys = new Set(removed.flatMap(change => Object.keys(properties(change.before))).filter(key => key in DEFAULTS));
      const native = nativeDefaults([props.FragmentPath ?? "", ...drops.filter(path => !removed.some(change => change.path === path))]);
      defaults = Object.fromEntries([...keys].map(key => [key, native[key]!]));
    }
    const thawed = await run(["systemctl", "--user", "thaw", unit]);
    if (thawed.exitCode !== 0 || thawed.timedOut) { failures.push(`${unit}:thaw`); continue; }
    if (Object.keys(defaults).length === 0) continue;
    const reset = await run(["systemctl", "--user", "set-property", "--runtime", unit,
      ...Object.entries(defaults).map(([key, value]) => `${key}=${value}`)]);
    if (reset.exitCode !== 0 || reset.timedOut) failures.push(`${unit}: ${reset.timedOut ? "timeout" : reset.stderr.trim() || "set-property failed"}`);
  }
  return failures;
}

export async function retireResourceControls(p: Platform, options: {
  home?: string; wslConfigPath?: string; run?: Command;
} = {}): Promise<{ retired: string[]; preserved: string[] }> {
  const home = options.home ?? process.env.HOME ?? process.env.USERPROFILE;
  if (!home) throw new Error("user home unavailable for resource retirement");
  const plan = resourceRetirementPlan(home, options.wslConfigPath);
  const backupRoot = join(home, ".local/state/red-dev/retired-resource-controls");
  const pending = join(backupRoot, "pending-reload");
  if (plan.changes.length === 0 && !existsSync(pending)) return { retired: [], preserved: plan.preserved };
  const run = options.run ?? (argv => runBounded(argv, { timeoutMs: 5_000 }));
  if (p.os === "linux" && p.caps.systemd) {
    for (const unit of GUARDIAN) {
      if (!plan.changes.some(change => change.path.endsWith(`/${unit}`))) continue;
      const argv = unit.endsWith(".timer") ? ["disable", "--now", unit] : ["stop", unit];
      const result = await run(["systemctl", "--user", ...argv]);
      if (result.exitCode !== 0 || result.timedOut) throw new Error(`could not retire ${unit}`);
    }
    const failed = plan.changes.length ? await releaseRetiredResources(plan, run) : [];
    if (failed.length) throw new Error(`could not release retired resource controls: ${failed.join(", ")}`);
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    writeFileSync(pending, "systemd reload pending after red-dev resource retirement\n", { mode: 0o600 });
  }
  const retired = applyRetirement(plan, backupRoot);
  if (p.os === "linux" && p.caps.systemd) {
    const reload = await run(["systemctl", "--user", "daemon-reload"]);
    if (reload.exitCode !== 0 || reload.timedOut) throw new Error("retired resource files removed, but systemd reload failed");
    rmSync(pending, { force: true });
  } else if (existsSync(pending)) {
    throw new Error("retired resource controls still need a systemd user reload");
  }
  return { retired, preserved: plan.preserved };
}
