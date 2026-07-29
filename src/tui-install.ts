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
import { converge, countSteps, type StepResult } from "./converge.ts";
import { captureStart, captureStop } from "./log.ts";
import type { Scope } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import type { ApplyContext } from "./providers.ts";

const MARK: Record<string, { glyph: string; color?: string }> = {
  installed: { glyph: "✓", color: "green" },
  applied: { glyph: "✓", color: "green" },
  present: { glyph: "·" },
  skipped: { glyph: "·" },
  failed: { glyph: "✗", color: "red" },
};

function human(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** One line in the log column. */
interface LogLine {
  text: string;
  color?: string;
  dim?: boolean;
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

    const [lines, setLines] = useState<LogLine[]>([]);
    const [done, setDone] = useState<StepResult[]>([]);
    const [current, setCurrent] = useState("");
    const [scope, setScope] = useState("");
    const [finished, setFinished] = useState(false);
    const [startedAt] = useState(Date.now());
    // A timer, not just events: a single apt step can run for minutes
    // without emitting anything, and a frozen clock reads as a hang.
    const [, setTick] = useState(0);

    const push = (line: LogLine): void => setLines((prev) => [...prev, line]);

    useEffect(() => {
      const timer = setInterval(() => setTick((n) => n + 1), 1000);

      void converge(
        { platform: opts.platform, ctx: opts.ctx, scopes: opts.scopes, dryRun: false },
        {
          scopeStart: (s, n) => {
            setScope(s);
            push({ text: `── ${s} · ${n} items`, dim: true });
          },
          note: (m) => push({ text: `   ${m}`, dim: true }),
          stepStart: (e) => {
            setCurrent(e.tool);
            // Hold provider chatter so it lands under its own step
            // rather than interleaving with the next one.
            captureStart();
          },
          stepEnd: (r) => {
            const held = captureStop();
            const m = MARK[r.outcome] ?? { glyph: "·" };
            push({
              text: `${m.glyph} ${r.tool.padEnd(16)} ${r.outcome}${r.ms >= 1000 ? `  ${human(r.ms)}` : ""}`,
              ...(m.color ? { color: m.color } : {}),
            });
            for (const h of held) {
              push({ text: `    ${h.replace(/\x1b\[[0-9;]*m/g, "").trim()}`, dim: true });
            }
            if (r.detail && r.outcome === "failed") {
              push({ text: `    ${r.detail}`, color: "red" });
            }
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
    const rightWidth = 30;
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

      Box(
        { flexDirection: "row", justifyContent: "space-between", marginBottom: 1 },
        Text({ color: "red", bold: true }, "red-dev"),
        Text({ dim: true }, finished() ? "done" : `${scope()} · ${current()}`),
      ),

      Box(
        { flexDirection: twoColumn ? "row" : "column" },

        // Left: the log. Wide, because this is what you read.
        Box(
          { flexDirection: "column", width: leftWidth, height: logRows + 2, borderStyle: "round", padding: 1 },
          ...lines()
            .slice(-logRows)
            .map((l) =>
              Text({ ...(l.color ? { color: l.color } : {}), ...(l.dim ? { dim: true } : {}) }, l.text),
            ),
        ),

        // Right: the numbers. Narrow, and the position never shifts, so
        // the eye can return to the same spot.
        Box(
          { flexDirection: "column", width: twoColumn ? rightWidth : leftWidth, borderStyle: "round", padding: 1, ...(twoColumn ? { marginLeft: 1 } : { marginTop: 1 }) },
          Text({ dim: true }, "PROGRESS"),
          Text({}, ""),
          ProgressBar({
            value: results.length,
            max: total,
            width: rightWidth - 6,
            style: "block",
            color: failures.length > 0 ? "yellow" : "red",
            showValue: true,
            showEta: !finished(),
            eta:
              results.length > 0 && !finished()
                ? Math.round(((elapsedMs / results.length) * (total - results.length)) / 1000)
                : 0,
          }),
          Text({}, ""),
          MultiProgressBar({
            segments: [
              { value: by("installed") + by("applied"), color: "green", label: "new" },
              { value: by("present"), color: "gray", label: "present" },
              { value: by("failed"), color: "red", label: "failed" },
            ],
            total,
            width: rightWidth - 6,
          }),
          Text({}, ""),
          Text({ dim: true }, `elapsed   ${human(elapsedMs)}`),
          Text({ dim: true }, `installed ${by("installed") + by("applied")}`),
          Text({ dim: true }, `present   ${by("present")}`),
          Text(
            failures.length > 0 ? { color: "red" } : { dim: true },
            `failed    ${failures.length}`,
          ),
          ...(failures.length > 0
            ? [
                Text({}, ""),
                Text({ color: "red", dim: true }, "FAILED"),
                ...failures.slice(0, 5).map((f) => Text({ dim: true }, `  ${f.tool}`)),
              ]
            : []),
        ),
      ),

      Box(
        { marginTop: 1 },
        Text(
          { dim: true },
          finished()
            ? failures.length > 0
              ? "enter to leave — re-running is safe, every provider is idempotent"
              : "converged · enter to leave · restart your shell"
            : "working…",
        ),
      ),
    );
  }

  const { waitUntilExit } = render(App);
  await waitUntilExit();
  return outcome;
}
