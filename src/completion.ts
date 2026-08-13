/**
 * The closing frame of a converge.
 *
 * A run used to end on the summary block and a single `ok` line, which
 * is one more line in a transcript of sixty — indistinguishable, at a
 * glance, from the thirty-eight rows above it. Someone who arrived here
 * through the PowerShell one-liner has no way to tell whether the thing
 * is still working, whether it worked, or what they are meant to do now.
 * "It finished" has to be legible from across the room.
 *
 * Two halves, split on purpose. `convergeVerdict` decides what the run
 * was and what is left to do; everything below it only draws that. The
 * decision is the part that can be wrong in a way nobody notices — a
 * machine whose only outstanding work needed rights, reported as
 * converged — so it is a pure function with a test around every one of
 * its five shapes, and the renderers hold no opinions of their own.
 */

import { formatDuration } from "./log.ts";

/** Mirrors converge's StepOutcome; kept local so drawing owes it nothing. */
export type CompletionOutcome =
  | "installed"
  | "applied"
  | "present"
  | "skipped"
  | "deferred"
  | "failed";

/**
 * What the verdict needs from a step, and nothing more.
 *
 * Shaped after StepResult rather than Reporter's Entry because both
 * presentations already hold StepResults — the line report gets them
 * from the converge summary, the fullscreen view collects them as they
 * arrive — and the setup phase's results are the same three fields.
 */
export interface VerdictItem {
  tool: string;
  outcome: CompletionOutcome;
  /** The provider's actual failure, carried all the way to the closing screen. */
  detail?: string;
  remedy?: string;
}

export interface CompletionFailure {
  tool: string;
  /** Absent only when the provider itself supplied no diagnostic. */
  detail?: string;
}

export interface VerdictOptions {
  /** The transcript of this run, when one was opened. */
  logPath?: string | null;
  /** A preview changed nothing, and must never claim a machine converged. */
  dryRun?: boolean;
}

export interface CompletionVerdict {
  /** The three answers a converge has. Not four, and never two. */
  status: "converged" | "deferred" | "failed" | "preview";
  /** One sentence, readable on its own with no counts around it. */
  headline: string;
  counts: {
    total: number;
    /** installed + applied: the items this run actually moved. */
    changed: number;
    present: number;
    skipped: number;
    deferred: number;
    failed: number;
  };
  elapsed: string;
  logPath: string | null;
  /** Failed items and their immediate causes, in execution order. */
  failures: CompletionFailure[];
  /** Work that could not cross its rights gate, with the reason it stopped. */
  deferrals: CompletionFailure[];
  /**
   * What to do next, in the order it has to be done.
   *
   * Empty on a machine with nothing outstanding and nothing changed —
   * an instruction that applies to nobody is how a reader learns to
   * skip the block that sometimes matters.
   */
  nextSteps: string[];
}

/**
 * What the run was, and what is left. PURE.
 *
 * Failures outrank deferrals: a machine with both is broken, and the
 * item waiting on rights is not the news. Deferrals outrank silence for
 * the same reason the summary lists them apart from failures — nothing
 * broke, and something is still outstanding.
 */
export function convergeVerdict(
  items: readonly VerdictItem[],
  elapsedMs: number,
  options: VerdictOptions = {},
): CompletionVerdict {
  const by = (outcome: CompletionOutcome): VerdictItem[] =>
    items.filter((item) => item.outcome === outcome);
  const deferred = by("deferred");
  const failed = by("failed");
  const changed = by("installed").length + by("applied").length;

  const counts = {
    total: items.length,
    changed,
    present: by("present").length,
    skipped: by("skipped").length,
    deferred: deferred.length,
    failed: failed.length,
  };
  const elapsed = formatDuration(elapsedMs);
  const logPath = options.logPath ?? null;
  const failures = failed.map((item) => ({
    tool: item.tool,
    ...(item.detail?.trim() ? { detail: item.detail.replace(/\s+/g, " ").trim() } : {}),
  }));
  const deferrals = deferred.map((item) => ({
    tool: item.tool,
    ...(item.detail?.trim() ? { detail: item.detail.replace(/\s+/g, " ").trim() } : {}),
  }));

  if (options.dryRun === true) {
    return {
      status: "preview",
      headline: "dry run — nothing on this machine changed",
      counts,
      elapsed,
      logPath,
      failures,
      deferrals,
      nextSteps: ["Run `red-dev install` to carry this out."],
    };
  }

  // Once per remedy, not once per item: several items behind one gate
  // share one key, and repeating it reads as several things to go and
  // do. Order is first-seen, which is the order they were attempted in.
  const remediesOf = (subset: VerdictItem[]): string[] => [
    ...new Set(subset.map((item) => item.remedy).filter((r): r is string => Boolean(r))),
  ];

  const nextSteps: string[] = [];
  if (failed.length > 0) {
    nextSteps.push("Re-run `red-dev install` — every provider is idempotent, it resumes here.");
    nextSteps.push(...remediesOf(failed));
  }
  if (deferred.length > 0) {
    const remedies = remediesOf(deferred);
    nextSteps.push(
      ...(remedies.length > 0
        ? remedies
        : ["Re-run with the rights these items need to finish."]),
    );
  }
  // Said only when something moved. On a machine that was already
  // converged there is no new binary to pick up, and a shell instruction
  // that changes nothing is the line that teaches people to stop reading
  // this block.
  if (changed > 0) {
    nextSteps.push("Open a new terminal — PATH and shell changes load in new sessions.");
  }

  if (failed.length > 0) {
    return {
      status: "failed",
      headline:
        failed.length === 1
          ? `1 item failed — this machine is not converged yet (${failed[0]?.tool ?? ""})`
          : `${failed.length} items failed — this machine is not converged yet`,
      counts,
      elapsed,
      logPath,
      failures,
      deferrals,
      nextSteps,
    };
  }

  if (deferred.length > 0) {
    return {
      status: "deferred",
      headline:
        deferred.length === 1
          ? "converged, except one item waiting for rights this run did not have"
          : `converged, except ${deferred.length} items waiting for rights this run did not have`,
      counts,
      elapsed,
      logPath,
      failures,
      deferrals,
      nextSteps,
    };
  }

  return {
    status: "converged",
    headline: "this machine is converged",
    counts,
    elapsed,
    logPath,
    failures,
    deferrals,
    nextSteps,
  };
}

/** The glyph and colour each verdict carries, in one place. */
export const VERDICT_MARK: Record<CompletionVerdict["status"], { glyph: string; sgr: string }> = {
  converged: { glyph: "✔", sgr: "1;32" },
  deferred: { glyph: "!", sgr: "1;33" },
  failed: { glyph: "✗", sgr: "1;31" },
  preview: { glyph: "·", sgr: "1;36" },
};

/**
 * The facts under the headline, as plain rows. PURE.
 *
 * Counts, then time, then where the run was written down. The log path
 * is here rather than in `nextSteps` because it is not an instruction —
 * it is the answer to the question the next step provokes.
 */
export function verdictFacts(verdict: CompletionVerdict): string[] {
  const c = verdict.counts;
  const parts = [`${c.total} items`, `${c.changed} changed`, `${c.present} already present`];
  if (c.deferred > 0) parts.push(`${c.deferred} deferred`);
  if (c.failed > 0) parts.push(`${c.failed} failed`);
  const rows = [parts.join(" · "), `took ${verdict.elapsed}`];
  if (verdict.logPath) rows.push(`log  ${verdict.logPath}`);
  return rows;
}

/** Human-readable provider failures shared by both closing presentations. */
export function failureFacts(verdict: CompletionVerdict): string[] {
  return verdict.failures.map(
    (failure) => `${failure.tool}: ${failure.detail ?? "no error detail was reported"}`,
  );
}

/** Group a shared rights failure once, followed by every item it held back. */
export function deferralFacts(verdict: CompletionVerdict): string[] {
  const groups = new Map<string, string[]>();
  for (const deferral of verdict.deferrals) {
    const detail = deferral.detail ?? "no deferral detail was reported";
    groups.set(detail, [...(groups.get(detail) ?? []), deferral.tool]);
  }
  return [...groups].map(([detail, tools]) => `${detail} — ${tools.join(", ")}`);
}

/**
 * Wrap to a column, cutting words that cannot fit. PURE.
 *
 * A path is one word and can be longer than the frame; wrapping alone
 * would push it past the right edge and take the border with it, so an
 * unbreakable token is cut rather than allowed to break the box.
 */
export function wrapTo(line: string, width: number): string[] {
  if (width < 4) return [line.slice(0, Math.max(0, width))];
  const out: string[] = [];
  let current = "";
  for (const word of line.split(" ")) {
    if (current === "") current = word;
    else if (`${current} ${word}`.length <= width) current = `${current} ${word}`;
    else {
      out.push(current);
      current = word;
    }
    while (current.length > width) {
      out.push(`${current.slice(0, width - 1)}…`);
      current = "";
    }
  }
  if (current !== "") out.push(current);
  return out.length > 0 ? out : [""];
}

/**
 * `~` for the home directory. PURE.
 *
 * A transcript path is one unbreakable word and the frame is 72 columns:
 * at full length it is cut, and a log path missing its last characters
 * is a log path nobody can open. The home prefix is the part every
 * reader can supply from memory.
 */
export function shortenHome(path: string | null, home?: string): string | null {
  if (!path) return null;
  const at = home?.replace(/[\\/]+$/, "");
  if (!at || at === "" || !path.startsWith(`${at}/`)) return path;
  return `~${path.slice(at.length)}`;
}

const NO_COLOR = (): boolean => process.env["NO_COLOR"] !== undefined;

/**
 * The banner, as lines ready for a console.
 *
 * Bounded to `columns` and never wider than 72, like every other rule in
 * the report: a frame that wraps is worse than no frame at all. Every
 * row is padded on the plain text and painted afterwards, so colour can
 * never move the right edge.
 */
export function completionBanner(
  verdict: CompletionVerdict,
  columns: number,
  options: { color?: boolean } = {},
): string[] {
  const width = Math.max(28, Math.min(columns, 72));
  const inner = width - 4;
  const color = options.color ?? !NO_COLOR();
  const paint = (sgr: string, s: string): string =>
    color && sgr !== "" ? `\x1b[${sgr}m${s}\x1b[0m` : s;

  const mark = VERDICT_MARK[verdict.status];
  const edge = (left: string, right: string): string =>
    paint(mark.sgr, `${left}${"─".repeat(width - 2)}${right}`);
  const row = (text: string, sgr: string): string =>
    `${paint(mark.sgr, "│")} ${paint(sgr, text.padEnd(inner))} ${paint(mark.sgr, "│")}`;
  const blank = (): string => row("", "");

  /**
   * One item, over as many rows as it needs, hanging under its own lead.
   *
   * The lead is what tells the items apart — the glyph, the arrow — so a
   * continuation that starts back at the left margin reads as a new
   * item rather than as the rest of this one.
   */
  const item = (lead: string, text: string, sgr: string): string[] => {
    const hang = " ".repeat(lead.length);
    const [first, ...rest] = wrapTo(text, inner - lead.length);
    return [row(`${lead}${first ?? ""}`, sgr), ...rest.map((l) => row(`${hang}${l}`, sgr))];
  };

  const out: string[] = ["", edge("┌", "┐")];
  out.push(...item(`${mark.glyph}  `, verdict.headline, mark.sgr));
  out.push(blank());
  for (const fact of verdictFacts(verdict)) {
    // Split at the first double space, which is the label separator
    // verdictFacts uses: "log  /path" hangs under the path, not the
    // label, so an orphan "log" never sits alone on a row.
    const split = fact.indexOf("  ");
    const lead = split > 0 ? fact.slice(0, split + 2) : "";
    out.push(...item(lead, fact.slice(lead.length), "1;90"));
  }
  if (verdict.failures.length > 0) {
    out.push(blank());
    out.push(row("Errors", "1;31"));
    for (const failure of failureFacts(verdict)) out.push(...item("✗ ", failure, "1;31"));
  }
  if (verdict.deferrals.length > 0) {
    out.push(blank());
    out.push(row("Waiting", "1;33"));
    for (const deferral of deferralFacts(verdict)) out.push(...item("! ", deferral, "1;33"));
  }
  if (verdict.nextSteps.length > 0) {
    out.push(blank());
    for (const step of verdict.nextSteps) out.push(...item("→ ", step, ""));
  }
  out.push(edge("└", "┘"), "");
  return out;
}
