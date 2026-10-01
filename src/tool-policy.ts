/** User intent for portable tools. Catalog membership is not ownership. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ToolPolicy = { mode: "follow" } | { mode: "fixed"; version: string } | { mode: "external" };
type Env = NodeJS.ProcessEnv;

export function policyPath(env: Env = process.env): string {
  const root = env.XDG_CONFIG_HOME ?? (process.platform === "win32"
    ? env.APPDATA ?? join(env.USERPROFILE ?? "", "AppData", "Roaming")
    : join(env.HOME ?? "", ".config"));
  return env.RED_DEV_POLICY_FILE ?? join(root, "red-dev", "tool-policies.json");
}

export function userMisePath(env: Env = process.env): string {
  return env.MISE_CONFIG_FILE ?? (env.MISE_CONFIG_DIR ? join(env.MISE_CONFIG_DIR, "config.toml")
    : join(dirname(dirname(policyPath({ ...env, RED_DEV_POLICY_FILE: undefined }))), "mise", "config.toml"));
}

function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`invalid tool policies: ${path}`);
  return parsed;
}

export function parsePolicy(value: unknown): ToolPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid tool policy");
  const row = value as Record<string, unknown>;
  if (row.mode === "follow" || row.mode === "external") return { mode: row.mode };
  if (row.mode === "fixed" && typeof row.version === "string" && /^v?\d[\w.+-]*$/.test(row.version)) return { mode: "fixed", version: row.version };
  throw new Error("policy must be follow, external, or fixed with a version");
}

export function configuredSelector(name: string, spec = name, env: Env = process.env): string | "external" | null {
  const path = userMisePath(env);
  if (!existsSync(path)) return null;
  const config = Bun.TOML.parse(readFileSync(path, "utf8")) as { tools?: Record<string, unknown> };
  const value = config.tools?.[name] ?? config.tools?.[spec];
  if (value === undefined) return null;
  const selector = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as { version?: unknown }).version : value;
  return typeof selector === "string" ? selector : "external";
}

export function toolPolicy(name: string, spec = name, env: Env = process.env): ToolPolicy {
  const policies = readObject(policyPath(env));
  const explicit = policies[name] ?? policies[spec];
  if (explicit !== undefined) return parsePolicy(explicit);
  const selector = configuredSelector(name, spec, env);
  if (selector === "external") return { mode: "external" };
  return selector && selector !== "latest" ? { mode: "fixed", version: selector } : { mode: "follow" };
}

export function writeToolPolicy(name: string, policy: ToolPolicy, env: Env = process.env): void {
  const path = policyPath(env);
  const next = { ...readObject(path), [name]: parsePolicy(policy) };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export function installSelector(name: string, spec = name, env: Env = process.env): string | null {
  const policy = toolPolicy(name, spec, env);
  return policy.mode === "external" ? null : `${name}@${policy.mode === "fixed" ? policy.version : "latest"}`;
}
