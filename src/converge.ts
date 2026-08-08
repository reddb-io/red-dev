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

import { transcribeStep } from "./transcript.ts";
import { refusedRights } from "./rights.ts";
import {
  batchHost,
  privilegedItems,
  runPrivilegedBatch,
  type BatchHost,
} from "./privileged.ts";
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

/**
 * `deferred` is the one that is not a verdict on the work.
 *
 * An item that needs rights this run does not have did not fail: it was
 * never attempted, nothing is broken, and the machine around it
 * converged. Reporting it as a failure makes a healthy, partly-converged
 * machine read as a broken one, and after enough of those a red summary
 * stops being read at all.
 */
export type StepOutcome =
  | "installed"
  | "applied"
  | "present"
  | "skipped"
  | "deferred"
  | "failed";

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
  /**
   * What the operator has to do to finish this item, when something is.
   *
   * Kept apart from `detail` rather than folded into it because they are
   * printed at different rates: the cause belongs on the item's own row,
   * the remedy belongs once per gate — three items behind the same
   * locked door share one key, and printing it three times reads as
   * three separate problems.
   */
  remedy?: string;
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
  /**
   * The privileged batch, bracketed for the same reason the apt one is.
   *
   * It runs after the last step has closed, so a view that only
   * redirects child output between stepStart and stepEnd has already
   * stopped listening — and an elevated item that prints while nothing
   * is open writes straight over the frame the renderer believes it
   * owns.
   *
   * privilegedEnd fires however the batch went, refusal included. A
   * redirect opened here and never closed loses every line after it,
   * which on this step means the summary.
   */
  privilegedStart?: (items: string[]) => void;
  privilegedEnd?: () => void;
  stepStart?: (event: StepEvent) => void;
  stepEnd?: (result: StepResult) => void;
}

export interface ConvergeOptions {
  platform: Platform;
  ctx: ApplyContext;
  scopes: Scope[];
  dryRun: boolean;
  /**
   * Where the privileged batch gets its rights. Injected in tests only;
   * nothing in the product passes it.
   */
  host?: BatchHost;
}

export interface ConvergeSummary {
  results: StepResult[];
  failed: number;
  /** Items that ran out of rights. Not a subset of `failed`. */
  deferred: number;
}

/**
 * What an error message means for the item that raised it. PURE.
 *
 * The whole classification, in one place and testable without a package
 * manager: both callers below reach it holding nothing but a string,
 * because that is all an exception and a failed batch leave behind.
 */
export function outcomeForError(message: string): {
  outcome: StepOutcome;
  detail: string;
  remedy?: string;
} {
  const denied = refusedRights(message);
  if (!denied) return { outcome: "failed", detail: message };
  return { outcome: "deferred", detail: denied.cause, remedy: denied.remedy };
}

/**
 * The three answers a script wrapping a converge has to tell apart.
 *
 * 0 converged, 1 something failed, 2 converged except work that needs
 * rights this run did not have. The third exists so "done" and "done
 * except the privileged part" are not the same byte — a wrapper can act
 * on the difference without parsing a summary, and neither of them has
 * to be reported as a failure to be noticed.
 */
export function convergeExit(summary: { failed: number; deferred: number }): 0 | 1 | 2 {
  if (summary.failed > 0) return 1;
  return summary.deferred > 0 ? 2 : 0;
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

  /**
   * Open a step, and hand back the two ways of closing it.
   *
   * Lifted out of the loop because the privileged batch below closes
   * steps too, and a second copy of this is a second place for the
   * transcript, the numbering or the observer bracket to be wrong in.
   */
  const open = (
    scope: Scope,
    tool: Tool,
    provider: string,
  ): {
    finish: (outcome: StepOutcome, detail?: string, remedy?: string) => void;
    finishError: (message: string) => void;
  } => {
    index++;
    const event: StepEvent = { scope, tool: tool.name, provider, index, total };
    observer.stepStart?.(event);
    const started = Date.now();

    const finish = (outcome: StepOutcome, detail?: string, remedy?: string): void => {
      const result: StepResult = {
        ...event,
        outcome,
        ms: Date.now() - started,
        ...(detail ? { detail } : {}),
        ...(remedy ? { remedy } : {}),
      };
      results.push(result);
      observer.stepEnd?.(result);
      // Written here rather than at the end, and straight to the file
      // rather than through `log`.
      //
      // Straight to the file because the fullscreen view renders these
      // rows from its own model — they have never passed through the
      // logger, so a transcript teed off `log` had every provider's
      // chatter and none of the outcomes it belonged to. Here because
      // a converge that is killed, or that takes down the terminal
      // with it, still leaves the rows up to the point it stopped,
      // which is the run most likely to be worth reading.
      transcribeStep(result);
    };

    /**
     * Close a step that raised, as whichever of the two things it was.
     *
     * Both callers arrive holding a message and nothing else, and the
     * difference between "this broke" and "this was not allowed to run"
     * is entirely inside it.
     */
    const finishError = (message: string): void => {
      const { outcome, detail, remedy } = outcomeForError(message);
      finish(outcome, detail, remedy);
    };

    return { finish, finishError };
  };

  // The privileged half of the plan, lifted out of the loop below and
  // run after all of it.
  //
  // Declared per platform in the manifest, so this is a partition
  // settled before anything executes rather than a discovery made at the
  // item that needs the rights. Empty on every Linux target, where it
  // costs a filter over a list and nothing else.
  const batch = privilegedItems(p, scopes);
  const batched = new Set(batch.map((t) => t.name));

  for (const scope of scopes) {
    const tools = toolsInScope(scope).filter((t) => !batched.has(t.name));
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
      const { finish, finishError } = open(scope, tool, describeProvider(pr));

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
        // A batch that never ran because sudo said no defers every
        // package in it: one refusal at the transaction is not twenty
        // broken packages, and reporting it as twenty is how a whole
        // summary turns red over a single missing password.
        if (aptError) finishError(aptError);
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
        // picking up the rest is the point of a converge tool. Nor does
        // an item that ran out of rights — it is reported as deferred
        // and the run carries on to everything that needs none.
        finishError((err as Error).message);
      }
    }
  }

  // The privileged batch, after every item that needs no rights and
  // never between them.
  //
  // Last because the consent it raises interrupts whatever is on the
  // screen, and an interruption at item 12 of 38 stops a run someone is
  // watching; last, it stops nothing. And because a converge whose
  // operator walks away still gets everything that needed no permission,
  // rather than stalling at the first item that did.
  if (batch.length > 0) {
    if (dryRun) {
      // Reported in the position they would actually run in. A dry run
      // that lists them among their scopes describes an ordering the
      // real run does not have.
      for (const tool of batch) {
        const { finish } = open(tool.scope, tool, describeProvider(providerFor(tool, p)));
        if (isInstalled(tool)) finish("present");
        else finish("skipped", "dry run");
      }
    } else {
      observer.note?.(
        batch.length === 1
          ? "1 item needs administrator — asked for once, here at the end"
          : `${batch.length} items need administrator — asked for once, here at the end`,
      );

      observer.privilegedStart?.(batch.map((t) => t.name));
      let steps;
      try {
        steps = await runPrivilegedBatch(
          batch,
          opts.host ?? batchHost(p, (tool) => applyProvider(providerFor(tool, p), ctx)),
        );
      } finally {
        observer.privilegedEnd?.();
      }

      // Reported per item, the way the apt transaction is: one consent
      // and one elevated child is how the work ran, but "the batch
      // failed" is not something an operator can act on, and the report
      // has to name which of them is still waiting.
      for (const { tool, present, error } of steps) {
        const { finish, finishError } = open(
          tool.scope,
          tool,
          describeProvider(providerFor(tool, p)),
        );
        if (present) finish("present");
        else if (error) finishError(error);
        else finish(tool.managed ? "applied" : "installed");
      }
    }
  }

  const count = (outcome: StepOutcome): number =>
    results.filter((r) => r.outcome === outcome).length;
  return { results, failed: count("failed"), deferred: count("deferred") };
}
