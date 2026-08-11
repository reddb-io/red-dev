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
// createScrollArea lives under the organisms subpath's own export, the
// same place LogViewer comes from.
import { createScrollArea, type ScrollAreaState } from "tuiuiu.js";
import { VERSION } from "./cli.ts";
import { converge, countSteps, type StepResult } from "./converge.ts";
import { captureStart, captureStop, captureTo } from "./log.ts";
import { Accented, Header, Screen, Section, StatusLine, Surface } from "./tui-chrome.ts";
import { muted, subtle, text, ui } from "./tui-theme.ts";
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
  /** True when the key was a scroll key and the caller should stop. */
  handleKey: (input: string, key: KeyPress) => boolean;
}

export interface KeyPress {
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
}

/** Apply one install-log navigation key to the real scroll state. */
export function handleInstallScroll(
  logScroll: ScrollAreaState,
  setFollowing: (following: boolean) => void,
  input: string,
  key: KeyPress,
): boolean {
  if (key.upArrow || input === "k") {
    logScroll.scrollBy(-1);
    setFollowing(false);
    return true;
  }
  if (key.downArrow || input === "j") {
    logScroll.scrollBy(1);
    setFollowing(logScroll.scrollTop() >= logScroll.maxScroll());
    return true;
  }
  if (key.pageUp) {
    logScroll.pageUp();
    setFollowing(false);
    return true;
  }
  if (key.pageDown) {
    logScroll.pageDown();
    setFollowing(logScroll.scrollTop() >= logScroll.maxScroll());
    return true;
  }
  if (input === "g") {
    logScroll.scrollToTop();
    setFollowing(false);
    return true;
  }
  if (input === "G") {
    logScroll.scrollToBottom();
    setFollowing(true);
    return true;
  }
  return false;
}

export function useInstallModel(
  opts: InstallTuiOptions,
  logScroll: ScrollAreaState,
  onFinish: (outcome: { failed: number; deferred: number }) => void,
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
      setFinishedAt(Date.now());
      setFinished(true);
      const setupFailed = setupResults().filter((result) => result.outcome === "failed").length;
      onFinish({ failed: summary.failed + setupFailed, deferred: summary.deferred });
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
    handleKey: (input, key) => {
      // Following the tail is right while a converge runs, but it makes
      // the one thing you would want to do — read the error that
      // scrolled past — impossible. Moving up stops the follow; reaching
      // the bottom resumes it, so there is no mode to remember.
      return handleInstallScroll(logScroll, setFollowing, input, key);
    },
  };
}

/**
 * The converge view, as a function of the model and nothing else.
 *
 * No hooks in here on purpose: whoever owns the state decides when to
 * draw this, and a conditional hook call would shift the hook order
 * between frames.
 */
export function InstallLayout(m: InstallModel, width: number, height: number) {
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
  // LogViewer spends two more: its scrollbar glyph and its left margin.
  // Reserve all four up front so the scrollbar appearing cannot make
  // already-visible lines wrap and change the viewport height.
  const logTextWidth = Math.max(8, leftWidth - 4);

  const by = (o: string): number => results.filter((r) => r.outcome === o).length;
  const failures = results.filter((r) => r.outcome === "failed");
  const deferrals = results.filter((r) => r.outcome === "deferred");
  const elapsedMs = m.elapsedMs();
  const rightRows =
    14 + Math.min(failures.length, 6) + Math.min(deferrals.length, 6) + (finished ? 4 : 0);

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
          LogViewer({
            // Cut here rather than where the lines are made: this is
            // where the width is known, and it is the width now rather
            // than whatever it was when the line arrived. A fresh array
            // each frame is safe — the scroll area keys off content
            // length, which this does not change.
            lines: m.lines().map((l) => fitToWidth(l, logTextWidth)),
            height: logRows,
            // Follow the tail only while nobody has scrolled away from
            // it. Passing `true` unconditionally is what made the scroll
            // position unreachable: LogViewer calls scrollToBottom() on
            // every render when autoScroll is set, so a keypress moved
            // the view and the next frame put it straight back.
            autoScroll: m.following(),
            state: m.logScroll,
            highlightPattern: /(✗|failed)/,
            highlightColor: ui.danger,
          }),
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

/**
 * `red-dev install` on its own: one render, which is the only case this
 * still owns. Reaching the converge from the menu no longer comes
 * through here — see useInstallModel for why that mattered.
 */
export async function runInstallTui(
  opts: InstallTuiOptions,
): Promise<{ failed: number; deferred: number }> {
  let outcome = { failed: 0, deferred: 0 };
  const logScroll = createScrollArea({ height: 10, content: [], autoScroll: true });

  function App() {
    const { exit } = useApp();
    const size = useTerminalSize();
    const model = useInstallModel(opts, logScroll, (finished) => {
      outcome = finished;
    });

    useEffect(() => model.begin());

    useInput((input, key) => {
      if (model.handleKey(input, key)) return;
      // Refused until it finishes: leaving halfway abandons the machine
      // mid-converge with no report of where it stopped.
      if (model.finished() && (key.return || input === "q" || key.escape)) exit();
    });

    return InstallLayout(model, size.columns ?? 100, Math.max(size.rows ?? 24, 16));
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
