/** Import old choices once and retire recognised sources with exact backups. */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Platform } from "./platform.ts";
import { devConfigPath, legacyDevConfig, legacyPolicyPath, legacyProfilePath, object, readDevConfig, readLegacyObject, renderDevConfig, type DevConfig } from "./dev-config.ts";
import { legacyPreferencesPath } from "./preferences.ts";
import { parseMachineProfile } from "./machine-profile.ts";
import { parsePolicy } from "./tool-policy.ts";
import { applyResourceEdits, readResourceHistory, resourceEdit, resourceHistoryPath, undoResourceEdits, type ResourceEdit } from "./resource-files.ts";
import { redDevStateRoot } from "./reclaim.ts";

export const KNOWN_PREFERENCES = ["sshGithubUser", "setupCompleted", "crashHandoff", "migrations", "theme", "wallpaper", "font", "fontSize", "blesh", "redwall", "redwallInterface", "agents", "defaultAgent", "runtimes", "apps", "redSkillsPlugins", "terminalShell", "distro"] as const;
export const FORWARDED_PREFERENCES = ["theme", "wallpaper", "font", "fontSize", "blesh", "redwall", "redwallInterface", "agents", "defaultAgent", "runtimes", "apps", "redSkillsPlugins", "terminalShell", "distro"] as const;
export function childPreferences(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  if (env.RED_DEV_WSL_CHILD !== "1" || !env.RED_DEV_WSL_PREFERENCES) return {};
  const value = object(JSON.parse(env.RED_DEV_WSL_PREFERENCES), "Windows preferences");
  return Object.fromEntries(FORWARDED_PREFERENCES.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
function validate(config: DevConfig): void {
  if (config.profile) parseMachineProfile(config.profile);
  for (const value of Object.values(config.policies ?? {})) parsePolicy(value);
}
function backupEdits(path: string): ResourceEdit[] {
  // User-created symlinks are imported but never unlinked or replaced.
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return [];
  const source = readFileSync(path);
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const backup = `${path}.red-dev-config-${hash}.bak`;
  if (existsSync(backup) && !readFileSync(backup).equals(source)) throw Error(`configuration backup has another owner: ${backup}`);
  return [resourceEdit(backup, source.toString("utf8")), resourceEdit(path, null)];
}
/** Preserve pre-YAML resource undo when its profile moves into the document. */
function historyEdit(config: DevConfig): ResourceEdit[] {
  if (process.env.RED_DEV_PROFILE_FILE) return [];
  const path = resourceHistoryPath();
  if (!existsSync(path)) return [];
  const history = readResourceHistory(path);
  const oldPath = legacyProfilePath();
  if (!history.transactions.some(t => t.edits.some(e => e.path === oldPath))) return [];
  if (history.transactions.some(t => t.state === "pending")) throw Error("finish the interrupted resource change with resources undo before migrating configuration");
  const projected = (bytes: string | null): string => {
    const profile = bytes === null ? undefined : parseMachineProfile(JSON.parse(Buffer.from(bytes, "base64").toString("utf8")));
    return Buffer.from(renderDevConfig({ ...config, profile: profile as unknown as Record<string, unknown> | undefined })).toString("base64");
  };
  for (const transaction of history.transactions) for (const edit of transaction.edits) if (edit.path === oldPath) {
    edit.path = devConfigPath(); edit.before = projected(edit.before); edit.after = projected(edit.after); edit.section = "resources";
  }
  const original = readFileSync(path);
  const backup = `${path}.pre-yaml-${createHash("sha256").update(original).digest("hex").slice(0, 16)}.bak`;
  if (existsSync(backup) && !readFileSync(backup).equals(original)) throw Error(`resource history backup has another owner: ${backup}`);
  return [resourceEdit(backup, original.toString("utf8")), resourceEdit(path, JSON.stringify(history, null, 2) + "\n")];
}
export async function migrateDevConfig(p: Platform): Promise<void> {
  const journal = join(redDevStateRoot(), "config-migration.json");
  if (existsSync(journal) && readResourceHistory(journal).transactions.at(-1)?.state === "pending") undoResourceEdits(journal);
  const current = readDevConfig();
  // A WSL import may read the old host preference file. Only Windows retires
  // that shared source, after its own canonical document has been committed.
  let prefsPath: string | undefined;
  if (!current || p.env !== "wsl") prefsPath = await legacyPreferencesPath(p);
  const prefs = prefsPath ? readLegacyObject(prefsPath) : undefined;
  const next = { ...(current ?? legacyDevConfig(process.env, prefs)),
    preferences: { ...(current?.preferences ?? prefs ?? {}), ...childPreferences() } };
  validate(next);
  // Validate every legacy source before retiring it, even if YAML is already
  // authoritative; a malformed file stays visible for the user to resolve.
  const oldProfile = !process.env.RED_DEV_PROFILE_FILE ? readLegacyObject(legacyProfilePath()) : undefined;
  if (oldProfile) parseMachineProfile(oldProfile);
  const oldPolicies = !process.env.RED_DEV_POLICY_FILE ? readLegacyObject(legacyPolicyPath()) : undefined;
  if (oldPolicies) for (const value of Object.values(oldPolicies)) parsePolicy(value);
  const path = devConfigPath();
  const source = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const edits = [resourceEdit(path, renderDevConfig(next, source)), ...historyEdit(next),
    ...(!process.env.RED_DEV_PROFILE_FILE ? backupEdits(legacyProfilePath()) : []),
    ...(!process.env.RED_DEV_POLICY_FILE ? backupEdits(legacyPolicyPath()) : []),
    ...(p.env !== "wsl" && prefsPath && prefs && KNOWN_PREFERENCES.some(key => key in prefs) ? backupEdits(prefsPath) : [])];
  applyResourceEdits(edits, journal);
}
