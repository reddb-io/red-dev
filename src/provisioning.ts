import type { Platform } from "./platform.ts";

export interface ProvisioningPreparation {
  migrate: (p: Platform) => Promise<unknown>;
  adopt: (p: Platform) => Promise<unknown>;
  declareMise: (p: Platform) => unknown;
}

const preparation: ProvisioningPreparation = {
  migrate: async p => {
    await (await import("./dev-config-migration.ts")).migrateDevConfig(p);
    return (await import("./migrations.ts")).runPendingMigrations(p);
  },
  adopt: async p => (await import("./profile-command.ts")).adoptMachineProfile(p),
  declareMise: async p => (await import("./mise-config.ts")).convergeMiseConfig(p),
};

/** Refresh declarations after setup choices change the desired profile. */
export async function synchronizeProvisioning(p: Platform, deps = preparation): Promise<void> {
  await deps.adopt(p);
  await deps.declareMise(p);
}

/** Install, update and the bootstrap wizard share this writer preparation. */
export async function prepareProvisioning(p: Platform, dryRun = false, deps = preparation): Promise<void> {
  if (dryRun) return;
  await deps.migrate(p);
  await synchronizeProvisioning(p, deps);
}
