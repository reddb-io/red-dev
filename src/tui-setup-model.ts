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
  useState,
} from "tuiuiu.js";
// createWizard lives under the hooks subpath rather than the root
// export; importing it from "tuiuiu.js" resolves to createId and fails
// with a suggestion that looks like a typo correction.
import { createWizard } from "tuiuiu.js/hooks";
import type { Platform } from "./platform.ts";
import { summary } from "./platform.ts";
import { Screen, Surface } from "./tui-chrome.ts";
import { muted, ui } from "./tui-theme.ts";
import { DEFAULT_THEME, swatches, THEMES, themeNames } from "./themes.ts";
import type { ThemeSlug } from "./themes.ts";
import { runtimeIdsForPolicy, runtimeSelectedByDefault } from "./runtimes.ts";

export interface SetupAnswers {
  theme: string;
  /** Fixed Red wallpaper, or undefined to follow the theme. */
  wallpaper?: ThemeSlug;
  font: string;
  apps: string[];
  runtimes: string[];
  agents: string[];
  blesh: boolean;
  /** Whether the wallpaper carries live machine state. On unless opted out. */
  redwall: boolean;
  terminalShell?: "wsl" | "gitbash";
  /** Whether to set up the one directory both environments read. */
  share: boolean;
  /** False when the user left before finishing. */
  completed: boolean;
}

export interface Choice {
  key: string;
  label: string;
  note: string;
}

/** One step: a question, its choices, and how many may be picked. */
export interface Question {
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

export function questions(
  p: Platform,
  agents: Choice[],
  apps: Choice[],
  runtimes: Choice[],
): Question[] {
  return [
    {
      // First, and before anything that writes a file.
      //
      // This was an afterthought — a separate command you ran once the
      // converge had already written every configuration into ~/.config,
      // leaving `share adopt` to move them one at a time. That makes the
      // shared root an accessory. It is meant to be the foundation, so
      // it is asked before there is anything to migrate.
      //
      // Gated exactly like Terminal below: bare-metal Ubuntu and servers
      // have no second environment, and sharing with a machine that is
      // not there is not a thing.
      id: "share",
      title: "Shared",
      description:
        "One directory both WSL and Windows read configuration from, so a setting " +
        "applied on one side is the same setting on the other. Binaries cannot be " +
        "shared — the formats differ — so it holds one directory each. Source code " +
        "should not be: a build costs eight times more across the boundary.",
      multi: false,
      choices: [
        {
          key: "yes",
          label: "Share configuration",
          note: "%USERPROFILE%\\.red\\dev — 43ms per shell, measured",
        },
        { key: "no", label: "Keep each side separate", note: "every config stays local" },
      ],
      preset: ["yes"],
      applies: (pl: Platform) => pl.env === "wsl" || pl.os === "windows",
    },
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
      preset: agents.map((agent) => agent.key),
      applies: () => true,
    },
    {
      id: "runtimes",
      title: "Runtimes",
      description:
        "Owned by mise, so node resolves the same way in WSL, on the desktop " +
        "and in Git Bash. A version manager that manages nothing is how pnpm " +
        "ends up working in one shell and not another. Java, Ruby and Go are " +
        "available but start off; select them when a project needs them.",
      multi: true,
      choices: runtimes,
      preset: runtimes.filter((runtime) => runtimeSelectedByDefault(runtime.key)).map((runtime) => runtime.key),
      applies: () => true,
    },
    {
      id: "runtime-versions",
      title: "Versions",
      description:
        "Recommended follows the compatibility channel chosen by red-dev — for " +
        "example Node LTS and Python 3.13. Latest asks mise for the newest release " +
        "of every runtime you selected.",
      multi: false,
      choices: [
        {
          key: "recommended",
          label: "Recommended versions",
          note: "the default — LTS, stable or a tested release where appropriate",
        },
        {
          key: "latest",
          label: "Latest versions",
          note: "rewrite every selected runtime to @latest",
        },
      ],
      preset: ["recommended"],
      applies: () => true,
    },
    {
      id: "apps",
      title: "Tools",
      description:
        "Everything on offer, all of it ticked. Untick what you do not want — " +
        "none of these is installed by a plain converge, so this list is the " +
        "only thing that decides.",
      multi: true,
      choices: apps,
      // The note still names exceptional costs (Blender says 1.2 GB),
      // but the selection contract is uniform: everything starts on and
      // the person removes what they do not want.
      preset: apps.map((app) => app.key),
      applies: () => apps.length > 0,
    },
    {
      // A category rather than one tool's yes/no.
      //
      // ble.sh was its own step, which put a single opt-in bash addon at
      // the same level as Theme and Runtimes and left nowhere to put the
      // next one. What it actually is is a plugin for the line editor,
      // and that is a group: everything red-dev bolts onto bash rather
      // than installs beside it belongs here.
      id: "plugins",
      title: "Plugins",
      description:
        "Things that attach to bash itself rather than sit next to it. The rest " +
        "of what red-dev installs — atuin, fzf, carapace, zoxide, starship — is " +
        "already wired in and needs no answer.",
      multi: true,
      choices: [
        {
          key: "blesh",
          label: "ble.sh",
          note: "autosuggestions and syntax highlighting — replaces the line editor",
        },
      ],
      preset: ["blesh"],
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
        "The wallpaper, the system accent and VS Code. Never the terminal — " +
        "its sixteen colours are yours, and red-dev sets only the cursor.",
      multi: false,
      choices: themeNames().map((n) => ({
        key: n,
        label: THEMES[n].name,
        note: THEMES[n].blurb,
      })),
      preset: [DEFAULT_THEME],
      applies: () => true,
    },
    {
      id: "wallpaper",
      title: "Wallpaper",
      description:
        "Follow the colour theme, or pin any Red wallpaper independently. " +
        "A pinned wallpaper stays put when the theme changes; Redwall draws " +
        "the machine state over whichever art you choose.",
      multi: false,
      choices: [
        { key: "theme", label: "Follow the theme", note: "the default" },
        ...themeNames().map((name) => ({
          key: name,
          label: THEMES[name].name,
          note: THEMES[name].blurb,
        })),
      ],
      preset: ["theme"],
      applies: (pl: Platform) => pl.env !== "server",
    },
    {
      // After Wallpaper, because it composes on that answer rather than
      // assuming the colour theme's art.
      id: "redwall",
      title: "Redwall",
      description:
        "The selected wallpaper with live machine state drawn over it: how many " +
        "Workers are running and the address this machine answers on, readable " +
        "from the lock screen without unlocking it. The art underneath is " +
        "unchanged — Redwall composes on top, never in place of it.",
      multi: false,
      choices: [
        // Accepting first, and that ordering is load-bearing. A
        // single-choice step commits whatever the cursor is on, and the
        // cursor starts at zero — so the answer someone gets for
        // pressing enter through the interview is the one at the top of
        // this list, not the one named in `preset`.
        { key: "yes", label: "Draw machine state on it", note: "the default — desktop and lock screen" },
        { key: "no", label: "Leave the wallpaper alone", note: "opt out" },
      ],
      preset: ["yes"],
      applies: () => true,
    },
  ].filter((q) => q.applies(p));
}



/**
 * The interview's state, separated from how it is drawn.
 *
 * Same split as the converge view, for the same reason and one more.
 * The reason: two `render()` calls in one process killed the console on
 * Windows. The one more: the interview only ever ran from `red-dev
 * install`, behind two gates — first run, and no scope argument — so
 * picking Install from the fullscreen menu converged the whole manifest
 * without asking anything. That is the path the one-liner takes, which
 * made "it never asks me" exactly right.
 */
export interface SetupModel {
  steps: Question[];
  stepIndex: () => number;
  cursor: () => number;
  selection: () => string[];
  pickedFor: (id: string) => string[];
  wizard: ReturnType<typeof createWizard>;
  /** Consumes a key. Returns "done" when the last answer is in. */
  handleKey: (input: string, key: SetupKey) => "done" | "quit" | "handled";
  answers: () => SetupAnswers;
}

interface SetupKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  escape?: boolean;
  return?: boolean;
}

export function useSetupModel(steps: Question[], wizard: ReturnType<typeof createWizard>): SetupModel {
  const [stepIndex, setStepIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<Record<string, string[]>>(
    Object.fromEntries(steps.map((s) => [s.id, [...s.preset]])),
  );

  const step = (): Question => steps[stepIndex()]!;
  const selection = (): string[] => picked()[step().id] ?? [];
  const get = (id: string): string[] => picked()[id] ?? [];

  return {
    steps,
    stepIndex,
    cursor,
    selection,
    pickedFor: get,
    wizard,
    answers: () => ({
      theme: get("theme")[0] ?? DEFAULT_THEME,
      ...(get("wallpaper")[0] && get("wallpaper")[0] !== "theme"
        ? { wallpaper: get("wallpaper")[0] as ThemeSlug }
        : {}),
      font: get("font")[0] ?? "firacode",
      apps: get("apps"),
      runtimes: runtimeIdsForPolicy(
        get("runtimes"),
        get("runtime-versions")[0] === "latest" ? "latest" : "recommended",
      ),
      agents: get("agents"),
      blesh: get("plugins").includes("blesh"),
      redwall: get("redwall")[0] === "yes",
      share: get("share")[0] === "yes",
      ...(get("shell")[0] ? { terminalShell: get("shell")[0] as "wsl" | "gitbash" } : {}),
      completed: true,
    }),
    handleKey: (input, key) => {
      const q = step();
      const max = q.choices.length - 1;

      if (key.upArrow || input === "k") {
        setCursor(Math.max(0, cursor() - 1));
        return "handled";
      }
      if (key.downArrow || input === "j") {
        setCursor(Math.min(max, cursor() + 1));
        return "handled";
      }
      if (input === " " && q.multi) {
        const k = q.choices[cursor()]!.key;
        const cur = selection();
        setPicked({
          ...picked(),
          [q.id]: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k],
        });
        return "handled";
      }
      if (key.return) {
        // Single-choice steps take whatever the cursor is on, so there is
        // no separate "select then confirm" for a one-of-N answer.
        if (!q.multi) setPicked({ ...picked(), [q.id]: [q.choices[cursor()]!.key] });
        wizard.markCompleted(stepIndex());
        if (stepIndex() >= steps.length - 1) return "done";
        setStepIndex(stepIndex() + 1);
        setCursor(0);
        wizard.next();
        return "handled";
      }
      if (key.leftArrow || key.escape) {
        if (stepIndex() > 0) {
          setStepIndex(stepIndex() - 1);
          setCursor(0);
          wizard.prev();
        }
        return "handled";
      }
      if (input === "q") return "quit";
      return "handled";
    },
  };
}

/** Build the questions and the wizard, both outside any component. */
export function setupSteps(
  p: Platform,
  agents: Choice[],
  apps: Choice[],
  runtimes: Choice[],
): { steps: Question[]; wizard: ReturnType<typeof createWizard> } {
  const steps = questions(p, agents, apps, runtimes);
  // createWizard creates signals; calling it during render rebuilds them
  // thirty times a second and puts a warning across the interface.
  const wizard = createWizard(
    steps.map((s) => ({ id: s.id, title: s.title, description: s.description })),
  );
  return { steps, wizard };
}

/**
 * The interview, drawn. A function of the model and nothing else.
 */
export function SetupLayout(m: SetupModel, p: Platform, width: number, height: number) {
  const q = m.steps[m.stepIndex()]!;
  const bodyRows = Math.max(10, height - 8);
  const twoColumn = width >= 86;
  // 26, not 22: at 22 the status dot pushed every title into an ellipsis
  // ("Termin…", "Runtim…"), which is worse than no timeline at all.
  const leftWidth = 26;
  const rightWidth = twoColumn ? width - leftWidth - 7 : width - 4;
  const isTheme = q.id === "theme";
  const activeKey = q.choices[m.cursor()]?.key ?? "";

  return Screen(
    width,
    height,

    Box(
      { flexDirection: "row", justifyContent: "space-between" },
      Text({ color: ui.accent, bold: true }, "red-dev setup"),
      Text({ color: muted }, summary(p).split("\n")[0] ?? ""),
    ),

    Box(
      { marginTop: 1, marginBottom: 1 },
      ProgressBar({
        value: m.stepIndex(),
        max: m.steps.length,
        width: Math.min(width - 12, 48),
        style: "block",
        color: ui.accent,
      }),
    ),

    Box(
      { flexDirection: twoColumn ? "row" : "column" },

      ...(twoColumn
        ? [
            Box(
              { flexDirection: "column", width: leftWidth },
              Text({ color: muted, bold: true }, "Steps"),
              ...m.steps.map((s, i) =>
                ListItem({
                  primary: s.title,
                  selected: i === m.stepIndex(),
                  status: m.wizard.isCompleted(i)
                    ? "success"
                    : i === m.stepIndex()
                      ? "running"
                      : "pending",
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
          ...q.choices.map((c, i) =>
            ListItem({
              primary: `${q.multi ? (m.selection().includes(c.key) ? "[x] " : "[ ] ") : ""}${c.label}`,
              secondary: c.note,
              selected: i === m.cursor(),
            }),
          ),
          // The reason this screen exists: the palette is visible while
          // the cursor moves, not after the choice is made.
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
          ...(q.multi ? [{ shortcut: "space", action: "toggle" }] : []),
          {
            shortcut: "enter",
            action: m.stepIndex() === m.steps.length - 1 ? "install" : "next",
          },
          ...(m.stepIndex() > 0 ? [{ shortcut: "left", action: "back" }] : []),
          { shortcut: "q", action: "skip" },
        ],
      }),
    ),
  );
}
