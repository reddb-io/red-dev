/**
 * Every privileged item of a converge, run together, once, at the end,
 * behind a single consent prompt.
 *
 * The alternative is what a converge does by default: each item asks for
 * itself, when it happens to be reached. Thirty-six items in, the third
 * prompt of the run lands on someone who is no longer reading them —
 * and a run that interrupts repeatedly teaches exactly that. Worse, a
 * prompt raised mid-converge arrives while the fullscreen view owns the
 * screen, which is not a place a question can be answered at all.
 *
 * So the privileged half is lifted out of the loop and run after it. The
 * items are known before anything executes — the manifest declares them
 * per platform — so this is a partition of the plan, not a discovery
 * made along the way.
 *
 * ## The prompt is Windows' own
 *
 * There is no second question in front of it. Elevation on Windows is a
 * UAC consent dialog and it cannot be suppressed, so asking "may I ask
 * you?" first would be two prompts for one decision, and the first of
 * them answerable in a terminal the renderer has already taken over.
 * One `Start-Process -Verb RunAs` for the whole batch is the single
 * prompt this slice promises; declining it defers every item in the
 * batch, named, with the one remedy they share.
 *
 * A session that is already elevated holds the rights, so it does the
 * work in place and no prompt is raised anywhere — consent already given
 * is not requested twice.
 *
 * ## Idempotence is the contract, not a nicety
 *
 * A batch can fail halfway: one item's capability lands, the next one's
 * service does not, and the operator re-runs. Every section is guarded
 * so re-running repeats nothing, and each is wrapped in its own
 * try/catch so the failure of one does not abandon the rest. Both halves
 * are asserted against the composed text, which is why the text is built
 * by a function rather than assembled inside the runner.
 *
 * On every Linux target the batch is empty: sudo is its own path, which
 * already works, and nothing here must disturb it.
 */

import { existsSync, rmSync } from "node:fs";
import type { PrivilegedState } from "./drift.ts";
import { itemsNeedingAdmin, type Scope, type Tool } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import { missingRights } from "./rights.ts";
import { interactive } from "./ui.ts";

/**
 * The declared privileged items of this run, in manifest order.
 *
 * Exactly once each, and that is a property of where the answer comes
 * from rather than of a filter applied afterwards: the set is built by
 * selecting rows of the manifest, so an item cannot appear twice however
 * the caller assembled its scopes.
 */
export function privilegedItems(p: Platform, scopes: Scope[]): Tool[] {
  return itemsNeedingAdmin(p, scopes);
}

/** What the batch did with one item. */
export interface BatchStep {
  tool: Tool;
  /** Its privileged half was already in place; nothing was asked for it. */
  present?: boolean;
  /**
   * The message it ended with, when it did not finish.
   *
   * A message rather than an outcome, because the converge already owns
   * the one place that decides what a message means — an item that ran
   * out of rights and an item that broke arrive there as strings either
   * way, and classifying them twice is how the two answers drift apart.
   */
  error?: string;
}

/** What came back from the one elevation attempt. */
export type Elevation =
  | { consent: "refused" }
  /** Granted, and this is what the elevated child reported per item. */
  | { consent: "given"; report: string[] };

/**
 * Everything the batch needs from the machine, in one injectable piece.
 *
 * A host rather than direct calls because none of the four can run in a
 * test: two spawn PowerShell, one asks whether a terminal is attached
 * and one installs software. What is left once they are behind an
 * interface is the part worth pinning — which items are asked for, in
 * what order, and what each outcome means.
 */
export interface BatchHost {
  /** How much of the privileged work is already in place, by item name. */
  states: (items: Tool[]) => Promise<Record<string, PrivilegedState>>;
  /** Does this session already hold administrator? */
  elevated: () => Promise<boolean>;
  /** Is there anyone here to answer a consent prompt? */
  consentPossible: () => boolean;
  /** Do one item's work with the rights already held. */
  applyHere: (tool: Tool) => Promise<void>;
  /** Raise consent once, and run the whole batch behind it. */
  elevate: (items: Tool[]) => Promise<Elevation>;
}

/**
 * Run the batch and say what happened to each item.
 *
 * An empty batch returns before it touches the host: no probe, no
 * elevation check and no prompt, which is what keeps the majority of
 * machines exactly as they were.
 */
export async function runPrivilegedBatch(
  items: Tool[],
  host: BatchHost,
): Promise<BatchStep[]> {
  if (items.length === 0) return [];

  // Items whose privileged half is already done are not asked for again.
  // The batch is idempotent, so running them would be harmless — but the
  // prompt in front of it is not, and a converged machine raising a
  // consent dialog every run is how an operator learns to dismiss one
  // without reading it.
  let states: Record<string, PrivilegedState> = {};
  try {
    states = await host.states(items);
  } catch {
    // A probe that threw answered nothing, and nothing is a state we
    // have: the item goes into the batch, which is safe to run over work
    // already done and is not safe to skip over work that is not.
  }
  const finished = new Set(items.filter((t) => states[t.name] === "finished").map((t) => t.name));
  const outstanding = items.filter((t) => !finished.has(t.name));

  let errors = new Map<string, string | null>();
  if (outstanding.length > 0) {
    try {
      errors = await attempt(outstanding, host);
    } catch (err) {
      // The batch is the last thing a converge does, so anything that
      // escapes here would take the summary of a run that has already
      // finished down with it. Reported as what it is, against the items
      // it happened to.
      errors = new Map(outstanding.map((tool) => [tool.name, (err as Error).message]));
    }
  }

  return items.map((tool) => {
    if (finished.has(tool.name)) return { tool, present: true };
    const error = errors.get(tool.name);
    return error ? { tool, error } : { tool };
  });
}

/**
 * The three ways the outstanding items can be reached, in order of
 * how little they have to ask for.
 */
async function attempt(items: Tool[], host: BatchHost): Promise<Map<string, string | null>> {
  const verdicts = new Map<string, string | null>();

  if (await host.elevated()) {
    // Nothing to ask: the rights are already held, so the work happens
    // here, in order, and each item answers for itself.
    for (const tool of items) {
      try {
        await host.applyHere(tool);
        verdicts.set(tool.name, null);
      } catch (err) {
        verdicts.set(tool.name, (err as Error).message);
      }
    }
    return verdicts;
  }

  // No terminal means no one to consent, and a UAC dialog raised at a
  // machine nobody is sitting at waits for an answer that never comes.
  // Deferring is the outcome that already exists for this: the run
  // finishes everything else and names what is still waiting.
  if (!host.consentPossible()) return deferAll(items);

  const elevation = await host.elevate(items);
  if (elevation.consent === "refused") return deferAll(items);
  for (const tool of items) verdicts.set(tool.name, reportedError(elevation.report, tool.name));
  return verdicts;
}

/** Every item, waiting on rights this run does not have. */
function deferAll(items: Tool[]): Map<string, string | null> {
  // Asked for rather than written. One gate, one wording, one remedy —
  // the same sentence an item that ran out of rights mid-converge has
  // always printed.
  const denied = missingRights("administrator").message;
  return new Map(items.map((tool) => [tool.name, denied]));
}

/**
 * What the elevated child said about one item. PURE.
 *
 * An elevated child is a separate process tree whose stdout does not
 * come home, so the batch writes a line per item to a file and this
 * reads it back. An item with no line at all is the case worth naming:
 * the child stopped before reaching it, which is neither a success to
 * claim nor a refusal to blame on the operator.
 */
export function reportedError(report: string[], name: string): string | null {
  const line = report.map((l) => l.trim()).find((l) => l === `ok ${name}` || l.startsWith(`failed ${name} `));
  if (!line) return `the batch stopped before it reached ${name}`;
  return line === `ok ${name}` ? null : line.slice(`failed ${name} `.length);
}

/**
 * The PowerShell each privileged item contributes to the batch.
 *
 * Loaded per item rather than imported up front, for the reason
 * drift.ts loads its probes the same way: the module behind an entry is
 * a platform adapter, and a machine with nothing to do here must not
 * import one to find that out.
 *
 * Borrowed from the provider rather than written again. Two copies of
 * the same three cmdlets is two things to keep true, and the one that
 * only runs elevated is the copy nobody would notice going stale.
 */
const SECTIONS: Record<string, () => Promise<string>> = {
  "ssh-server": async () => (await import("./ssh-server.ts")).windowsSshServerScript,
};

/** Which items this build can compose a batch for. */
export function sectionNames(): string[] {
  return Object.keys(SECTIONS);
}

/**
 * The batch, as text.
 *
 * Separated from running it because running it needs a consent dialog
 * and a Windows host, while the text is the half that can be wrong in a
 * way nobody notices — a section that swallows its own failure, or one
 * that is not safe to run twice, produces a batch that parses, reports
 * success and leaves the machine where it was.
 *
 * `$report` is the whole protocol: one line per item, written at the end
 * to a path the unelevated parent can read.
 */
export async function batchScript(items: Tool[], resultPath: string): Promise<string> {
  const sections: string[] = [];
  for (const tool of items) {
    const load = SECTIONS[tool.name];
    sections.push(
      load
        ? section(tool.name, await load())
        : // Declared privileged, with nothing here to run for it. Said
          // out loud in the report rather than skipped silently, so the
          // item is reported as unfinished instead of as done.
          `$report += 'failed ${tool.name} this build has no privileged section for it'`,
    );
  }

  return [
    "$ErrorActionPreference = 'Stop'",
    "$report = @()",
    ...sections,
    `Set-Content -LiteralPath '${resultPath.replace(/'/g, "''")}' -Value ($report -join "\`n") -Encoding UTF8`,
  ].join("\n\n");
}

/**
 * One item's section: its own script, its own verdict, its own failure.
 *
 * The try/catch is what makes a partial failure a partial failure. Let
 * one section's exception escape and the batch stops there, never writes
 * the report, and every item after it — including the ones that would
 * have worked — comes back as unreached. Re-running then costs a second
 * consent for work that had no reason to wait.
 */
function section(name: string, body: string): string {
  return [
    `# ---- ${name}`,
    "try {",
    "  & {",
    body
      .split("\n")
      .map((line) => (line.trim() ? `    ${line}` : line))
      .join("\n"),
    "  } | Out-Null",
    `  $report += 'ok ${name}'`,
    "} catch {",
    // Flattened, because a report line is a line: a multi-line .NET
    // exception would arrive back as several items' worth of report and
    // match none of them.
    `  $report += "failed ${name} $($_.Exception.Message -replace '\\s+', ' ')"`,
    "}",
  ].join("\n");
}

/** The real machine, for everything the batch cannot decide by itself. */
export function batchHost(p: Platform, apply: (tool: Tool) => Promise<void>): BatchHost {
  return {
    states: async (items) => {
      const { probePrivileged } = await import("./drift.ts");
      return await probePrivileged(items.map((t) => t.name), p);
    },
    elevated: async () => {
      try {
        const { isElevated } = await import("./wsl-provision.ts");
        return await isElevated();
      } catch {
        // A question that could not be put is not a yes. Treated as
        // unelevated, the batch goes on to ask for consent, and whatever
        // stopped the probe stops that too — one outcome instead of a
        // converge that dies on its last step.
        return false;
      }
    },
    consentPossible: interactive,
    applyHere: apply,
    elevate: elevateAndRun,
  };
}

/**
 * Raise consent once, run the batch behind it, and read the report.
 *
 * Windows-only by construction: the batch is non-empty only where the
 * manifest declares an administrator column, which is the Windows one,
 * so there is no WSL path translation to do here — the paths this
 * handles are the ones the process itself is already using.
 */
async function elevateAndRun(items: Tool[]): Promise<Elevation> {
  const dir = process.env["TEMP"] ?? process.env["TMP"] ?? ".";
  const scriptPath = `${dir}\\red-dev-privileged.ps1`;
  const resultPath = `${dir}\\red-dev-privileged.txt`;
  discard(resultPath);

  await Bun.write(scriptPath, await batchScript(items, resultPath));

  try {
    // -Wait so the report below is read after the child, not beside it.
    // A refused dialog fails here and leaves no report, which is the
    // same answer arrived at from either direction.
    await powershell(
      "Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden " +
        `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${scriptPath}'`,
    );
  } catch {
    return { consent: "refused" };
  } finally {
    discard(scriptPath);
  }

  if (!existsSync(resultPath)) return { consent: "given", report: [] };
  const report = (await Bun.file(resultPath).text())
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  discard(resultPath);
  return { consent: "given", report };
}

/** Run one PowerShell command, raising whatever it printed when it fails. */
async function powershell(command: string): Promise<void> {
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", command], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const err = (await new Response(proc.stderr).text()).trim();
  if ((await proc.exited) !== 0) throw new Error(err.split("\n")[0] ?? "powershell failed");
}

/** A temp file that may not be there. Its absence is never an error. */
function discard(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A leftover we could not remove changes nothing: the script is
    // rewritten before each run and the report is read only after the
    // one that just wrote it.
  }
}
