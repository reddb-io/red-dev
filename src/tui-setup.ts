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
  Panel,
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
import { THEMES, themeNames } from "./themes.ts";

export interface SetupAnswers {
  theme: string;
  font: string;
  apps: string[];
  runtimes: string[];
  agents: string[];
  blesh: boolean;
  terminalShell?: "wsl" | "gitbash";
  /** False when the user left before finishing. */
  completed: boolean;
}

interface Choice {
  key: string;
  label: string;
  note: string;
}

/** One step: a question, its choices, and how many may be picked. */
interface Question {
  id: string;
  title: string;
  description: string;
  multi: boolean;
  choices: Choice[];
  /** Pre-selected keys. */
  preset: string[];
  /** Hidden when this returns false — the WSL steps on a Linux desktop. */
  applies: (p: Platform) => boolean;
}

const FONTS: Choice[] = [
  { key: "firacode", label: "FiraCode", note: "ligatures, the default" },
  { key: "jetbrainsmono", label: "JetBrains Mono", note: "taller x-height" },
  { key: "hack", label: "Hack", note: "no ligatures" },
  { key: "caskaydiacove", label: "Caskaydia Cove", note: "Microsoft's Cascadia" },
];

function questions(p: Platform, agents: Choice[], apps: Choice[], runtimes: Choice[]): Question[] {
  return [
    {
      id: "shell",
      title: "Terminal",
      description:
        "Alacritty has no profiles, so it opens exactly one shell. " +
        "This is a recorded choice, not a side effect of where the last converge ran.",
      multi: false,
      choices: [
        { key: "wsl", label: "WSL", note: "your distro, in its own filesystem" },
        { key: "gitbash", label: "Git Bash", note: "stay on Windows, same dotfiles" },
      ],
      preset: ["wsl"],
      applies: (pl: Platform) => pl.env === "wsl" || pl.os === "windows",
    },
    {
      id: "agents",
      title: "Agents",
      description:
        "Picking any CLI agent also installs red-skills, which registers its " +
        "marketplace in Claude Code and Codex and generates plugin modules for OpenCode.",
      multi: true,
      choices: agents,
      preset: agents.filter((a) => a.key.match(/^(claude-code|codex|opencode)$/)).map((a) => a.key),
      applies: () => true,
    },
    {
      id: "runtimes",
      title: "Runtimes",
      description:
        "Owned by mise, so node resolves the same way in WSL, on the desktop " +
        "and in Git Bash. A version manager that manages nothing is how pnpm " +
        "ends up working in one shell and not another.",
      multi: true,
      choices: runtimes,
      preset: runtimes.slice(0, 1).map((r) => r.key),
      applies: () => true,
    },
    {
      id: "apps",
      title: "Tools",
      description: "Never installed by a plain converge. Empty is a good answer.",
      multi: true,
      choices: apps,
      preset: [],
      applies: () => apps.length > 0,
    },
    {
      id: "blesh",
      title: "ble.sh",
      description:
        "Autosuggestions and syntax highlighting for bash. It replaces the line " +
        "editor that atuin, fzf and carapace bind into, so whether they survive " +
        "is worth checking before you rely on it.",
      multi: false,
      choices: [
        { key: "no", label: "Leave it off", note: "installed, not enabled" },
        { key: "yes", label: "Enable it", note: "confirm Ctrl-R still reaches atuin" },
      ],
      preset: ["no"],
      applies: () => true,
    },
    {
      id: "font",
      title: "Font",
      description: "A Nerd Font, because the prompt and eza's icons need the glyphs.",
      multi: false,
      choices: FONTS,
      preset: ["firacode"],
      applies: () => true,
    },
    {
      id: "theme",
      title: "Theme",
      description:
        "One palette reaches the terminal, zellij, btop, Neovim, VS Code, GNOME " +
        "and the wallpaper — which is generated from these colours, not shipped " +
        "as an image.",
      multi: false,
      choices: themeNames().map((n) => ({
        key: n,
        label: THEMES[n]?.name ?? n,
        note: `neovim: ${THEMES[n]?.neovim ?? "—"}`,
      })),
      preset: ["tokyo-night"],
      applies: () => true,
    },
  ].filter((q) => q.applies(p));
}

/** The palette, in the order that reads best as a strip. */
function paletteOf(slug: string): string[] {
  const t = THEMES[slug];
  if (!t) return [];
  const c = t.terminal;
  return [c.background, c.red, c.green, c.yellow, c.blue, c.purple, c.cyan, c.foreground];
}

export async function runSetupTui(
  p: Platform,
  agents: Choice[],
  apps: Choice[],
  runtimes: Choice[],
): Promise<SetupAnswers | null> {
  const steps = questions(p, agents, apps, runtimes);
  let result: SetupAnswers | null = null;

  function App() {
    const { exit } = useApp();
    const size = useTerminalSize();

    // createWizard owns which step we are on, how far through we are and
    // which ones are done — all of which this would otherwise keep in
    // three separate signals that can disagree.
    // useState(fn) stores the function itself here rather than calling
    // it, so the wizard has to be built once outside the signal and
    // read directly — wrapping it produced `() => any` and every method
    // came back undefined.
    const [wizardRef] = useState(
      createWizard(steps.map((s) => ({ id: s.id, title: s.title, description: s.description }))),
    );
    const wizard = wizardRef();

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
          font: get("font")[0] ?? "firacode",
          apps: get("apps"),
          runtimes: get("runtimes"),
          agents: get("agents"),
          blesh: get("blesh")[0] === "yes",
          ...(get("shell")[0] ? { terminalShell: get("shell")[0] as "wsl" | "gitbash" } : {}),
          completed: true,
        };
        exit();
        return;
      }
      setStepIndex(stepIndex() + 1);
      setCursor(0);
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

      if (input === " " && q.multi) {
        const k = q.choices[cursor()]!.key;
        const cur = selection();
        setPicked({
          ...picked(),
          [q.id]: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k],
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

      if (key.leftArrow || key.escape) {
        if (stepIndex() > 0) {
          setStepIndex(stepIndex() - 1);
          setCursor(0);
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
    const twoColumn = width >= 86;
    // 26, not 22: at 22 the status dot pushed every title into an ellipsis
    // ("Termin…", "Runtim…"), which is worse than no timeline at all.
    const leftWidth = 26;
    const rightWidth = twoColumn ? width - leftWidth - 7 : width - 4;
    const isTheme = q.id === "theme";
    const activeKey = q.choices[cursor()]?.key ?? "";

    return Box(
      { flexDirection: "column", padding: 1 },

      Box(
        { flexDirection: "row", justifyContent: "space-between" },
        Text({ color: "red", bold: true }, "red-dev setup"),
        Text({ dim: true }, summary(p).split("\n")[0] ?? ""),
      ),

      Box(
        { marginTop: 1, marginBottom: 1 },
        ProgressBar({
          value: stepIndex(),
          max: steps.length,
          width: Math.min(width - 12, 48),
          style: "block",
          color: "red",
        }),
      ),

      Box(
        { flexDirection: twoColumn ? "row" : "column" },

        // The timeline: every step, and which are behind you.
        ...(twoColumn
          ? [
              Box(
                { width: leftWidth },
                Panel(
                  { title: "steps" },
                  ...steps.map((s, i) =>
                    ListItem({
                      primary: s.title,
                      selected: i === stepIndex(),
                      status: wizard.isCompleted(i) ? "success" : i === stepIndex() ? "running" : "pending",
                    }),
                  ),
                ),
              ),
            ]
          : []),

        Box(
          { width: rightWidth, ...(twoColumn ? { marginLeft: 1 } : {}) },
          Panel(
            { title: q.title.toLowerCase() },
            Text({ dim: true }, q.description),
            Text({}, ""),
            ...q.choices.map((c, i) =>
              ListItem({
                primary: `${q.multi ? (selection().includes(c.key) ? "[x] " : "[ ] ") : ""}${c.label}`,
                secondary: c.note,
                selected: i === cursor(),
              }),
            ),
            // The reason this screen exists: the palette is visible
            // while the cursor moves, not after the choice is made.
            ...(isTheme
              ? [
                  Text({}, ""),
                  Box(
                    { flexDirection: "row" },
                    ...paletteOf(activeKey).map((hex) => Text({ backgroundColor: hex }, "    ")),
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
            ...(q.multi ? [{ shortcut: "space", action: "toggle" }] : []),
            { shortcut: "enter", action: stepIndex() === steps.length - 1 ? "finish" : "next" },
            ...(stepIndex() > 0 ? [{ shortcut: "left", action: "back" }] : []),
            { shortcut: "q", action: "skip setup" },
          ],
        }),
      ),
    );
  }

  const { waitUntilExit } = render(App);
  await waitUntilExit();
  return result;
}
