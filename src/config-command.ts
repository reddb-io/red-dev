/** Inspect durable choices without migration, adoption or state writes. */
import { devConfigPath, legacyDevConfig, readDevConfig, readLegacyObject, renderDevConfig, validateDevConfig } from "./dev-config.ts";
import { legacyPreferencesPath } from "./preferences.ts";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";

export async function configCommand(p: Platform, json = false): Promise<number> {
  const config = readDevConfig() ?? legacyDevConfig(process.env, readLegacyObject(await legacyPreferencesPath(p)));
  if (process.env.RED_DEV_PROFILE_FILE) config.profile = readLegacyObject(process.env.RED_DEV_PROFILE_FILE);
  if (process.env.RED_DEV_POLICY_FILE) config.policies = readLegacyObject(process.env.RED_DEV_POLICY_FILE);
  validateDevConfig(config);
  log.plain(json ? JSON.stringify(config) : `${devConfigPath()}\n\n${renderDevConfig(config)}`);
  return 0;
}
