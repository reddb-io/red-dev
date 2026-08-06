/**
 * The converge loop, once.
 *
 * It used to live inside cmdInstall, printing as it went. Adding a live
 * view would have meant a second copy of the same ordering, the same
 * apt batching and the same failure handling — and two copies of that
 * logic drift, quietly, in the direction of whichever one gets used
 * more.
 *
 * So the loop emits events and the caller decides what a step looks
 * like: the text reporter writes a line, the fullscreen view updates a
 * signal. Neither knows anything about the other.
 */

import { aptInstall, applyProvider, type ApplyContext } from "./providers.ts";
import {
  describeProvider,
  installState,
  isInstalled,
  providerFor,
  toolsInScope,
  type Scope,
  type Tool,
} from "./manifest.ts";
import type { Platform } from "./platform.ts";

export type StepOutcome = "installed" | "applied" | "present" | "skipped" | "failed";

export interface StepEvent {
  scope: Scope;
  tool: string;
  provider: string;
  index: number;
  total: number;
}

export interface StepResult extends StepEvent {
  outcome: StepOutcome;
  ms: number;
  detail?: string;
}

export interface ConvergeObserver {
  scopeStart?: (scope: Scope, total: number) => void;
  /** A note that is not a step — the apt batch, mostly. */
  note?: (message: string) => void;
  /**
   * The batched apt transaction, bracketed like a step.
   *
   * It needs its own pair because it is the one piece of work that runs
   * between scopeStart and the first stepStart, and the fullscreen view
   * only redirects child output while a step is open. Without this the
   * largest, longest and loudest command of the whole run — a hundred
   * packages, hundreds of lines, minutes of progress bars — was the one
   * command writing straight to the terminal, painting over the frame
   * the renderer believes it owns.
   *
   * batchEnd fires even when the transaction throws. A view that opens a
   * redirect here and never closes it loses every line that follows.
   */
  batchStart?: (packages: string[]) => void;
  batchEnd?: (error: string | null) => void;
  stepStart?: (event: StepEvent) => void;
  stepEnd?: (result: StepResult) => void;
}

export interface ConvergeOptions {
  platform: Platform;
  ctx: ApplyContext;
  scopes: Scope[];
  dryRun: boolean;
}

export interface ConvergeSummary {
  results: StepResult[];
  failed: number;
}

/** Total steps across every scope, so a progress bar has a denominator. */
export function countSteps(scopes: Scope[]): number {
  return scopes.reduce((n, s) => n + toolsInScope(s).length, 0);
}

/**
 * Run the batched apt transaction inside its observer bracket.
 *
 * Its own function so the bracket can be tested without a package
 * manager: `install` is the real aptInstall everywhere but the test.
 *
 * Returns the failure message, or null. Throwing instead would skip
 * batchEnd, and the caller has to report a failed batch per tool anyway.
 */
export async function runAptBatch(
  pkgs: string[],
  observer: ConvergeObserver,
  install: (pkgs: string[]) => Promise<void> = aptInstall,
): Promise<string | null> {
  observer.batchStart?.(pkgs);
  let error: string | null = null;
  try {
    await install(pkgs);
  } catch (err) {
    error = (err as Error).message;
  }
  observer.batchEnd?.(error);
  return error;
}

export async function converge(
  opts: ConvergeOptions,
  observer: ConvergeObserver = {},
): Promise<ConvergeSummary> {
  const { platform: p, ctx, scopes, dryRun } = opts;
  const results: StepResult[] = [];
  const total = countSteps(scopes);
  let index = 0;

  for (const scope of scopes) {
    const tools = toolsInScope(scope);
    observer.scopeStart?.(scope, tools.length);

    // apt is batched: twenty sequential apt-get calls is the slowest
    // part of a fresh provision, and each one re-reads the package
    // lists. Resolved up front so the per-tool loop can still report
    // each package as its own step instead of hiding them all behind
    // one opaque transaction.
    const pending: Tool[] = tools.filter(
      (t) => providerFor(t, p).kind !== "skip" && !isInstalled(t),
    );
    const aptPkgs = pending
      .map((t) => providerFor(t, p))
      .filter((pr): pr is { kind: "apt"; pkg: string } => pr.kind === "apt")
      .map((pr) => pr.pkg);

    let aptError: string | null = null;
    if (!dryRun && aptPkgs.length > 0) {
      observer.note?.(`apt: ${aptPkgs.length} packages in one transaction`);
      aptError = await runAptBatch(aptPkgs, observer);
    }

    for (const tool of tools) {
      const pr = providerFor(tool, p);
      const provider = describeProvider(pr);
      index++;

      const event: StepEvent = { scope, tool: tool.name, provider, index, total };
      observer.stepStart?.(event);
      const started = Date.now();

      const finish = (outcome: StepOutcome, detail?: string): void => {
        const result: StepResult = {
          ...event,
          outcome,
          ms: Date.now() - started,
          ...(detail ? { detail } : {}),
        };
        results.push(result);
        observer.stepEnd?.(result);
      };

      if (pr.kind === "skip") {
        finish("skipped", pr.reason);
        continue;
      }
      if (isInstalled(tool)) {
        finish("present");
        continue;
      }
      if (dryRun) {
        finish("skipped", "dry run");
        continue;
      }

      if (pr.kind === "apt") {
        // Attempted in the batch above; report what is actually true
        // rather than claiming a per-tool install that never ran.
        if (aptError) finish("failed", aptError);
        else if (isInstalled(tool)) finish("installed");
        else if (installState(tool) === "outdated") {
          // Present and runnable, just too old — the archive has nothing
          // newer. Saying "absent" here sends the reader hunting for a
          // missing binary that is sitting right there on PATH.
          finish("failed", `apt has nothing newer than ${tool.minVersion} for ${tool.name}`);
        } else finish("failed", "apt reported success but the binary is absent");
        continue;
      }

      try {
        await applyProvider(pr, ctx);
        // A managed builtin converges rather than installs, and on a
        // second run legitimately changes nothing.
        finish(tool.managed ? "applied" : "installed");
      } catch (err) {
        // One tool failing must not abort the run: re-running and
        // picking up the rest is the point of a converge tool.
        finish("failed", (err as Error).message);
      }
    }
  }

  return { results, failed: results.filter((r) => r.outcome === "failed").length };
}
