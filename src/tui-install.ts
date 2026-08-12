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
  MultiProgressBar,
  ProgressBar,
  ScrollArea,
  Text,
  render,
  useApp,
  useEffect,
  useInput,
  useState,
  useTerminalSize,
} from "tuiuiu.js";
// createScrollArea lives under the organisms subpath's own export, the
// same place LogViewer comes from.
import { createScrollArea, type ScrollAreaState } from "tuiuiu.js";
import { VERSION } from "./cli.ts";
import {
  convergeVerdict,
  shortenHome,
  verdictFacts,
  wrapTo,
  VERDICT_MARK,
  type VerdictItem,
} from "./completion.ts";
import { converge, countSteps, type StepResult } from "./converge.ts";
import { captureStart, captureStop, captureTo } from "./log.ts";
import { Accented, Header, Screen, Section, StatusLine, Surface } from "./tui-chrome.ts";
import { muted, subtle, text, ui } from "./tui-theme.ts";
import { transcriptPath } from "./transcript.ts";
import type { Scope } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import type { ApplyContext } from "./providers.ts";
import type { SetupPlanStep, SetupStepResult } from "./firstrun.ts";
import { withConsoleSelectionSuspended } from "./windows-console-mode.ts";

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


/**
 * One log line, cut to the columns it actually has.
 *
 * LogViewer draws each line with a plain Text, and Text wraps. A wrapped
 * line costs a row the layout budgeted for something else and breaks a
 * path across two rows mid-segment, which is how a converge full of
 * Windows paths turns a log into something you cannot read down. Cutting
 * is the only option that keeps the shape: a log does not scroll
 * sideways.
 */
export function fitToWidth(line: string, width: number): string {
  if (width < 2) return "";
  return line.length <= width ? line : `${line.slice(0, width - 1)}\u2026`;
}

export interface InstallTuiOptions {
  platform: Platform;
  ctx: ApplyContext;
  scopes: Scope[];
}

/**
 * Everything the converge view needs, and nothing about how it is drawn.
 *
 * Split out because the menu and the converge have to live inside one
 * `render()`. They did not, and it crashed: picking Install from the
 * fullscreen interface tore the first app down and started a second one,
 * and on Windows the second `initializeApp` failed and its own cleanup
 * wrote to a stdout that was already gone —
 *
 *     Error: EPIPE: broken pipe, write
 *         at dispose → initializeApp → render → runInstallTui
 *
 * — which killed the process and took the console with it. Three
 * separate experiments failed to reproduce that from a synthetic double
 * render; the crash log from a real run named it in one stack.
 *
 * So: hooks here, layout below, and the menu owns both by calling this
 * unconditionally and drawing the layout only when it is showing.
 * Unconditionally matters — a hook called behind an `if` changes the
 * hook order between frames.
 */
export interface InstallModel {
  lines: () => string[];
  results: () => StepResult[];
  setupResults: () => SetupStepResult[];
  setupTotal: () => number;
  current: () => string;
  scope: () => string;
  finished: () => boolean;
  following: () => boolean;
  /** Pause tail-following when the reader moves away; resume at the end. */
  followScroll: (position: number) => void;
  elapsedMs: () => number;
  total: number;
  logScroll: ScrollAreaState;
  /** Start converging. Idempotent; the menu calls it when you pick Install. */
  prelude: (label: string) => void;
  setupBegin: (steps: SetupPlanStep[]) => void;
  setupStepStart: (step: SetupPlanStep) => void;
  setupStepEnd: (result: SetupStepResult) => void;
  begin: () => void;
  /**
   * Add a line to the log from outside the converge.
   *
   * For the work that happens between answering the interview and the
   * first step — recording the shared root, writing preferences. Those
   * speak through `log`, and without somewhere to put their output they
   * write straight to the console and tear a hole in the frame the
   * renderer owns.
   */
  note: (line: string) => void;
}

/**
 * What a finished converge hands back.
 *
 * The counts are what the exit status is made of; the results and the
 * clock are what the completion screen and the banner after it are made
 * of. Carried out rather than recomputed because the setup phase's
 * items exist only in here — a verdict built from the converge summary
 * alone would forget the agents and runtimes.
 */
export interface InstallOutcome {
  failed: number;
  deferred: number;
  results: VerdictItem[];
  elapsedMs: number;
}

export function useInstallModel(
  opts: InstallTuiOptions,
  logScroll: ScrollAreaState,
  onFinish: (outcome: InstallOutcome) => void,
): InstallModel {
  const total = countSteps(opts.scopes);

  const [lines, setLines] = useState<string[]>([]);
  const [results, setResults] = useState<StepResult[]>([]);
  const [setupResults, setSetupResults] = useState<SetupStepResult[]>([]);
  const [setupTotal, setSetupTotal] = useState(0);
  const [current, setCurrent] = useState("");
  const [scope, setScope] = useState("");
  const [finished, setFinished] = useState(false);
  // When it stopped, so Elapsed can stop with it.
  const [finishedAt, setFinishedAt] = useState(0);
  // Whether the log is pinned to the tail. Starts true, and the arrow
  // keys are what turn it off.
  const [following, setFollowing] = useState(true);
  const [startedAt, setStartedAt] = useState(0);
  const [started, setStarted] = useState(false);
  // A timer, not just events: a single apt step can run for minutes
  // without emitting anything, and a frozen clock reads as a hang.
  const [, setTick] = useState(0);

  // The scroll state is the caller's, built outside the component.
  //
  // Not useState(() => createScrollArea(...)): tuiuiu's useState has no
  // lazy initialiser, so the function itself becomes the value and every
  // scroll call lands on a closure instead of a scroll area. And
  // creating it during render is the mistake createWizard already taught
  // — signals rebuilt thirty times a second.

  // Streaming apt into the log changed what this buffer holds: a step
  // line per tool is dozens, a hundred-package transaction is thousands,
  // and every push copies the whole array. Capped at a depth no one
  // scrolls past by hand — the failures are read at the tail.
  const MAX_LINES = 2000;
  const push = (line: string): void =>
    setLines((prev) => (prev.length < MAX_LINES ? [...prev, line] : [...prev.slice(1), line]));

  /** Closes the batch's log redirect. Non-null only while apt is running. */
  let releaseBatch: (() => void) | null = null;

  /** Log lines carry colour; the viewer takes plain strings. */
  const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "").trim();

  // The clock is its own effect, unconditional. It used to start with
  // the converge, which left Elapsed frozen at 0s through the whole
  // setup phase — agents and runtimes can take minutes, and a frozen
  // clock reads as a hang.
  useEffect(() => {
    const clock = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(clock);
  });

  useEffect(() => {
    if (!started()) return;

    void converge(
      { platform: opts.platform, ctx: opts.ctx, scopes: opts.scopes, dryRun: false },
      {
        scopeStart: (s, n) => {
          setScope(s);
          push(`-- ${s} · ${n} items`);
        },
        note: (m) => push(`   ${m}`),
        // captureTo rather than captureStart: this transaction runs for
        // minutes, and holding its output until the end would trade a
        // corrupted frame for a frozen one. Streaming puts apt's
        // progress in the log pane, which is where the eye already is.
        batchStart: (pkgs) => {
          setCurrent("apt");
          releaseBatch = captureTo((line) => push(`    ${plain(line)}`));
          push(`   apt: ${pkgs.length} packages`);
        },
        batchEnd: (error) => {
          releaseBatch?.();
          releaseBatch = null;
          if (error) push(`    ${error}`);
        },
        // The same redirect as apt, for the same reason and never at the
        // same time: apt runs at the head of a scope, this runs after
        // the last step of the run has closed.
        privilegedStart: (items) => {
          setCurrent("administrator");
          releaseBatch = captureTo((line) => push(`    ${plain(line)}`));
          push(`   administrator: ${items.length} item(s) behind one consent`);
        },
        privilegedEnd: () => {
          releaseBatch?.();
          releaseBatch = null;
        },
        stepStart: (e) => {
          setCurrent(e.tool);
          // Hold provider chatter so it lands under its own step rather
          // than interleaving with the next one.
          captureStart();
        },
        stepEnd: (r) => {
          const held = captureStop();
          // LogViewer takes plain strings, so the glyph is chosen here
          // rather than by a component.
          // A deferral gets its own glyph rather than the failure's: it
          // is the row an operator scans for afterwards, and an ✗ beside
          // it is the thing this outcome exists to stop saying.
          const glyph =
            r.outcome === "failed"
              ? "✗"
              : r.outcome === "deferred"
                ? "!"
                : r.outcome === "present" || r.outcome === "skipped"
                  ? "·"
                  : "✓";
          push(`${glyph} ${r.tool.padEnd(16)} ${r.outcome}${r.ms >= 1000 ? `  ${human(r.ms)}` : ""}`);
          for (const h of held) push(`    ${plain(h)}`);
          if (r.detail && (r.outcome === "failed" || r.outcome === "deferred")) {
            push(`    ${r.detail}`);
          }
          // The remedy under the item, in the pane the eye is already
          // on. The right-hand column has room to name what deferred,
          // never room to say what to do about it.
          if (r.remedy) push(`    ${r.remedy}`);
          setResults((prev) => [...prev, r]);
        },
      },
    ).then((summary) => {
      const endedAt = Date.now();
      setFinishedAt(endedAt);
      setFinished(true);
      const setupFailed = setupResults().filter((result) => result.outcome === "failed").length;
      // Setup first, converge second: the same order they ran in, and
      // the order the completion screen counts them in.
      // Mapped apart because they are different records: a setup result
      // has no remedy at all, and a converge result has one only when
      // something is waiting on a gate.
      const all: VerdictItem[] = [
        ...setupResults().map((r) => ({ tool: r.tool, outcome: r.outcome })),
        ...summary.results.map((r) => ({
          tool: r.tool,
          outcome: r.outcome,
          ...(r.remedy ? { remedy: r.remedy } : {}),
        })),
      ];
      onFinish({
        failed: summary.failed + setupFailed,
        deferred: summary.deferred,
        results: all,
        elapsedMs: startedAt() === 0 ? 0 : endedAt - startedAt(),
      });
    });
  });

  return {
    lines,
    results,
    setupResults,
    setupTotal,
    current,
    scope,
    finished,
    following,
    followScroll: (position) => setFollowing(position >= logScroll.maxScroll()),
    // Frozen once the run ends.
    //
    // This read Date.now() on every render, and clearInterval only stops
    // the once-a-second tick — it does not stop the frame re-rendering
    // when someone scrolls the log, which every arrow key does. So a
    // finished converge went on counting for as long as its result was
    // left on screen: a 14-second run reading "4m 48s" because the
    // reader was still looking at it.
    elapsedMs: () => {
      if (startedAt() === 0) return 0;
      return (finishedAt() === 0 ? Date.now() : finishedAt()) - startedAt();
    },
    total,
    logScroll,
    // The phase before the converge: agents and runtimes, run from the
    // wizard's answers. Starts the clock and names itself in the header
    // so the screen is visibly alive while npm does its minutes.
    prelude: (label: string) => {
      if (startedAt() === 0) setStartedAt(Date.now());
      setScope("setup");
      setCurrent(label);
    },
    setupBegin: (steps) => setSetupTotal(steps.length),
    setupStepStart: (step) => setCurrent(step.tool),
    setupStepEnd: (result) => setSetupResults((previous) => [...previous, result]),
    begin: () => {
      if (started()) return;
      if (startedAt() === 0) setStartedAt(Date.now());
      setStarted(true);
    },
    note: (line) => push(line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()),
  };
}

/**
 * The converge view, as a function of the model and nothing else.
 *
 * ScrollArea owns the input lifecycle for the viewport it draws. Callers
 * build this layout on every frame and switch `isActive`; keeping the hook
 * slot stable matters when the menu swaps between sections and the log.
 */
export function InstallLayout(
  m: InstallModel,
  width: number,
  height: number,
  isActive: boolean = true,
) {
  const results = [...m.setupResults(), ...m.results()];
  const total = m.total + m.setupTotal();
  const finished = m.finished();

  // Two columns need room for both. Below that the status column would
  // be clipped mid-word, which is worse than not having it beside the
  // log — so it moves above instead.
  //
  // 34, not 30. At 30 the ProgressBar's own brackets and percentage
  // wrapped onto the next line and the segment legend truncated to
  // "faile". 37 on the outside, because Surface spends three columns on
  // the padding that keeps text off the edge of its own shade.
  const rightWidth = 34;
  const rightOuter = rightWidth + 3;
  const twoColumn = width >= 92;
  const leftWidth = twoColumn ? width - rightOuter - 6 : width - 4;
  const logRows = Math.max(5, height - (twoColumn ? 8 : 16));

  // What a log line actually gets: Accented spends one column on its
  // bar and one on the margin. Once there is anything to scroll,
  // ScrollArea spends two more: its scrollbar glyph and its left margin.
  // Reserve all four up front so the scrollbar appearing cannot make
  // already-visible lines wrap and change the viewport height.
  const logTextWidth = Math.max(8, leftWidth - 4);

  const by = (o: string): number => results.filter((r) => r.outcome === o).length;
  const failures = results.filter((r) => r.outcome === "failed");
  const deferrals = results.filter((r) => r.outcome === "deferred");
  const elapsedMs = m.elapsedMs();
  const rightRows =
    14 + Math.min(failures.length, 6) + Math.min(deferrals.length, 6) + (finished ? 4 : 0);

  const logContent = m.lines().map((line) => {
    const fitted = fitToWidth(line, logTextWidth);
    return Text(
      { color: /(✗|failed)/.test(fitted) ? ui.danger : text },
      fitted,
    );
  });
  // Give the state the new bounds before deciding where "bottom" is.
  // Waiting for ScrollArea.updateOptions would render one stale frame at
  // the old offset, which is visible when the scrollbar first appears.
  m.logScroll.setContent(logContent);
  m.logScroll.setHeight(logRows);
  if (m.following()) m.logScroll.scrollToBottom();

  const logViewport = ScrollArea({
    content: logContent,
    height: logRows,
    width: leftWidth - 2,
    state: m.logScroll,
    onScroll: m.followScroll,
    isActive,
  });
  // ScrollArea intentionally has no auto-follow policy: it owns input,
  // while the log decides whether new output should keep it at the tail.

  return Screen(
    width,
    height,

    Header("red-dev", finished ? "done" : `${m.scope()} · ${m.current()}`),
    Text({}, ""),

    Box(
      { flexDirection: twoColumn ? "row" : "column" },

      // Left: the log, unframed. An accent bar marks it as the live
      // region; a border would cost four lines and say nothing the bar
      // does not.
      Box(
        { width: leftWidth },
        Accented(
          failures.length > 0 ? ui.warn : ui.accent,
          logRows,
          leftWidth,
          logViewport,
        ),
      ),

      // Right: labelled sections on their own shade. The change of
      // background is what separates it, the way OpenCode separates its
      // sidebar. Position never shifts, so the eye can return to the
      // same spot without hunting.
      Box(
        { ...(twoColumn ? { marginLeft: 2 } : { marginTop: 1 }) },
        Surface(
          twoColumn ? rightOuter : leftWidth,
          twoColumn ? logRows + 2 : rightRows,
          Text({ color: muted, bold: true }, finished ? "Done" : "Progress"),
          ProgressBar({
            value: results.length,
            max: total,
            width: rightWidth - 14,
            style: "block",
            color: failures.length > 0 ? ui.warn : ui.accent,
          }),
          // An explicit colour, not `dim`. dim leaves the foreground to
          // the terminal and asks it to darken whatever that was.
          Text(
            { color: muted },
            `${results.length}/${total}${etaText(results.length, total, elapsedMs, finished)}`,
          ),
          Text({}, ""),

          MultiProgressBar({
            segments: [
              { value: by("installed") + by("applied"), color: ui.ok },
              { value: by("present"), color: subtle },
              { value: by("deferred"), color: ui.warn },
              { value: by("failed"), color: ui.danger },
            ],
            total,
            width: rightWidth - 6,
            showLegend: false,
          }),
          Text({}, ""),

          // What was decided, not just what happened. The number that
          // carries the decision is in the accent colour; the ones that
          // are context stay quiet.
          Section(
            "Changed",
            { text: `${by("installed") + by("applied")} installed`, color: ui.accent, bold: true },
            `${by("present")} already present`,
            `${by("skipped")} skipped`,
          ),
          Section("Elapsed", { text: human(elapsedMs), color: text }),

          // Named, not counted, and above the failures rather than
          // among them: "1 deferred" sends the reader back through the
          // log to find out which item it was, which is the whole cost
          // this block exists to remove.
          ...(deferrals.length > 0
            ? [
                Text({ color: ui.warn, bold: true }, "Deferred"),
                ...deferrals
                  .slice(0, 6)
                  .map((d) => ListItem({ primary: d.tool, status: "warning" })),
              ]
            : []),

          ...(failures.length > 0
            ? [
                Text({ color: ui.danger, bold: true }, "Failed"),
                ...failures.slice(0, 6).map((f) => ListItem({ primary: f.tool, status: "error" })),
              ]
            : []),

          // Wrapped by hand to the column, not by hope: "Finished with
          // failures" rendered as "Finished with failu".
          //
          // Three endings, because there are three. A run whose only
          // outstanding work needed rights it did not have is neither
          // "Incomplete" — nothing broke — nor "Converged", since the
          // items above are still waiting for an elevated session.
          ...(finished
            ? [
                Text({}, ""),
                Section(
                  failures.length > 0
                    ? "Incomplete"
                    : deferrals.length > 0
                      ? "Deferred"
                      : "Converged",
                  ...(failures.length > 0
                    ? ["Fix the cause and re-run;", "it resumes from here."]
                    : deferrals.length > 0
                      ? ["Nothing broke. Re-run with", "the rights to finish these."]
                      : ["Restart your shell to", "pick up the changes."]),
                ),
              ]
            : []),
        ),
      ),
    ),

    StatusLine(
      // The hint says what the keys do, and says when following is off —
      // otherwise a log that stopped moving during a live converge reads
      // as a hang rather than as a scrollback.
      finished
        ? `${m.following() ? "" : "paused · G follows · "}up/down scroll · enter leave`
        : `${m.following() ? "working…" : "paused · G follows · "}up/down scroll`,
      `red-dev ${VERSION}`,
    ),
  );
}

/** The colour a verdict is drawn in, from the interface palette. */
const VERDICT_COLOR: Record<string, string> = {
  converged: ui.ok,
  deferred: ui.warn,
  failed: ui.danger,
  preview: ui.info,
};

/**
 * The screen a converge ends on.
 *
 * A run used to end by putting "done" in the header of a view that
 * otherwise looked exactly as it had a second earlier, and then — the
 * moment a key was pressed — by redrawing the menu over it. Someone who
 * arrived through the PowerShell one-liner watched four minutes of work
 * and was handed back a list of sections, with nothing anywhere saying
 * the thing had finished or how it went.
 *
 * So the log gives up the screen at the end. It is not gone: `l` puts it
 * back, which is what somebody chasing a failure wants and nobody else
 * asks for.
 */
export function CompletionLayout(
  outcome: InstallOutcome,
  width: number,
  height: number,
  logPath: string | null,
) {
  const verdict = convergeVerdict(outcome.results, outcome.elapsedMs, {
    logPath: shortenHome(logPath, process.env["HOME"] ?? process.env["USERPROFILE"]),
  });
  const color = VERDICT_COLOR[verdict.status] ?? ui.accent;
  const room = Math.max(24, width - 8);

  return Screen(
    width,
    height,
    Header("red-dev", "finished"),
    Text({}, ""),

    Box(
      {
        flexDirection: "column",
        justifyContent: "center",
        // Centred vertically so the verdict lands where the eye already
        // is, rather than at the top edge of a screen the reader has
        // been watching the middle of.
        height: Math.max(6, height - 6),
      },
      Accented(
        color,
        3,
        width - 2,
        Text({ color, bold: true }, `${VERDICT_MARK[verdict.status].glyph}  ${verdict.headline}`),
        Text({}, ""),
        ...verdictFacts(verdict).flatMap((fact) =>
          wrapTo(fact, room).map((line) => Text({ color: muted }, line)),
        ),
      ),
      Text({}, ""),
      ...(verdict.nextSteps.length > 0
        ? [
            Text({ color: muted, bold: true }, "Next"),
            ...verdict.nextSteps.flatMap((step) =>
              wrapTo(step, room - 2).map((line, i) =>
                Text({ color: text }, `${i === 0 ? "→ " : "  "}${line}`),
              ),
            ),
          ]
        : []),
    ),

    StatusLine("enter finish · l review the log", `red-dev ${VERSION}`),
  );
}

/**
 * `red-dev install` on its own: one render, which is the only case this
 * still owns. Reaching the converge from the menu no longer comes
 * through here — see useInstallModel for why that mattered.
 */
export async function runInstallTui(opts: InstallTuiOptions): Promise<InstallOutcome> {
  let outcome: InstallOutcome = { failed: 0, deferred: 0, results: [], elapsedMs: 0 };
  const logScroll = createScrollArea({ height: 10, content: [], autoScroll: true });

  function App() {
    const { exit } = useApp();
    const size = useTerminalSize();
    // What the completion screen draws, and the flag that says it may.
    // A signal rather than the closure alone: `outcome` is written from
    // a promise callback, and a plain assignment schedules no frame.
    const [done, setDone] = useState<InstallOutcome | null>(null);
    const [reviewing, setReviewing] = useState(false);
    const model = useInstallModel(opts, logScroll, (finished) => {
      outcome = finished;
      setDone(finished);
    });

    useEffect(() => model.begin());

    useInput((input, key) => {
      const finished = done();
      if (finished && !reviewing()) {
        if (input === "l") setReviewing(true);
        else if (key.return || input === "q" || key.escape) exit();
        return;
      }
      // Refused until it finishes: leaving halfway abandons the machine
      // mid-converge with no report of where it stopped. Once it has,
      // the same key goes back to the verdict rather than out — the
      // screen that says it ended is the last thing, always.
      if (finished && (key.return || input === "q" || key.escape)) setReviewing(false);
    });

    const width = size.columns ?? 100;
    const height = Math.max(size.rows ?? 24, 16);
    const finished = done();
    // Built even while the completion screen is showing so ScrollArea's
    // hook keeps the same slot; isActive prevents a hidden log from
    // consuming navigation keys.
    const installView = InstallLayout(model, width, height, !finished || reviewing());
    if (finished && !reviewing()) return CompletionLayout(finished, width, height, transcriptPath());
    return installView;
  }

  // fullHeight: the panels are drawn to the terminal's height rather
  // than to their content, so the log fills the window instead of ending
  // partway down with the previous screen showing underneath.
  await withConsoleSelectionSuspended(async () => {
    const { waitUntilExit } = render(App, { fullHeight: true });
    await waitUntilExit();
  });
  return outcome;
}
