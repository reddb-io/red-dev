import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { profilePath, renderMachineProfile, type MachineProfile } from "./machine-profile.ts";
import { resolveMachineProfile } from "./profile-command.ts";
import type { Platform } from "./platform.ts";
import { parseResourceSettings, type ResourceSettings } from "./resource-settings.ts";
import { encodedFile, originalResourceBytes, resourceEdit, resourceHistoryPath, type ResourceEdit } from "./resource-files.ts";
import type { ResourceSnapshot } from "./resource-diagnostics.ts";

export interface ResourcePlan { edits: ResourceEdit[]; historyPath: string; details: string[]; restartWsl: boolean; }
/** Only selected WSL keys change; duplicates are refused rather than guessed. */
export function editWslResources(source: string, memoryGiB: number, swapGiB: number): string {
  if (source.includes("\0") || source.includes("\uFFFD")) throw Error("WSL configuration encoding unsupported; preserve the file and save it as UTF-8 first");
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : ""; const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  const sections = lines.flatMap((line, index) => /^\s*\[wsl2\]\s*(?:[#;].*)?$/i.test(line) ? [index] : []);
  if (sections.length > 1) throw Error("duplicate [wsl2] sections; resolve them before choosing a budget");
  if (!sections.length) { if (lines.at(-1) !== "") lines.push(""); lines.push("[wsl2]", ""); sections.push(lines.length - 2); }
  const start = sections[0]!; let end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line)); if (end < 0) end = lines.length;
  for (const [key, value] of [["memory", `${memoryGiB}GB`], ["swap", `${swapGiB}GB`]] as const) {
    const matches = lines.flatMap((line, index) => index > start && index < end && new RegExp(`^\\s*${key}\\s*=`, "i").test(line) ? [index] : []);
    if (matches.length > 1) throw Error(`duplicate WSL ${key} settings; preserve and resolve them first`);
    if (matches.length) {
      const index = matches[0]!;
      // An old ownership marker must not make a later update retire the explicit choice.
      if (/^# Added by red-dev; (?:existing operator values are never replaced|unrelated operator values are preserved)\.\s*$/.test(lines[index - 1]!.trim())) lines[index - 1] = "# red-dev resources: explicit user choice";
      lines[index] = lines[index]!.replace(new RegExp(`^(\\s*${key}\\s*=\\s*)[^#;]*`, "i"), `$1${value} `).trimEnd();
    } else { lines.splice(end, 0, `# red-dev resources: explicit user choice`, `${key}=${value}`); end += 2; }
  }
  return bom + lines.join(newline);
}
export async function machineResourcePlan(p: Platform, settings: ResourceSettings, snapshot: ResourceSnapshot, options: { editWsl?: boolean } = {}): Promise<ResourcePlan> {
  parseResourceSettings(settings);
  const editWsl = options.editWsl !== false;
  if (settings.wsl && editWsl && p.os !== "windows" && p.env !== "wsl") throw Error("a WSL budget requires Windows or WSL");
  if (settings.wsl && editWsl && snapshot.windows?.total !== null && snapshot.windows?.total !== undefined && settings.wsl.memoryGiB * 1024 ** 3 >= snapshot.windows.total) throw Error("choose a WSL ceiling below host RAM to leave room for Windows");
  const previous = await resolveMachineProfile(p);
  if (settings.mode === "system" && previous.resources?.wsl && !snapshot.wsl.path) throw Error("Windows bridge unavailable; the previous WSL budget cannot be restored. Existing choices are preserved.");
  const profile: MachineProfile = { ...previous, resources: settings };
  const historyPath = resourceHistoryPath(); const edits: ResourceEdit[] = [];
  const details = [`Choice: ${settings.mode}`, `Build slots: ${settings.buildSlots ?? "system scheduling"}; applies only to red-dev resources run in this environment`];
  if (settings.wsl && editWsl) {
    if (!snapshot.wsl.path) throw Error("Windows .wslconfig path unavailable; no resource settings written");
    const before = encodedFile(snapshot.wsl.path);
    if ((before === null ? null : Buffer.from(before, "base64").toString("utf8")) !== snapshot.wsl.source) throw Error("WSL config changed since diagnosis; inspect again");
    edits.push(resourceEdit(snapshot.wsl.path, editWslResources(snapshot.wsl.source ?? "", settings.wsl.memoryGiB, settings.wsl.swapGiB)));
    details.push(`WSL memory: ${snapshot.wsl.memory ?? "system default"} -> ${settings.wsl.memoryGiB} GiB`, `WSL swap: ${snapshot.wsl.swap ?? "system default"} -> ${settings.wsl.swapGiB} GiB`, "The ceiling is shared by WSL 2 distros, is not a Windows RAM reservation and can still cause OOM inside Linux.");
  } else if (settings.wsl) {
    details.push("WSL file unchanged; the previous budget choice is retained in the profile.");
  } else if (settings.mode === "system" && previous.resources?.wsl && snapshot.wsl.path) {
    const original = originalResourceBytes(snapshot.wsl.path, historyPath);
    if (original !== undefined) edits.push({ ...resourceEdit(snapshot.wsl.path, null), after: original });
    details.push(original === undefined ? "Existing WSL settings keep their current owner; no budget was applied by this flow." : "Restore WSL bytes from before the resource choices.");
  }
  edits.push({ ...resourceEdit(profilePath(), renderMachineProfile(profile)), ...(!process.env.RED_DEV_PROFILE_FILE ? { section: "resources" as const } : {}) });
  const restartWsl = edits.some(e => e.path === snapshot.wsl.path && e.before !== e.after);
  if (restartWsl) details.push("Pending: applies after your next WSL restart. Save work and restart it when convenient; this command does not restart it.");
  return { edits, historyPath, details, restartWsl };
}
export interface ProjectResources { schema: 1; jobs: number; }
export function resourceProjectRoot(input = process.cwd()): string {
  let path = realpathSync(resolve(input));
  for (;;) {
    if (existsSync(join(path, "Cargo.toml"))) return path;
    const parent = dirname(path); if (parent === path) throw Error("choose a Rust project directory containing Cargo.toml"); path = parent;
  }
}
export function projectResourcePath(root: string): string { return join(root, ".red-dev", "resources.json"); }
export function readProjectResources(root: string): ProjectResources | null {
  const path = projectResourcePath(root); if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as ProjectResources;
  if (value.schema !== 1 || !Number.isSafeInteger(value.jobs) || value.jobs < 1 || value.jobs > 256 || Object.keys(value).some(k => !["schema", "jobs"].includes(k))) throw Error(`unknown or invalid project resource config preserved: ${path}`);
  return value;
}
export function projectResourcePlan(input: string | undefined, jobs: number): ResourcePlan {
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 256) throw Error("Cargo jobs must be between 1 and 256");
  const root = resourceProjectRoot(input); const previous = readProjectResources(root);
  return { historyPath: resourceHistoryPath(root), restartWsl: false,
    edits: [resourceEdit(projectResourcePath(root), JSON.stringify({ schema: 1, jobs }, null, 2) + "\n")],
    details: [`Project: ${root}`, `Cargo jobs: ${previous?.jobs ?? "Cargo default"} -> ${jobs}`,
      "Used by red-dev resources run -- cargo ... in this project. Direct Cargo and rust-analyzer keep their own settings.",
      "Explicit Cargo -j/--jobs or CARGO_BUILD_JOBS in your shell takes precedence. Jobs are not a RAM guarantee."] };
}
