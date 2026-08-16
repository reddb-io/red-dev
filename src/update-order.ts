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
  // Not fatal, and last: retention is the one stage whose failure costs
  // disk rather than correctness. An update that could not prune is
  // still an update, and the exit code stays the converge's.
  { stage: "prune" },
];

/** The stages in order, for a caller that only wants the sequence. */
export function updateStageOrder(): UpdateStage[] {
  return UPDATE_STAGES.map((spec) => spec.stage);
}

export interface UpdateRun {
  /** Which stages were reached, in the order they were reached. */
  ran: UpdateStage[];
  /** The exit code of the update, which is the converge's own. */
  code: number;
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
): Promise<UpdateRun> {
  const ran: UpdateStage[] = [];
  let code = 0;
  for (const spec of UPDATE_STAGES) {
    ran.push(spec.stage);
    try {
      const result = await perform(spec.stage);
      if (typeof result === "number") code = result;
    } catch (err) {
      onFailure(spec.stage, (err as Error).message, spec.fatal === true);
      if (spec.fatal) return { ran, code: 1 };
    }
  }
  return { ran, code };
}
