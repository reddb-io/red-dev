/**
 * The order `red-dev update` advances a machine in, as data.
 *
 * It was a run of statements in main.ts, which is a fine way to express
 * an order and a poor way to keep one: every stage was added by
 * somebody solving a different problem, and the reason each sits where
 * it does lived in whichever commit message put it there. The order is
 * load-bearing —
 *
 *   system    the package managers first, because everything below is
 *             installed on top of what they own
 *   red-skills  before the converge, which builds out of the red-skills
 *             checkout: convergeRedSkills stops at "already wired",
 *             correct for install and permanently frozen under update
 *   suite     the reddb-io tools mise manages, which no update path
 *             reached at all until one asked it to
 *   agents    each host by its own publisher's mechanism, after the
 *             runtimes it may need have been advanced above it
 *   converge  upgrading can leave the manifest unsatisfied — a package
 *             removed, a binary replaced — and the converge is what
 *             notices
 *   prune     after everything is installed and converged, never
 *             before: mise collects the versions no config still names,
 *             and the config is not final until the converge has had
 *             its say
 *
 * — so it is declared once, in one place, and executed by walking it.
 */

export type UpdateStage = "system" | "red-skills" | "suite" | "agents" | "converge" | "prune";

export interface UpdateStageSpec {
  stage: UpdateStage;
  /**
   * A failure here ends the update. Everywhere else it is named and
   * walked past: an unreachable GitHub is not a reason to abandon the
   * apt upgrade that already succeeded, and a machine that stops
   * updating the moment one vendor is down never finishes updating.
   */
  fatal?: boolean;
}

export const UPDATE_STAGES: readonly UpdateStageSpec[] = [
  { stage: "system", fatal: true },
  { stage: "red-skills" },
  { stage: "suite" },
  { stage: "agents" },
  { stage: "converge", fatal: true },
  // Last and nonfatal: a failed prune is reported as partial progress,
  // and does not undo already installed updates.
  { stage: "prune" },
];

/** The stages in order, for a caller that only wants the sequence. */
export function updateStageOrder(): UpdateStage[] {
  return UPDATE_STAGES.map((spec) => spec.stage);
}

export interface UpdateRun {
  /** Which stages were reached, in the order they were reached. */
  ran: UpdateStage[];
  /** 0 complete; 1 failed convergence; 2 pending rights; 3 partial update. */
  code: number;
  results: Array<{ stage: UpdateStage; status: "ok" | "failed" | "pending" | "skipped"; detail?: string }>;
}

/**
 * Walk the stages, in order, with one stage's failure kept to itself.
 *
 * `perform` returns a number only where a stage has an exit code of its
 * own to contribute — the converge does, and nothing else does. Any
 * stage may throw; `onFailure` is told, and the walk continues unless
 * the stage was declared fatal.
 */
export async function runUpdate(
  perform: (stage: UpdateStage) => Promise<number | void>,
  onFailure: (stage: UpdateStage, message: string, fatal: boolean) => void,
  options: { skip?: (stage: UpdateStage) => boolean } = {},
): Promise<UpdateRun> {
  const ran: UpdateStage[] = [];
  const results: UpdateRun["results"] = [];
  let code = 0;
  for (const spec of UPDATE_STAGES) {
    ran.push(spec.stage);
    if (options.skip?.(spec.stage)) { results.push({ stage: spec.stage, status: "skipped" }); continue; }
    try {
      const result = await perform(spec.stage);
      if (typeof result === "number") code = Math.max(code, result);
      results.push({ stage: spec.stage, status: result === 2 ? "pending" : result ? "failed" : "ok" });
      if (result === 1 && spec.fatal) return { ran, code: 1, results };
    } catch (err) {
      onFailure(spec.stage, (err as Error).message, spec.fatal === true);
      results.push({ stage: spec.stage, status: "failed", detail: (err as Error).message });
      if (spec.fatal) return { ran, code: 1, results };
    }
  }
  // A usable/converged machine can still have tools that did not update.
  if (code === 0 && results.some(result => result.status === "failed")) code = 3;
  return { ran, code, results };
}
