/**
 * First run, fullscreen.
 *
 * This is what was asked for and what I did not build the first time: I
 * put the fullscreen mode behind a separate `ui` command and left the
 * first run as seven blocking prompts, then argued the linear sequence
 * was better. It is not better for the one question where it matters —
 * you cannot see a palette in a prompt, so you pick a theme blind and
 * find out afterwards.
 *
 * The wizard state, the step timeline and the progress come from
 * tuiuiu's createWizard rather than from counters kept here.
 */

import {
  Box,
  HintBar,
  ListItem,
  ProgressBar,
  Text,
  render,
  useApp,
  useInput,
  useState,
  useTerminalSize,
} from "tuiuiu.js";
// createWizard lives under the hooks subpath rather than the root
// export; importing it from "tuiuiu.js" resolves to createId and fails
// with a suggestion that looks like a typo correction.
import { createWizard } from "tuiuiu.js/hooks";
import type { Platform } from "./platform.ts";
import { summary } from "./platform.ts";
import { CenteredScreen, centeredFrame, Surface } from "./tui-chrome.ts";
import { muted, ui } from "./tui-theme.ts";
import { swatches } from "./themes.ts";
import {
  runtimeVersionLabel,
  selectedRuntimeId,
  shiftRuntimeVersion,
  toggleRuntimeSelection,
} from "./runtimes.ts";
import { withConsoleSelectionSuspended } from "./windows-console-mode.ts";
// The questions live in tui-setup-model.ts and only there. They were
// declared in both files, identically, for two interfaces that ask the
// same interview — which is a copy that drifts the first time one of
// them is edited and nobody notices until an answer differs between the
// menu and the standalone first run.
import {
  choiceSelectable,
  questions,
  selectedSetupApps,
  stepHasChoices,
  stepInitialCursor,
  type Choice,
  type Question,
  type SetupAnswers,
  type SetupFacts,
} from "./tui-setup-model.ts";



export async function runSetupTui(
  p: Platform,
  agents: Choice[],
  apps: Choice[],
  runtimes: Choice[],
  redApps: Choice[] = [],
  wslTuning: Choice[] = [],
  facts: SetupFacts = {},
): Promise<SetupAnswers | null> {
  const steps = questions(p, agents, apps, runtimes, redApps, wslTuning, facts);
  let result: SetupAnswers | null = null;

  // Built here, outside the component, and deliberately so.
  //
  // createWizard creates signals. Calling it inside App() ran it on
  // every frame, which recreated that state thirty times a second and
  // made tuiuiu print a warning across the top of the screen — the
  // library telling me exactly what I had done wrong, in the middle of
  // the interface it was drawing.
  const wizard = createWizard(
    steps.map((s) => ({ id: s.id, title: s.title, description: s.description })),
  );

  function App() {
    const { exit } = useApp();
    const size = useTerminalSize();

    const [stepIndex, setStepIndex] = useState(0);
    const [cursor, setCursor] = useState(0);
    const [picked, setPicked] = useState<Record<string, string[]>>(
      Object.fromEntries(steps.map((s) => [s.id, [...s.preset]])),
    );

    const step = (): Question => steps[stepIndex()]!;
    const selection = (): string[] => picked()[step().id] ?? [];

    const commit = (): void => {
      wizard.markCompleted(stepIndex());
      if (stepIndex() >= steps.length - 1) {
        const get = (id: string): string[] => picked()[id] ?? [];
        result = {
          theme: get("theme")[0] ?? "tokyo-night",
          ...(get("wallpaper")[0] && get("wallpaper")[0] !== "theme"
            ? { wallpaper: get("wallpaper")[0] as string }
            : {}),
          font: get("font")[0] ?? "firacode",
          apps: selectedSetupApps(steps, get),
          runtimes: get("runtimes"),
          agents: get("agents"),
          redSkillsPlugins: get("redskills"),
          blesh: get("plugins").includes("blesh"),
          redwall: get("redwall")[0] === "yes",
          share: get("share")[0] === "yes",
          ...(get("shell")[0] ? { terminalShell: get("shell")[0] as "wsl" | "gitbash" } : {}),
          completed: true,
        };
        exit();
        return;
      }
      setStepIndex(stepIndex() + 1);
      setCursor(stepInitialCursor(steps[stepIndex() + 1]!));
      wizard.next();
    };

    useInput((input, key) => {
      const q = step();
      const max = q.choices.length - 1;

      if (key.upArrow || input === "k") {
        setCursor(Math.max(0, cursor() - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setCursor(Math.min(max, cursor() + 1));
        return;
      }

      if (q.id === "runtimes" && (key.leftArrow || key.rightArrow || input === "h" || input === "l")) {
        const choice = q.choices[cursor()];
        if (choice) {
          setPicked({
            ...picked(),
            [q.id]: shiftRuntimeVersion(
              selection(),
              choice.key,
              key.leftArrow || input === "h" ? -1 : 1,
            ),
          });
        }
        return;
      }

      if (input === " " && q.multi) {
        const choice = q.choices[cursor()];
        if (!choice || !choiceSelectable(q, choice)) return;
        const k = choice.key;
        const cur = selection();
        setPicked({
          ...picked(),
          [q.id]: q.id === "runtimes"
            ? toggleRuntimeSelection(cur, k)
            : cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k],
        });
        return;
      }

      if (key.return) {
        // Single-choice steps take whatever the cursor is on, so there
        // is no separate "select then confirm" for a one-of-N answer.
        if (!q.multi) {
          setPicked({ ...picked(), [q.id]: [q.choices[cursor()]!.key] });
        }
        commit();
        return;
      }

      if ((key.leftArrow && q.id !== "runtimes") || key.escape) {
        if (stepIndex() > 0) {
          setStepIndex(stepIndex() - 1);
          setCursor(stepInitialCursor(steps[stepIndex() - 1]!));
          wizard.prev();
        }
        return;
      }

      if (input === "q") {
        // Abandoning leaves result null, and the caller keeps its flag
        // defaults rather than half an answer set.
        result = null;
        exit();
      }
    });

    const q = step();
    const width = Math.max(size.columns ?? 90, 60);
    const height = Math.max(size.rows ?? 24, 16);
    const frame = centeredFrame(width, height, 110, 34);
    const bodyRows = Math.max(10, frame.height - 6);
    const twoColumn = frame.width >= 86;
    // 26, not 22: at 22 the status dot pushed every title into an ellipsis
    // ("Termin…", "Runtim…"), which is worse than no timeline at all.
    const leftWidth = 26;
    const rightWidth = twoColumn ? frame.width - leftWidth - 3 : frame.width;
    const isTheme = q.id === "theme";
    const isRuntimes = q.id === "runtimes";
    const isWslTuning = q.id === "wsl-tuning";
    const activeKey = q.choices[cursor()]?.key ?? "";

    return CenteredScreen(
      width,
      height,
      110,
      34,

      Box(
        { flexDirection: "row", justifyContent: "space-between" },
        Text({ color: ui.accent, bold: true }, "red-dev setup"),
        Text({ color: muted }, summary(p).split("\n")[0] ?? ""),
      ),

      Box(
        { marginTop: 1, marginBottom: 1 },
        ProgressBar({
          value: stepIndex(),
          max: steps.length,
          width: Math.min(frame.width - 8, 48),
          style: "block",
          color: ui.accent,
        }),
      ),

      Box(
        { flexDirection: twoColumn ? "row" : "column" },

        // The timeline: every step, and which are behind you.
        //
        // A bold label over the list rather than Panel's rounded border.
        // This screen was the last one still framing its regions, which
        // meant the first thing anyone saw of red-dev looked like a
        // different program from everything after it.
        ...(twoColumn
          ? [
              Box(
                { flexDirection: "column", width: leftWidth },
                Text({ color: muted, bold: true }, "Steps"),
                ...steps.map((s, i) =>
                  ListItem({
                    primary: s.title,
                    selected: i === stepIndex(),
                    status: wizard.isCompleted(i) ? "success" : i === stepIndex() ? "running" : "pending",
                  }),
                ),
              ),
            ]
          : []),

        Box(
          { ...(twoColumn ? { marginLeft: 1 } : {}) },
          Surface(
            rightWidth,
            bodyRows,
            Text({ color: ui.accent, bold: true }, q.title),
            Text({}, ""),
            Text({ color: muted }, q.description),
            Text({}, ""),
            ...(isWslTuning
              ? q.choices.map((c, i) =>
                  Text(
                    { ...(i === cursor() ? { color: ui.accent } : {}) },
                    `• ${c.label}: ${c.note}`,
                  )
                )
              : q.choices.map((c, i) => {
                  const runtimeId = selectedRuntimeId(selection(), c.key);
                  const checked = isRuntimes
                    ? selection().includes(runtimeId)
                    : selection().includes(c.key);
                  const selectable = choiceSelectable(q, c);
                  const showNote = !isRuntimes && (q.id !== "reddb" || selectable);
                  const inventoryMarker = c.marker === "elsewhere" ? "→ " : "• ";
                  return ListItem({
                    primary: isRuntimes
                      ? `${checked ? "[x]" : "[ ]"} ${c.label}  ‹ ${runtimeVersionLabel(runtimeId)} ›`
                      : `${q.multi ? (selectable ? (checked ? "[x] " : "[ ] ") : inventoryMarker) : ""}${c.label}`,
                    ...(showNote ? { secondary: c.note } : {}),
                    selected: i === cursor(),
                  });
                })),
            // The reason this screen exists: the palette is visible
            // while the cursor moves, not after the choice is made.
            ...(isTheme
              ? [
                  Text({}, ""),
                  Box(
                    { flexDirection: "row" },
                    ...swatches(activeKey).map((hex) => Text({ backgroundColor: hex }, "    ")),
                  ),
                ]
              : []),
          ),
        ),
      ),

      Box(
        { marginTop: 1 },
        HintBar({
          hints: [
            { shortcut: "up/down", action: "move" },
            ...(stepHasChoices(q) ? [{ shortcut: "space", action: "toggle" }] : []),
            ...(isRuntimes ? [{ shortcut: "left/right", action: "version" }] : []),
            { shortcut: "enter", action: stepIndex() === steps.length - 1 ? "finish" : "next" },
            ...(stepIndex() > 0 && !isRuntimes ? [{ shortcut: "left", action: "back" }] : []),
            ...(stepIndex() > 0 && isRuntimes ? [{ shortcut: "esc", action: "back" }] : []),
            { shortcut: "q", action: "skip setup" },
          ],
        }),
      ),
    );
  }

  // fullHeight defaults to false, which is why the first version left a
  // dead band below the panels: the layout was drawn at its content
  // height and the rest of the terminal kept whatever was there before.
  await withConsoleSelectionSuspended(async () => {
    const { waitUntilExit } = render(App, { fullHeight: true });
    await waitUntilExit();
  });
  return result;
}
