/**
 * The fullscreen interface.
 *
 * The blocking prompts in ui.ts are the right tool for a wizard: ask,
 * get an answer, move on. They cannot do one thing this needs, though —
 * there is no hook for "the highlighted item changed", so a theme
 * cannot be previewed while you scroll past it. You would have to apply
 * a theme to find out what it looks like.
 *
 * So this is the reactive half of tuiuiu rather than the prompt half: a
 * render loop, signals, and a layout with a panel that reacts to the
 * selection. The prompts stay for `install`'s first run, where a linear
 * sequence of questions is exactly right and a fullscreen takeover
 * would be worse.
 *
 * Both halves are optional. Without a TTY neither runs, and every
 * command reachable here is reachable as a plain argument.
 */

import {
  BigText,
  Box,
  ListItem,
  Text,
  render,
  useApp,
  useInput,
  useState,
  useTerminalSize,
} from "tuiuiu.js";
import { createScrollArea } from "tuiuiu.js";
import { VERSION } from "./cli.ts";
import type { SetupProgressObserver } from "./firstrun.ts";
import { captureTo } from "./log.ts";
import type { Platform } from "./platform.ts";
import { summary } from "./platform.ts";
import { swatches, THEMES, themeNames } from "./themes.ts";
import { Header, Screen, StatusLine, Surface, Task } from "./tui-chrome.ts";
import { InstallLayout, useInstallModel, type InstallTuiOptions } from "./tui-install.ts";
import {
  SetupLayout,
  useSetupModel,
  type SetupAnswers,
  type SetupModel,
} from "./tui-setup-model.ts";
import { muted, text, wordmarkGradient } from "./tui-theme.ts";
import { withConsoleSelectionSuspended } from "./windows-console-mode.ts";

/**
 * A row of blocks in the palette's own colours.
 *
 * This is the whole reason for a fullscreen mode: seeing the colours
 * before committing to them. Background rather than foreground, because
 * a solid block reads as a swatch and a coloured glyph reads as text.
 */
function Swatches(hexes: string[]) {
  return Box(
    { flexDirection: "row" },
    ...hexes.map((hex) => Text({ backgroundColor: hex }, "    ")),
  );
}

interface MenuSection {
  key: string;
  label: string;
  /** Shown in the right-hand panel while this section is highlighted. */
  notes: string[];
}

const SECTIONS: MenuSection[] = [
  {
    // First, and it is not filler. The right panel was empty until a
    // section was highlighted, which meant the landing screen of the
    // whole interface was a list beside dead space. This is what that
    // space is for: what this machine is, and what red-dev thinks of it.
    key: "home",
    label: "Home",
    notes: [],
  },
  {
    key: "theme",
    label: "Theme",
    notes: [
      "The wallpaper, the Windows accent,",
      "GNOME and VS Code. Not the terminal:",
      "its colours are yours, and red-dev",
      "sets only the cursor.",
    ],
  },
  {
    key: "install",
    label: "Install",
    notes: [
      "Converge toward the manifest.",
      "Every provider is idempotent, so",
      "re-running after a failure is the",
      "normal recovery path rather than",
      "an edge case.",
    ],
  },
  {
    key: "doctor",
    label: "Doctor",
    notes: [
      "Presence on PATH is the easy half.",
      "This also compares deployed dotfiles",
      "byte-for-byte against the ones inside",
      "this binary, and asks Windows whether",
      "it can actually see the font.",
    ],
  },
  {
    key: "apps",
    label: "Apps",
    notes: [
      "Optional tools, never installed by a",
      "plain converge. Chosen, not assumed.",
    ],
  },
];


export interface TuiResult {
  /** Command the user chose to run after leaving the interface. */
  action: string | null;
  /** Theme they settled on, when they chose one. */
  theme?: string;
  /** Failures, when the converge ran inside the interface. */
  failed?: number;
  /**
   * Items that ran out of rights, counted apart from the failures.
   *
   * Carried separately all the way out because the caller turns it into
   * an exit status, and the whole point of the outcome is that these two
   * numbers are not the same news.
   */
  deferred?: number;
}


/**
 * What a menu entry does when you press Enter.
 *
 * Handed in rather than imported so this file keeps knowing nothing
 * about theming, doctoring or apps — and so every one of them runs
 * *inside* the render instead of after it. The log lines they emit are
 * captured and drawn here; without that they would paint over the frame
 * the renderer owns.
 */
export interface TuiActions {
  applyTheme?: (slug: string) => Promise<unknown>;
  doctor?: () => Promise<unknown>;
  apps?: () => Promise<unknown>;
  /**
   * The interview, and what to do with its answers.
   *
   * Install used to converge the whole manifest the moment it was
   * picked. The questions existed — theme, font, agents, runtimes,
   * tools — and lived only inside `red-dev install`, behind two gates:
   * first run, and no scope argument. The fullscreen menu is the path
   * the one-liner takes, so in practice nothing was ever asked.
   */
  setup?: {
    steps: SetupModel["steps"];
    wizard: SetupModel["wizard"];
    apply: (answers: SetupAnswers, observer?: SetupProgressObserver) => Promise<unknown>;
  };
}

export async function runTui(
  p: Platform,
  install?: InstallTuiOptions,
  actions: TuiActions = {},
): Promise<TuiResult> {
  let result: TuiResult = { action: null };
  // Built out here, once: createScrollArea makes signals, and the model
  // that uses it has to be created inside the component.
  const logScroll = createScrollArea({ height: 10, content: [], autoScroll: true });

  function App() {
    // exit() from useApp, never process.exit: the latter kills the
    // process before waitUntilExit resolves, so runTui would never
    // return and the chosen action would be lost.
    const { exit } = useApp();
    const size = useTerminalSize();
    // "sections" browses the left column; "themes" browses the palette
    // list, with the panel previewing whatever is highlighted.
    const [mode, setMode] = useState<"sections" | "themes" | "setup" | "install" | "task">(
      "sections",
    );
    const [sectionIndex, setSectionIndex] = useState(0);
    const [themeIndex, setThemeIndex] = useState(0);
    const [taskTitle, setTaskTitle] = useState("");
    const [taskLines, setTaskLines] = useState<string[]>([]);
    const [taskDone, setTaskDone] = useState(false);

    const names = themeNames();

    /**
     * Run one command without leaving the screen.
     *
     * captureTo is what makes this possible: the command writes through
     * `log`, which would otherwise go straight to the console and tear a
     * hole in the frame. Redirected into a signal instead, it becomes
     * content this can draw.
     */
    const runTask = (title: string, fn: () => Promise<unknown>): void => {
      setTaskTitle(title);
      setTaskLines([]);
      setTaskDone(false);
      setMode("task");
      const release = captureTo((line) =>
        setTaskLines((prev) => [...prev, line.replace(/\x1b\[[0-9;]*m/g, "")]),
      );
      void fn()
        .catch((err: unknown) =>
          setTaskLines((prev) => [...prev, `failed: ${(err as Error).message}`]),
        )
        .finally(() => {
          release();
          setTaskDone(true);
        });
    };

    // Called on every frame regardless of which view is showing.
    //
    // This is the whole fix for the crash. Picking Install used to leave
    // this render entirely and start a second one, and on Windows the
    // second app's initialisation failed and its cleanup wrote to a
    // stdout that was already gone — EPIPE, process dead, console closed
    // with it. One render, two views.
    //
    // Unconditional because a hook behind an `if` changes the hook order
    // between frames; the converge does not begin until begin() is
    // called, which is what the Enter key does.
    const model = install
      ? useInstallModel(install, logScroll, ({ failed, deferred }) => {
          result = { action: "installed", failed, deferred };
        })
      : null;

    // Unconditional, like the converge model and for the same reason: a
    // hook behind an `if` changes the hook order between frames.
    const setup = actions.setup
      ? useSetupModel(actions.setup.steps, actions.setup.wizard)
      : null;

    useInput((input, key) => {
      if (mode() === "task") {
        // Back to the menu rather than out of the program. The whole
        // point of running it in here is that finishing a command
        // returns you to where you chose it.
        if (taskDone() && (key.return || key.escape || input === "q")) setMode("sections");
        return;
      }

      if (mode() === "setup" && setup && actions.setup) {
        const verdict = setup.handleKey(input, key);
        if (verdict === "quit") {
          // Backing out of the interview goes back to the menu, not into
          // a converge nobody asked for.
          setMode("sections");
        } else if (verdict === "done") {
          const answers = setup.answers();
          setMode("install");
          // Captured, like every other command that runs in here.
          //
          // Recording the shared root speaks through `log`, and without
          // this it wrote to the console mid-render: "ok shared root
          // is…" and "change it with: red-dev share…" printed over the
          // status line while a second, stale copy of the progress
          // column stayed on screen beside the live one. The frame is
          // the renderer's; anything writing to it has to go through a
          // signal.
          const release = captureTo((line) => model?.note(line));
          // Name the phase and start the clock: apply() installs agents
          // and runtimes, which can take minutes, and a screen showing
          // 0/46 and 0s through all of it reads as broken.
          model?.prelude("agents & runtimes");
          void actions.setup
            .apply(answers, {
              begin: (steps) => model?.setupBegin(steps),
              stepStart: (step) => model?.setupStepStart(step),
              stepEnd: (step) => model?.setupStepEnd(step),
            })
            .catch((err: unknown) => model?.note(`failed: ${(err as Error).message}`))
            .finally(() => {
              release();
              model?.begin();
            });
        }
        return;
      }

      if (mode() === "install" && model) {
        if (model.handleKey(input, key)) return;
        // Refused until it finishes: leaving halfway abandons the machine
        // mid-converge with no report of where it stopped.
        if (model.finished() && (key.return || input === "q" || key.escape)) exit();
        return;
      }

      const inThemes = mode() === "themes";
      const max = inThemes ? names.length - 1 : SECTIONS.length - 1;
      const index = inThemes ? themeIndex : sectionIndex;
      const setIndex = inThemes ? setThemeIndex : setSectionIndex;

      if (key.upArrow || input === "k") setIndex(Math.max(0, index() - 1));
      else if (key.downArrow || input === "j") setIndex(Math.min(max, index() + 1));
      else if (key.escape) {
        if (inThemes) setMode("sections");
        else result = { action: null };
      } else if (key.return) {
        if (inThemes) {
          const slug = names[themeIndex()]!;
          if (actions.applyTheme) {
            // Applied in place. This used to exit the interface and
            // print its six lines to the console you had just been
            // taken out of, which reads as the program quitting rather
            // than as a theme being applied.
            runTask(`theme: ${THEMES[slug]?.name ?? slug}`, () => actions.applyTheme!(slug));
          } else {
            result = { action: "theme", theme: slug };
            exit();
          }
          return;
        }
        const section = SECTIONS[sectionIndex()];
        if (section?.key === "theme") setMode("themes");
        else if (section?.key === "install" && model) {
          // The interview first, every time — not once on a first run.
          // Choosing Install is how you say what you want installed, and
          // answering is the point of choosing it. Previous answers come
          // back as the presets, so agreeing again is enter, enter,
          // enter.
          if (setup) setMode("setup");
          else {
            setMode("install");
            model.begin();
          }
        } else if (section?.key === "doctor" && actions.doctor) {
          runTask("doctor", actions.doctor);
        } else if (section?.key === "apps" && actions.apps) {
          runTask("apps", actions.apps);
        } else {
          result = { action: section?.key ?? null };
          exit();
        }
      } else if (input === "q") {
        result = { action: null };
        exit();
      }
    });

    const width = Math.max(size.columns ?? 80, 60);
    const height = Math.max(size.rows ?? 24, 16);

    if (mode() === "setup" && setup) return SetupLayout(setup, p, width, height);

    // The converge takes the whole screen once it starts.
    if (mode() === "install" && model) return InstallLayout(model, width, height);

    if (mode() === "task") {
      return Screen(
        width,
        height,
        Header("red-dev", taskDone() ? "done" : "working"),
        Text({}, ""),
        Task(taskTitle(), taskLines(), Math.max(6, height - 8), width - 4, taskDone()),
        StatusLine(
          taskDone() ? "enter back to the menu" : "working…",
          `red-dev ${VERSION}`,
        ),
      );
    }

    const inThemes = mode() === "themes";
    const activeTheme = names[themeIndex()] ?? names[0]!;
    const section = SECTIONS[sectionIndex()];

    // Two columns, sized from the real terminal rather than assumed:
    // an 80-column window and a 200-column one should both look
    // deliberate.
    const leftWidth = Math.max(22, Math.floor(width * 0.32));
    const rightWidth = width - leftWidth - 5;
    const bodyRows = Math.max(8, height - 6);

    return Screen(
      width,
      height,

      Header("red-dev", inThemes ? "theme" : (section?.label.toLowerCase() ?? "")),
      Text({}, ""),

      Box(
        { flexDirection: "row" },

        // Left: the list being browsed. ListItem owns the selected
        // state and its marker; hand-drawing "❯ " and a colour was
        // reimplementing a component that already exists.
        Box(
          { flexDirection: "column", width: leftWidth },
          Text({ color: muted, bold: true }, inThemes ? "Themes" : "Sections"),
          ...(inThemes
            ? names.map((name, i) => ListItem({ primary: name, selected: i === themeIndex() }))
            : SECTIONS.map((s, i) =>
                ListItem({ primary: s.label, selected: i === sectionIndex() }),
              )),
        ),

        // Right: the landing panel, notes, or the live palette preview,
        // on its own shade so the browsing column and the reading column
        // are told apart by surface rather than by a border.
        Box(
          { marginLeft: 2 },
          Surface(
          rightWidth,
          bodyRows,
          ...(!inThemes && section?.key === "home"
            ? [
                // Centred, and the logo fades rather than sitting flat.
                //
                // Both taken from tuiuiu's own opencode-lab example:
                // justifyContent and alignItems on a box with an
                // explicit height do the centring, and a gradient from
                // dim to bright is what gives the wordmark depth. A
                // single colour reads as ASCII art; the ramp reads as a
                // logo.
                Box(
                  {
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    height: Math.max(8, (size.rows ?? 24) - 8),
                  },
                  BigText({
                    text: "red-dev",
                    font: "small",
                    // Symmetric on purpose: BigText cycles the ramp per
                    // letter, and seven letters over five stops
                    // restarted at the darkest shade mid-word.
                    // Mirroring it makes the wrap invisible.
                    gradient: [...wordmarkGradient],
                    letterSpacing: 1,
                  }),
                  Text({}, ""),
                  Text({ color: muted }, summary(p).split("\n")[0] ?? ""),
                  Text({ color: muted }, summary(p).split("\n")[1] ?? ""),
                  Text({}, ""),
                  Text({ color: muted }, "Pick a section on the left."),
                ),
              ]
            : inThemes
            ? [
                Text({ color: text, bold: true }, THEMES[activeTheme]?.name ?? activeTheme),
                Text({}, ""),
                Swatches(swatches(activeTheme)),
                Text({}, ""),
                Text({ color: muted }, "background · red · green · yellow"),
                Text({ color: muted }, "blue · magenta · cyan · foreground"),
                Text({}, ""),
                Text({ color: muted }, "Neovim colorscheme:"),
                Text({ color: text }, `  ${THEMES[activeTheme]?.blurb ?? "—"}`),
              ]
            : [
                Text({ color: text, bold: true }, section?.label ?? ""),
                Text({}, ""),
                ...(section?.notes ?? []).map((n) => Text({ color: muted }, n)),
              ]),
          ),
        ),
      ),

      // The bottom edge: hints on the left, version on the right, the
      // same shape every screen here uses.
      StatusLine(
        inThemes
          ? "up/down preview · enter apply · esc back · q quit"
          : "up/down move · enter open · q quit",
        `red-dev ${VERSION}`,
      ),
    );
  }

  await withConsoleSelectionSuspended(async () => {
    const { waitUntilExit } = render(App, { fullHeight: true });
    await waitUntilExit();
  });
  return result;
}
