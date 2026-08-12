/**
 * Execution reporting.
 *
 * The previous output was a flat stream of `skip` lines with no
 * progress, no timing and no structure. On a fresh machine that is
 * twenty-odd identical-looking lines followed by several minutes of raw
 * apt output, during which nothing says which tool is being installed,
 * how many are left, or how long it has taken. When something failed
 * you got one line among sixty and no way to see it afterwards.
 *
 * What this reports instead: where in the run you are, what is
 * happening right now, how long each step took, and a summary that
 * names the failures rather than counting them — and, apart from them,
 * names the work that was never allowed to run.
 *
 * Written to survive a pipe. No cursor movement, no redraw, no spinner
 * — the prefix is written when a step starts and the line is completed
 * when it ends, so a terminal shows live progress and a log file ends
 * up with exactly the same complete lines.
 */

import { captureStart, captureStop, formatDuration } from "./log.ts";

const useColor = process.stdout.isTTY === true && !process.env["NO_COLOR"];
const paint = (code: string, s: string): string =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

/**
 * `applied` exists because "installed" was a lie for managed providers.
 * A builtin that writes dotfiles, themes a config or registers a font
 * converges toward a desired state; on a second run it legitimately
 * changes nothing, and reporting that as an install is the kind of
 * confident-and-wrong output this whole file is meant to remove.
 */
/**
 * `deferred` is the outcome for work this run was not allowed to do.
 *
 * Amber rather than red, and lower-case rather than shouted, because
 * that is what it is: an item waiting on rights, on a machine where
 * everything else converged. See converge.ts, which decides it.
 */
export type Outcome = "installed" | "applied" | "present" | "skipped" | "deferred" | "failed";

const MARK: Record<Outcome, string> = {
  installed: paint("1;32", "installed"),
  applied: paint("1;32", "applied"),
  present: paint("1;90", "present"),
  skipped: paint("1;90", "skipped"),
  deferred: paint("1;33", "deferred"),
  failed: paint("1;31", "FAILED"),
};

export interface Entry {
  scope: string;
  name: string;
  outcome: Outcome;
  ms: number;
  detail?: string;
  /** What to do about it, for the outcomes where there is something. */
  remedy?: string;
}

// One implementation, shared with the narration in the log: a row that
// says 3.4s beside a line that says 3400ms reads as two measurements.
const human = formatDuration;

function rule(label: string): string {
  const width = Math.min(process.stdout.columns ?? 72, 72);
  const head = `── ${label} `;
  return paint("1;90", head + "─".repeat(Math.max(0, width - head.length)));
}

export class Reporter {
  private entries: Entry[] = [];
  private started = Date.now();
  private scopeName = "";
  private index = 0;
  private total = 0;
  private openLine = false;

  /** Begin a scope. `total` drives the [n/N] counter. */
  scope(name: string, total: number): void {
    this.closeLine();
    this.scopeName = name;
    this.index = 0;
    this.total = total;
    console.log("");
    console.log(rule(`${name} · ${total} ${total === 1 ? "item" : "items"}`));
  }

  /**
   * Announce a step and return the function that closes it.
   *
   * The prefix goes out immediately so a long install shows which tool
   * it is on rather than looking hung behind apt's own output.
   */
  begin(
    name: string,
    provider: string,
  ): (outcome: Outcome, detail?: string, remedy?: string) => void {
    this.closeLine();
    this.index++;
    const started = Date.now();
    const counter = paint("1;90", `[${String(this.index).padStart(2)}/${this.total}]`);
    // Provider labels run long — a gh: glob can be sixty characters —
    // and letting one wrap destroys the column the eye is scanning.
    const short = provider.length > 30 ? provider.slice(0, 29) + "…" : provider;
    process.stdout.write(`  ${counter} ${name.padEnd(15)} ${paint("1;90", short.padEnd(30))} `);
    this.openLine = true;
    captureStart();

    return (outcome: Outcome, detail?: string, remedy?: string) => {
      const held = captureStop();
      const ms = Date.now() - started;
      // Timing only where it is information: a sub-second skip is
      // noise, a 40-second download answers "why is this slow".
      const time = ms >= 1000 ? paint("1;90", ` ${human(ms)}`) : "";
      process.stdout.write(`${MARK[outcome]}${time}\n`);
      this.openLine = false;

      // What the provider had to say, indented under its own row
      // instead of overwriting it.
      for (const line of held) {
        console.log(`          ${paint("1;90", line.replace(/\x1b\[[0-9;]*m/g, "").trim())}`);
      }
      // Said at the item as well as in the summary, for both outcomes
      // that have something to say. A deferral whose cause appears only
      // at the end leaves the row itself unexplained, which is where
      // somebody watching the run is actually looking.
      if (detail && outcome === "failed") {
        console.log(`          ${paint("1;31", detail)}`);
      } else if (detail && outcome === "deferred") {
        console.log(`          ${paint("1;33", detail)}`);
      }
      this.entries.push({ scope: this.scopeName, name, outcome, ms, detail, remedy });
    };
  }

  /** A message that is not a step, printed without disturbing a line. */
  note(msg: string): void {
    this.closeLine();
    console.log(`  ${paint("1;34", "::")} ${msg}`);
  }

  private closeLine(): void {
    if (this.openLine) {
      process.stdout.write("\n");
      this.openLine = false;
    }
  }

  /**
   * Close the run.
   *
   * The lines themselves are built by summaryLines, which is where the
   * decisions about what a summary says now live — this prints them.
   */
  finish(): { failed: number; deferred: number } {
    this.closeLine();

    console.log("");
    console.log(rule("summary"));
    for (const line of summaryLines(this.entries, Date.now() - this.started)) {
      console.log(line);
    }
    console.log("");

    const count = (o: Outcome): number => this.entries.filter((e) => e.outcome === o).length;
    return { failed: count("failed"), deferred: count("deferred") };
  }
}

/**
 * The summary, as lines. PURE.
 *
 * A function rather than more of `finish` because what a summary claims
 * is the whole point of the file, and a claim nothing can check is a
 * preference: this is the only piece a test can hold without a terminal,
 * a package manager and half an hour.
 *
 * Deferred work is listed apart from failures and named item by item.
 * Both halves matter. Folded into the failures, a machine that converged
 * everything it had the rights for reads as broken; reduced to a count,
 * the reader goes back through a transcript to learn which of thirty-six
 * items the number was about.
 */
export function summaryLines(entries: Entry[], elapsedMs: number): string[] {
  const by = (o: Outcome): Entry[] => entries.filter((e) => e.outcome === o);
  const deferred = by("deferred");
  const failed = by("failed");
  const out: string[] = [];

  const rows: [string, number][] = [
    ["installed", by("installed").length],
    ["applied", by("applied").length],
    ["already present", by("present").length],
    ["skipped", by("skipped").length],
    ["deferred", deferred.length],
    ["failed", failed.length],
  ];
  for (const [label, n] of rows) {
    // `failed` is printed at zero because a zero there is the news. The
    // rest, deferred included, stay silent: a permanent "deferred 0" on
    // every machine that needs no rights is noise, and noise is what
    // teaches people to skip the block that matters.
    if (n === 0 && label !== "failed") continue;
    const colour = label === "failed" ? "1;31" : label === "deferred" ? "1;33" : "";
    const painted = colour && n > 0 ? paint(colour, String(n)) : String(n);
    out.push(`  ${label.padEnd(16)} ${painted}`);
  }
  out.push(`  ${"elapsed".padEnd(16)} ${human(elapsedMs)}`);

  // The three slowest steps, when anything took real time. On a fresh
  // machine this is the difference between "it was slow" and "docker
  // took four minutes".
  const slow = entries
    .filter((e) => e.ms >= 3000)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3);
  if (slow.length > 0) {
    out.push("", `  ${paint("1;90", "slowest")}`);
    for (const e of slow) out.push(`    ${e.name.padEnd(17)} ${human(e.ms)}`);
  }

  if (deferred.length > 0) {
    out.push("", `  ${paint("1;33", "deferred")}`);
    for (const e of deferred) out.push(`    ${e.name.padEnd(17)} ${e.detail ?? ""}`);
    // Once per remedy, not once per item: several items can be waiting
    // on the same gate, and repeating one instruction beside each of
    // them reads as several unrelated things to go and do.
    const remedies = [...new Set(deferred.map((e) => e.remedy).filter(Boolean))];
    if (remedies.length > 0) {
      out.push("");
      for (const remedy of remedies) out.push(`    ${remedy}`);
    }
    out.push("", `  ${paint("1;90", "Nothing here broke — this work is waiting, not lost.")}`);
  }

  if (failed.length > 0) {
    out.push("", `  ${paint("1;31", "failed")}`);
    for (const e of failed) out.push(`    ${e.name.padEnd(17)} ${e.detail ?? ""}`);
    out.push("", `  ${paint("1;90", "Re-running is safe: every provider is idempotent.")}`);
  }

  return out;
}
