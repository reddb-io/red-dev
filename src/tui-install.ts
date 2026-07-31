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
import { captureStart, captureStop } from "./log.ts";
import { Accented, Header, Screen, Section, StatusLine, Surface } from "./tui-chrome.ts";
import { muted, subtle, text, ui } from "./tui-theme.ts";
import type { Scope } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import type { ApplyContext } from "./providers.ts";

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
  current: () => string;
  scope: () => string;
  finished: () => boolean;
  following: () => boolean;
  elapsedMs: () => number;
  total: number;
  logScroll: ScrollAreaState;
  /** Start converging. Idempotent; the menu calls it when you pick Install. */
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

interface KeyPress {
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
}

export function useInstallModel(
  opts: InstallTuiOptions,
  logScroll: ScrollAreaState,
  onFinish: (failed: number) => void,
): InstallModel {
  const total = countSteps(opts.scopes);

  const [lines, setLines] = useState<string[]>([]);
  const [results, setResults] = useState<StepResult[]>([]);
  const [current, setCurrent] = useState("");
  const [scope, setScope] = useState("");
  const [finished, setFinished] = useState(false);
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

  const push = (line: string): void => setLines((prev) => [...prev, line]);

  useEffect(() => {
    if (!started()) return;
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
          // Hold provider chatter so it lands under its own step rather
          // than interleaving with the next one.
          captureStart();
        },
        stepEnd: (r) => {
          const held = captureStop();
          // LogViewer takes plain strings, so the glyph is chosen here
          // rather than by a component.
          const glyph =
            r.outcome === "failed" ? "✗" : r.outcome === "present" || r.outcome === "skipped" ? "·" : "✓";
          push(`${glyph} ${r.tool.padEnd(16)} ${r.outcome}${r.ms >= 1000 ? `  ${human(r.ms)}` : ""}`);
          for (const h of held) push(`    ${h.replace(/\x1b\[[0-9;]*m/g, "").trim()}`);
          if (r.detail && r.outcome === "failed") push(`    ${r.detail}`);
          setResults((prev) => [...prev, r]);
        },
      },
    ).then((summary) => {
      setFinished(true);
      clearInterval(timer);
      onFinish(summary.failed);
    });

    return () => clearInterval(timer);
  });

  return {
    lines,
    results,
    current,
    scope,
    finished,
    following,
    elapsedMs: () => (startedAt() === 0 ? 0 : Date.now() - startedAt()),
    total,
    logScroll,
    begin: () => {
      if (started()) return;
      setStartedAt(Date.now());
      setStarted(true);
    },
    note: (line) => push(line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()),
    handleKey: (input, key) => {
      // Following the tail is right while a converge runs, but it makes
      // the one thing you would want to do — read the error that
      // scrolled past — impossible. Moving up stops the follow; reaching
      // the bottom resumes it, so there is no mode to remember.
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
  const results = m.results();
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

  const by = (o: string): number => results.filter((r) => r.outcome === o).length;
  const failures = results.filter((r) => r.outcome === "failed");
  const elapsedMs = m.elapsedMs();
  const rightRows = 14 + Math.min(failures.length, 6) + (finished ? 4 : 0);

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
            lines: m.lines(),
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
            max: m.total,
            width: rightWidth - 14,
            style: "block",
            color: failures.length > 0 ? ui.warn : ui.accent,
          }),
          // An explicit colour, not `dim`. dim leaves the foreground to
          // the terminal and asks it to darken whatever that was.
          Text(
            { color: muted },
            `${results.length}/${m.total}${etaText(results.length, m.total, elapsedMs, finished)}`,
          ),
          Text({}, ""),

          MultiProgressBar({
            segments: [
              { value: by("installed") + by("applied"), color: ui.ok },
              { value: by("present"), color: subtle },
              { value: by("failed"), color: ui.danger },
            ],
            total: m.total,
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

          ...(failures.length > 0
            ? [
                Text({ color: ui.danger, bold: true }, "Failed"),
                ...failures.slice(0, 6).map((f) => ListItem({ primary: f.tool, status: "error" })),
              ]
            : []),

          // Wrapped by hand to the column, not by hope: "Finished with
          // failures" rendered as "Finished with failu".
          ...(finished
            ? [
                Text({}, ""),
                Section(
                  failures.length > 0 ? "Incomplete" : "Converged",
                  ...(failures.length > 0
                    ? ["Fix the cause and re-run;", "it resumes from here."]
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
export async function runInstallTui(opts: InstallTuiOptions): Promise<{ failed: number }> {
  let outcome = { failed: 0 };
  const logScroll = createScrollArea({ height: 10, content: [], autoScroll: true });

  function App() {
    const { exit } = useApp();
    const size = useTerminalSize();
    const model = useInstallModel(opts, logScroll, (failed) => {
      outcome = { failed };
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
  const { waitUntilExit } = render(App, { fullHeight: true });
  await waitUntilExit();
  return outcome;
}
