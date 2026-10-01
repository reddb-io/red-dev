import type { Platform } from "./platform.ts";
import { runUpdateJob, withUpdateLock, updateClockPath } from "./update-coordinator.ts";
import { autoUpdateEnabled, autoUpdateMinutes } from "./auto-update-schedule.ts";
import { watchEnabled, watchMinutes } from "./watch-schedule.ts";
import { watchRedSkills } from "./red-skills-watch.ts";
import { refreshUpdateState } from "./update-state.ts";

/** OS schedulers enter here; the shell never starts maintenance. */
export async function runMaintenance(p: Platform, opts: {
  update: () => Promise<number>;
  skills?: typeof watchRedSkills;
  metadata?: typeof refreshUpdateState;
  remote?: () => Promise<number>;
  env?: NodeJS.ProcessEnv;
  path?: string;
  now?: number;
}): Promise<number> {
  const path = opts.path ?? updateClockPath();
  const env = opts.env ?? process.env;
  const held = await withUpdateLock(async () => {
    let code = 0;
    if (watchEnabled(env)) {
      const result = await (opts.skills ?? watchRedSkills)({ manifestPlatform: p, trigger: "timer", coordinated: true,
        coordinatorPath: path, nowMs: opts.now, intervalMs: watchMinutes(env) * 60_000 });
      if (result.outcome === "refused" || result.outcome === "unreachable") code = 3;
    }
    if (autoUpdateEnabled(env)) {
      const result = await runUpdateJob("suite", autoUpdateMinutes(env) * 60_000, async () => (await opts.update()) === 0, { path, now: opts.now });
      if (result === "failed") code = 3;
    }
    await (opts.metadata ?? refreshUpdateState)(p, { coordinated: true, nowMs: opts.now });
    if (opts.remote && await opts.remote() !== 0) code = 3;
    return code;
  }, path);
  return held.busy ? 0 : held.value;
}
