import type { Platform } from "./platform.ts";
import type { Invocation } from "./cli.ts";
import type { SetupAnswers } from "./tui-setup-model.ts";
import type { SetupProgressObserver } from "./firstrun.ts";
import type { converge } from "./converge.ts";
import { captureTo } from "./log.ts";
import { prepareProvisioning, synchronizeProvisioning } from "./provisioning.ts";
import { withUpdateLock } from "./update-coordinator.ts";
import { applyContextForEntry } from "./preferences.ts";
import { applicableScopes, type Scope } from "./manifest.ts";

export interface WizardInstallDependencies {
  lock: typeof withUpdateLock;
  prepare: typeof prepareProvisioning;
  synchronize: typeof synchronizeProvisioning;
  apply: typeof import("./firstrun.ts").applySetupAnswers;
  context: typeof applyContextForEntry;
  converge: typeof converge;
}

const dependencies: WizardInstallDependencies = {
  lock: withUpdateLock,
  prepare: prepareProvisioning,
  synchronize: synchronizeProvisioning,
  apply: async (...args) => (await import("./firstrun.ts")).applySetupAnswers(...args),
  context: applyContextForEntry,
  converge: async (...args) => (await import("./converge.ts")).converge(...args),
};

/** Collect answers without writes; execute the complete install under one lease. */
export function createWizardInstall(p: Platform, inv: Invocation, deps = dependencies) {
  let pending: { answers: SetupAnswers; observer?: SetupProgressObserver } | undefined;
  return {
    apply: async (answers: SetupAnswers, observer?: SetupProgressObserver): Promise<void> => {
      if (!answers.completed) throw new Error("setup was not completed");
      pending = { answers, observer };
    },
    converge: async (...[options, observer]: Parameters<typeof converge>) => {
      if (options.dryRun) return deps.converge(options, observer);
      const held = await deps.lock(async () => {
        // Preparation also spawns children. Route its output into the existing
        // render, then let the converge's own per-step captures take over.
        const release = captureTo(line => observer?.note?.(line));
        let ctx = options.ctx;
        try {
          await deps.prepare(p);
          if (pending) {
            await deps.apply(p, inv, pending.answers, pending.observer);
            pending = undefined;
            await deps.synchronize(p);
            ctx = { ...ctx, ...await deps.context(p, inv, "install") };
          }
        } finally {
          release();
        }
        const scopes = inv.scope ? [inv.scope as Scope] : applicableScopes(p);
        return deps.converge({ ...options, ctx, scopes }, observer);
      });
      if (held.busy) throw new Error("another installation or update is running");
      return held.value;
    },
  };
}
