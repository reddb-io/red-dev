/**
 * The converge, watched live.
 *
 * A fresh machine spends several minutes inside apt and a dozen
 * downloads. The line-based report answers "what is happening" well
 * enough when you are reading a log afterwards; while it runs, the
 * question is different — how far in am I, what is it on right now, and
 * has anything failed yet.
 *
 * Same loop as the text path. converge() emits events; this turns them
 * into signals and draws them, where main.ts turns them into lines.
 * Neither reimplements the ordering or the failure policy.
 */

import { Box, Text, render, useApp, useEffect, useInput, useState, useTerminalSize } from "tuiuiu.js";
import { converge, countSteps, type StepResult } from "./converge.ts";
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

function Bar(done: number, total: number, width: number) {
  const filled = total === 0 ? 0 : Math.round((done / total) * width);
  return Box(
    { flexDirection: "row" },
    Text({ color: "red" }, "█".repeat(Math.max(0, filled))),
    Text({ dim: true }, "░".repeat(Math.max(0, width - filled))),
  );
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

    const [done, setDone] = useState<StepResult[]>([]);
    const [current, setCurrent] = useState("");
    const [provider, setProvider] = useState("");
    const [scope, setScope] = useState("");
    const [note, setNote] = useState("");
    const [finished, setFinished] = useState(false);
    const [startedAt] = useState(Date.now());
    // Re-render on a timer so the elapsed clock moves even while a
    // single long step (apt, a 90 MB download) produces no events.
    const [, setTick] = useState(0);

    useEffect(() => {
      const timer = setInterval(() => setTick((n) => n + 1), 1000);

      void converge(
        { platform: opts.platform, ctx: opts.ctx, scopes: opts.scopes, dryRun: false },
        {
          scopeStart: (s) => setScope(s),
          note: (m) => setNote(m),
          stepStart: (e) => {
            setCurrent(e.tool);
            setProvider(e.provider);
          },
          stepEnd: (r) => setDone((prev) => [...prev, r]),
        },
      ).then((summary) => {
        outcome = { failed: summary.failed };
        setFinished(true);
        clearInterval(timer);
      });

      return () => clearInterval(timer);
    });

    useInput((input, key) => {
      // Only after it finishes: quitting mid-converge would leave the
      // machine half-done with no report of where it stopped.
      if (finished() && (key.return || input === "q" || key.escape)) exit();
    });

    const results = done();
    const width = Math.max(size.columns ?? 80, 60);
    const barWidth = Math.min(width - 24, 40);
    const failures = results.filter((r) => r.outcome === "failed");

    // A window over the tail, so a 33-step run does not scroll the
    // header off a short terminal.
    const visible = results.slice(-10);

    return Box(
      { flexDirection: "column", padding: 1 },

      Box(
        { flexDirection: "row", justifyContent: "space-between", marginBottom: 1 },
        Text({ color: "red", bold: true }, "red-dev"),
        Text({ dim: true }, finished() ? "done" : `scope: ${scope()}`),
      ),

      Box(
        { flexDirection: "row", marginBottom: 1 },
        Bar(results.length, total, barWidth),
        Text({ dim: true }, `  ${results.length}/${total}  ·  ${human(Date.now() - startedAt())}`),
      ),

      ...(note() ? [Text({ dim: true }, `  ${note()}`), Text({}, "")] : []),

      Box(
        { flexDirection: "column", borderStyle: "round", padding: 1 },
        ...visible.map((r) => {
          const m = MARK[r.outcome] ?? { glyph: "·" };
          return Box(
            { flexDirection: "row" },
            Text({ color: m.color }, `${m.glyph} `),
            Text({}, r.tool.padEnd(16)),
            Text({ dim: true }, r.outcome.padEnd(10)),
            Text({ dim: true }, r.ms >= 1000 ? human(r.ms) : ""),
          );
        }),
        ...(finished()
          ? []
          : [
              Box(
                { flexDirection: "row" },
                Text({ color: "yellow" }, "▸ "),
                Text({ bold: true }, current().padEnd(16)),
                Text({ dim: true }, provider().slice(0, 34)),
              ),
            ]),
      ),

      ...(failures.length > 0
        ? [
            Box({ marginTop: 1 }, Text({ color: "red", bold: true }, `${failures.length} failed`)),
            ...failures
              .slice(0, 3)
              .map((f) => Text({ dim: true }, `  ${f.tool}: ${(f.detail ?? "").slice(0, 60)}`)),
          ]
        : []),

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
