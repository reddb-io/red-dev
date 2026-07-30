/**
 * The converge, watched live.
 *
 * Layout follows the shape the work actually has: the log is the thing
 * you stare at, so it gets the wide left column, and the numbers you
 * glance at — progress, counts, what failed — sit in a narrow right
 * column that never moves. The first version of this had a hand-rolled
 * bar and a single stacked column, which wasted both the screen and the
 * ProgressBar tuiuiu already ships.
 *
 * Same loop as the text path. converge() emits events; this turns them
 * into signals, main.ts turns them into lines. Neither reimplements the
 * ordering or the failure policy.
 */

import {
  Box,
  ListItem,
  LogViewer,
  MultiProgressBar,
  ProgressBar,
  Text,
  render,
  useApp,
  useEffect,
  useInput,
  useState,
  useTerminalSize,
} from "tuiuiu.js";
import { VERSION } from "./cli.ts";
import { converge, countSteps, type StepResult } from "./converge.ts";
import { captureStart, captureStop } from "./log.ts";
import { Accented, Header, Section, StatusLine } from "./tui-chrome.ts";
import type { Scope } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import type { ApplyContext } from "./providers.ts";

/**
 * Outcomes mapped onto tuiuiu's own status vocabulary rather than a
 * private table of glyphs and colours. StatusIndicator and ListItem
 * both understand these, so the icon, its colour and any animation come
 * from the library instead of from a lookup here that would drift from
 * everything else drawn with them.
 */
const STATUS: Record<string, "success" | "info" | "error" | "pending"> = {
  installed: "success",
  applied: "success",
  present: "info",
  skipped: "info",
  failed: "error",
};

function human(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * A remaining-time estimate, or nothing.
 *
 * Deliberately silent for the first few steps: a mean drawn from two
 * samples, where one of them was a 90 MB download, produces a number
 * confident enough to be believed and wrong by minutes.
 */
function etaText(done: number, total: number, elapsedMs: number, finished: boolean): string {
  if (finished || done < 3 || done >= total) return "";
  const remaining = Math.round(((elapsedMs / done) * (total - done)) / 1000);
  return `  ~${human(remaining * 1000)} left`;
}


export interface InstallTuiOptions {
  platform: Platform;
  ctx: ApplyContext;
  scopes: Scope[];
}

export async function runInstallTui(opts: InstallTuiOptions): Promise<{ failed: number }> {
  const total = countSteps(opts.scopes);
  let outcome = { failed: 0 };

  function App() {
    const { exit } = useApp();
    const size = useTerminalSize();

    const [lines, setLines] = useState<string[]>([]);
    const [done, setDone] = useState<StepResult[]>([]);
    const [current, setCurrent] = useState("");
    const [scope, setScope] = useState("");
    const [finished, setFinished] = useState(false);
    const [startedAt] = useState(Date.now());
    // A timer, not just events: a single apt step can run for minutes
    // without emitting anything, and a frozen clock reads as a hang.
    const [, setTick] = useState(0);

    const push = (line: string): void => setLines((prev) => [...prev, line]);

    useEffect(() => {
      const timer = setInterval(() => setTick((n) => n + 1), 1000);

      void converge(
        { platform: opts.platform, ctx: opts.ctx, scopes: opts.scopes, dryRun: false },
        {
          scopeStart: (s, n) => {
            setScope(s);
            push(`-- ${s} · ${n} items`);
          },
          note: (m) => push(`   ${m}`),
          stepStart: (e) => {
            setCurrent(e.tool);
            // Hold provider chatter so it lands under its own step
            // rather than interleaving with the next one.
            captureStart();
          },
          stepEnd: (r) => {
            const held = captureStop();
            // LogViewer takes plain strings, so the glyph is chosen here
            // rather than by a component. ListItem draws the same
            // outcomes in the status column with the library's own
            // icons; this is the one place a character is picked by
            // hand, because a log line is text.
            const glyph = r.outcome === "failed" ? "✗" : r.outcome === "present" || r.outcome === "skipped" ? "·" : "✓";
            push(
              `${glyph} ${r.tool.padEnd(16)} ${r.outcome}${r.ms >= 1000 ? `  ${human(r.ms)}` : ""}`,
            );
            for (const h of held) {
              push(`    ${h.replace(/\x1b\[[0-9;]*m/g, "").trim()}`);
            }
            if (r.detail && r.outcome === "failed") push(`    ${r.detail}`);
            setDone((prev) => [...prev, r]);
          },
        },
      ).then((summary) => {
        outcome = { failed: summary.failed };
        setFinished(true);
        clearInterval(timer);
      });

      return () => clearInterval(timer);
    });

    useInput((input, key) => {
      // Refused until it finishes: leaving halfway abandons the machine
      // mid-converge with no report of where it stopped.
      if (finished() && (key.return || input === "q" || key.escape)) exit();
    });

    const results = done();
    const width = size.columns ?? 100;
    const height = Math.max(size.rows ?? 24, 16);

    // Two columns need room for both. Below that the status column
    // would be clipped mid-word, which is worse than not having it
    // beside the log — so it moves above instead.
    // 34, not 30. At 30 the ProgressBar's own brackets and percentage
    // wrapped onto the next line and the segment legend truncated to
    // "faile" — both of which read as a broken widget rather than a
    // narrow one.
    const rightWidth = 34;
    const twoColumn = width >= 92;
    const leftWidth = twoColumn ? width - rightWidth - 6 : width - 4;
    // The log fills whatever is left after the frame, header and hint —
    // less again when the status block sits above it.
    const logRows = Math.max(5, height - (twoColumn ? 8 : 16));

    const by = (o: string): number => results.filter((r) => r.outcome === o).length;
    const failures = results.filter((r) => r.outcome === "failed");
    const elapsedMs = Date.now() - startedAt();

    return Box(
      { flexDirection: "column", padding: 1 },

      Header("red-dev", finished() ? "done" : `${scope()} · ${current()}`),
      Text({}, ""),

      Box(
        { flexDirection: twoColumn ? "row" : "column" },

        // Left: the log, unframed. An accent bar marks it as the live
        // region; a border around it would cost four lines and say
        // nothing the bar does not.
        Box(
          { width: leftWidth },
          Accented(
            failures.length > 0 ? "yellow" : "red",
            logRows,
            LogViewer({
              lines: lines(),
              height: logRows,
              autoScroll: true,
              highlightPattern: /(✗|failed)/,
              highlightColor: "red",
            }),
          ),
        ),

        // Right: labelled sections, no box. Position never shifts, so
        // the eye can return to the same spot without hunting.
        Box(
          {
            flexDirection: "column",
            width: twoColumn ? rightWidth : leftWidth,
            ...(twoColumn ? { marginLeft: 2 } : { marginTop: 1 }),
          },
          Text({ bold: true }, finished() ? "Done" : "Progress"),
          // ProgressBar draws its own brackets and percentage around
          // the width given, so the width is what fits inside them.
          ProgressBar({
            value: results.length,
            max: total,
            width: rightWidth - 14,
            style: "block",
            color: failures.length > 0 ? "yellow" : "red",
          }),
          Text(
            { dim: true },
            `${results.length}/${total}${etaText(results.length, total, elapsedMs, finished())}`,
          ),
          Text({}, ""),

          // The proportions, without a legend: the counts are spelled
          // out immediately below, and the legend truncated mid-word at
          // any width this column can afford.
          MultiProgressBar({
            segments: [
              { value: by("installed") + by("applied"), color: "green" },
              { value: by("present"), color: "gray" },
              { value: by("failed"), color: "red" },
            ],
            total,
            width: rightWidth - 6,
            showLegend: false,
          }),
          Text({}, ""),

          Section(
            "Counts",
            `installed  ${by("installed") + by("applied")}`,
            `present    ${by("present")}`,
            `skipped    ${by("skipped")}`,
          ),
          Section("Elapsed", human(elapsedMs)),

          ...(failures.length > 0
            ? [
                Text({ color: "red", bold: true }, "Failed"),
                ...failures
                  .slice(0, 6)
                  .map((f) => ListItem({ primary: f.tool, status: STATUS["failed"] })),
              ]
            : []),
        ),
      ),

      StatusLine(
        finished()
          ? failures.length > 0
            ? "enter leave · re-running is safe"
            : "enter leave · restart your shell"
          : "working…",
        `red-dev ${VERSION}`,
      ),
    );
  }

  // fullHeight: the panels are drawn to the terminal's height instead of
  // to their content, so the log fills the window rather than ending
  // partway down with the previous screen showing underneath.
  const { waitUntilExit } = render(App, { fullHeight: true });
  await waitUntilExit();
  return outcome;
}
