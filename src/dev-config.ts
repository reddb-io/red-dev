/** One user-owned document for durable red-dev choices. */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Document } from "yaml";
import { parseMachineProfile } from "./machine-profile.ts";
import { parsePolicy } from "./tool-policy.ts";
import { acquireUpdateLock } from "./update-coordinator.ts";

export interface DevConfig extends Record<string, unknown> {
  schema: 1;
  profile?: Record<string, unknown>;
  preferences?: Record<string, unknown>;
  policies?: Record<string, unknown>;
}
export function devConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = process.platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE;
  if (!env.RED_DEV_CONFIG_FILE && !home) throw Error("HOME or USERPROFILE is required for red-dev configuration");
  return env.RED_DEV_CONFIG_FILE || join(home!, ".red", "dev", "config.yaml");
}
export function legacyConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_CONFIG_HOME ?? (process.platform === "win32"
    ? env.APPDATA ?? join(env.USERPROFILE ?? "", "AppData", "Roaming") : join(env.HOME ?? "", ".config"));
}
export function legacyProfilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RED_DEV_PROFILE_FILE || join(legacyConfigRoot(env), "red-dev", "profile.json");
}
export function legacyPolicyPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RED_DEV_POLICY_FILE || join(legacyConfigRoot(env), "red-dev", "tool-policies.json");
}
export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`invalid ${label}; existing configuration preserved`);
  return value as Record<string, unknown>;
}
export function readLegacyObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const bytes = readFileSync(path);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return object(JSON.parse(source.replace(/^\uFEFF/, "")), path);
}
export function validateDevConfig(value: DevConfig): void {
  if (value.profile !== undefined) parseMachineProfile(value.profile);
  for (const policy of Object.values(value.policies ?? {})) parsePolicy(policy);
}
function document(source: string): Document {
  // Cosmetic commands (statusline) must not initialize the YAML parser.
  const { isMap, parseDocument } = require("yaml") as typeof import("yaml");
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length) throw Error(`invalid red-dev YAML: ${doc.errors[0]!.message}`);
  if (!isMap(doc.contents)) throw Error("red-dev config must be a YAML mapping");
  const value = object(doc.toJS({ maxAliasCount: 100 }), "red-dev configuration");
  if (value.schema !== 1) throw Error("unsupported red-dev config schema; existing configuration preserved");
  for (const key of ["preferences", "profile", "policies"]) if (value[key] !== undefined) object(value[key], `red-dev ${key}`);
  validateDevConfig(value as DevConfig);
  return doc;
}
export function parseDevConfig(source: string): DevConfig {
  return document(source).toJS({ maxAliasCount: 100 }) as DevConfig;
}
export function readDevConfig(env: NodeJS.ProcessEnv = process.env): DevConfig | null {
  const path = devConfigPath(env);
  return existsSync(path) ? parseDevConfig(readFileSync(path, "utf8")) : null;
}
/** Read-only fallback for old machines. Explicit JSON overrides stay separate. */
export function legacyDevConfig(env: NodeJS.ProcessEnv = process.env, preferences?: Record<string, unknown>): DevConfig {
  const prefsPath = process.platform === "win32" ? join(env.APPDATA ?? join(env.USERPROFILE ?? "", "AppData", "Roaming"), "alacritty", "red-dev.json")
    : join(env.HOME ?? env.USERPROFILE ?? "", ".config", "alacritty", "red-dev.json");
  return { schema: 1,
    ...(!env.RED_DEV_PROFILE_FILE ? { profile: readLegacyObject(legacyProfilePath(env)) } : {}),
    ...(!env.RED_DEV_POLICY_FILE ? { policies: readLegacyObject(legacyPolicyPath(env)) } : {}),
    preferences: preferences ?? readLegacyObject(prefsPath) ?? {},
  };
}
function patch(doc: Document, path: string[], next: unknown): void {
  const { isMap } = require("yaml") as typeof import("yaml");
  const current = path.length ? doc.getIn(path, true) : doc.contents;
  if (next && typeof next === "object" && !Array.isArray(next) && isMap(current)) {
    const values = next as Record<string, unknown>;
    for (const pair of [...current.items]) {
      const key = String(pair.key);
      if (!(key in values) || values[key] === undefined) doc.deleteIn([...path, key]);
    }
    for (const [key, value] of Object.entries(values)) if (value !== undefined) patch(doc, [...path, key], value);
  } else {
    const value = current && typeof current === "object" && "toJSON" in current ? (current as { toJSON(): unknown }).toJSON() : current;
    if (JSON.stringify(value) !== JSON.stringify(next)) doc.setIn(path, next);
  }
}
/** Preserve comments and unknown sections when changing known choices. */
export function renderDevConfig(next: DevConfig, source?: string): string {
  const doc = document(source ?? "schema: 1\n");
  patch(doc, [], next);
  const rendered = doc.toString({ lineWidth: 0 });
  parseDevConfig(rendered);
  return rendered;
}
export function writeDevConfig(update: (current: DevConfig) => DevConfig, env: NodeJS.ProcessEnv = process.env): void {
  const path = devConfigPath(env);
  const release = acquireUpdateLock(`${path}.writer`);
  if (!release) throw Error("red-dev configuration is being edited; retry later");
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw Error(`configuration writes require a regular file: ${path}`);
    const source = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const current = source === undefined ? legacyDevConfig(env) : parseDevConfig(source);
    validateDevConfig(current);
    const next = update(current);
    const bytes = renderDevConfig(next, source);
    if (bytes === source) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, bytes, { mode: existsSync(path) ? lstatSync(path).mode & 0o777 : 0o600 });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); release(); }
}
