import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Platform } from "./platform.ts";

/** The Windows coordinator owns the clock of its provisioned WSL child. */
export function windowsOwnsMaintenance(p: Platform, home: string, env: NodeJS.ProcessEnv): boolean {
  if (p.env !== "wsl") return false;
  const path = join(home, ".local", "state", "red-dev", "maintenance-owner.json");
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, "utf8"));
    if (existing.schema !== 1 || existing.managedBy !== "red-dev" || !["local", "windows"].includes(existing.owner)) throw new Error(`unknown maintenance owner: ${path}`);
  }
  if (env.RED_DEV_WSL_CHILD === "1" || env.RED_DEV_UPDATE_OWNER === "local") {
    const owner = env.RED_DEV_UPDATE_OWNER === "local" ? "local" : "windows";
    const desired = JSON.stringify({ schema: 1, managedBy: "red-dev", owner }) + "\n";
    if (!existsSync(path) || readFileSync(path, "utf8") !== desired) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, desired, { mode: 0o600 }); renameSync(tmp, path);
    }
  }
  if (!existsSync(path)) return false;
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.schema !== 1 || value.managedBy !== "red-dev") throw new Error(`unknown maintenance owner: ${path}`);
  return value.owner === "windows";
}
