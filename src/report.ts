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
 * names the failures rather than counting them.
 *
 * Written to survive a pipe. No cursor movement, no redraw, no spinner
 * — the prefix is written when a step starts and the line is completed
 * when it ends, so a terminal shows live progress and a log file ends
 * up with exactly the same complete lines.
 */

import { captureStart, captureStop } from "./log.ts";

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
export type Outcome = "installed" | "applied" | "present" | "skipped" | "failed";

const MARK: Record<Outcome, string> = {
  installed: paint("1;32", "installed"),
  applied: paint("1;32", "applied"),
  present: paint("1;90", "present"),
  skipped: paint("1;90", "skipped"),
  failed: paint("1;31", "FAILED"),
};

interface Entry {
  scope: string;
  name: string;
  outcome: Outcome;
  ms: number;
  detail?: string;
}

function human(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

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
  begin(name: string, provider: string): (outcome: Outcome, detail?: string) => void {
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

    return (outcome: Outcome, detail?: string) => {
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
      if (detail && outcome === "failed") {
        console.log(`          ${paint("1;31", detail)}`);
      }
      this.entries.push({ scope: this.scopeName, name, outcome, ms, detail });
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
   * Failures are re-listed by name here. Counting them and leaving the
   * detail sixty lines up is what makes people re-run instead of read.
   */
  finish(): { failed: number } {
    this.closeLine();
    const by = (o: Outcome) => this.entries.filter((e) => e.outcome === o);
    const failed = by("failed");

    console.log("");
    console.log(rule("summary"));

    const rows: [string, number][] = [
      ["installed", by("installed").length],
      ["applied", by("applied").length],
      ["already present", by("present").length],
      ["skipped", by("skipped").length],
      ["failed", failed.length],
    ];
    for (const [label, n] of rows) {
      if (n === 0 && label !== "failed") continue;
      const painted = label === "failed" && n > 0 ? paint("1;31", String(n)) : String(n);
      console.log(`  ${label.padEnd(16)} ${painted}`);
    }
    console.log(`  ${"elapsed".padEnd(16)} ${human(Date.now() - this.started)}`);

    // The three slowest steps, when anything took real time. On a fresh
    // machine this is the difference between "it was slow" and "docker
    // took four minutes".
    const slow = this.entries
      .filter((e) => e.ms >= 3000)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 3);
    if (slow.length > 0) {
      console.log("");
      console.log(`  ${paint("1;90", "slowest")}`);
      for (const e of slow) {
        console.log(`  ${" ".repeat(2)}${e.name.padEnd(17)} ${human(e.ms)}`);
      }
    }

    if (failed.length > 0) {
      console.log("");
      console.log(`  ${paint("1;31", "failed")}`);
      for (const e of failed) {
        console.log(`    ${e.name.padEnd(17)} ${e.detail ?? ""}`);
      }
      console.log("");
      console.log(`  ${paint("1;90", "Re-running is safe: every provider is idempotent.")}`);
    }
    console.log("");

    return { failed: failed.length };
  }
}
