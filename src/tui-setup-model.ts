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
import {
  defaultAgentCandidates,
  defaultAgentFrom,
  needsDefaultAgentChoice,
} from "./default-agent.ts";
import { CenteredScreen, centeredFrame, Surface } from "./tui-chrome.ts";
import { muted, ui } from "./tui-theme.ts";
import { DEFAULT_THEME, swatches, THEMES, themeNames } from "./themes.ts";
import { redSkillsHostKeys } from "./agents.ts";
import { DEFAULT_ACTIVATED_PLUGINS, PLUGIN_CHOICES } from "./red-skills-plugins.ts";
import {
  runtimeSelectedByDefault,
  runtimeVersionLabel,
  selectedRuntimeId,
  shiftRuntimeVersion,
  toggleRuntimeSelection,
} from "./runtimes.ts";

export interface SetupAnswers {
  theme: string;
  /**
   * A pinned Red wallpaper slug, `current` to keep whatever the desktop
   * shows today, or undefined to follow the theme.
   *
   * `current` is an instruction, not a preference: it is resolved into
   * a managed `custom:<sha256>` import before anything is recorded —
   * see resolveSetupWallpaper in src/firstrun.ts.
   */
  wallpaper?: string;
  font: string;
  apps: string[];
  runtimes: string[];
  agents: string[];
  /**
   * The RedSkills plugins the agent hosts switch on — see
   * src/red-skills-plugins.ts. Absent when the interview never asked.
   */
  redSkillsPlugins?: string[];
  /** The one host red-dev hands work to. Absent when nothing was chosen. */
  defaultAgent?: string;
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
  /**
   * Ticked when the page is first drawn.
   *
   * Read only by the Agents page, and that is the point of it being
   * here: every other list red-dev offers is curated and arrives fully
   * ticked, but an agent host is an account, a vendor and a network
   * call, and plenty of machines are not allowed to have most of them.
   * A page that arrives with nine assistants ticked asks somebody to
   * untick eight, and the one they miss is the one their employer
   * refuses.
   */
  recommended?: boolean;
  /** False when a page is identifying an item owned by another scope. */
  selectable?: boolean;
  /** Inventory glyph used by the RedDB family page. */
  marker?: "included" | "elsewhere";
  /** This choice contributes an optional tool to SetupAnswers.apps. */
  answer?: "apps";
}

/** How a step reads the answers given so far. */
export type Picked = (id: string) => string[];

/** One step: a question, its choices, and how many may be picked. */
export interface Question {
  id: string;
  title: string;
  description: string;
  multi: boolean;
  choices: Choice[];
  /**
   * Choices that depend on an earlier answer, used instead of `choices`
   * when present — the Default agent is one of the hosts the Agents
   * step selected, and that list is not known when the steps are built.
   */
  choicesFrom?: (picked: Picked) => Choice[];
  /** Pre-selected keys. */
  preset: string[];
  /** Hidden when this returns false — the WSL steps on a Linux desktop. */
  applies: (p: Platform) => boolean;
  /**
   * Hidden when an earlier answer left nothing to decide, as distinct
   * from `applies`, which is settled before the interview starts. The
   * Default agent step disappears the moment the selection narrows to
   * one CLI host, because a question with one answer is not a question.
   */
  available?: (picked: Picked) => boolean;
}

/** The choices a step is offering right now. */
export function stepChoices(q: Question, picked: Picked): Choice[] {
  return q.choicesFrom ? q.choicesFrom(picked) : q.choices;
}

/** Whether a step has anything to ask, given the answers so far. */
export function stepAvailable(q: Question, picked: Picked): boolean {
  return q.available?.(picked) ?? true;
}

/** Whether Space can change this row. */
export function choiceSelectable(q: Question, choice: Choice): boolean {
  return q.multi && choice.selectable !== false;
}

/** Whether the page has at least one actual choice rather than inventory only. */
export function stepHasChoices(q: Question): boolean {
  return q.choices.some((choice) => choiceSelectable(q, choice));
}

/** Start a mixed inventory/choice page on the first row Space can change. */
export function stepInitialCursor(q: Question): number {
  const first = q.choices.findIndex((choice) => choiceSelectable(q, choice));
  return first < 0 ? 0 : first;
}

/** Optional tools selected across the generic Tools and RedDB pages. */
export function selectedSetupApps(steps: readonly Question[], picked: Picked): string[] {
  const redOptionalApps = steps
    .find((candidate) => candidate.id === "reddb")
    ?.choices.filter((choice) => choice.answer === "apps")
    .map((choice) => choice.key) ?? [];
  return [
    ...picked("apps"),
    ...picked("reddb").filter((key) => redOptionalApps.includes(key)),
  ];
}

const FONTS: Choice[] = [
  { key: "firacode", label: "FiraCode", note: "ligatures, the default" },
  { key: "jetbrainsmono", label: "JetBrains Mono", note: "taller x-height" },
  { key: "hack", label: "Hack", note: "no ligatures" },
  { key: "caskaydiacove", label: "Caskaydia Cove", note: "Microsoft's Cascadia" },
];

/** Facts about this machine the questions are phrased around. */
export interface SetupFacts {
  /**
   * The image the desktop shows right now, named for the person — or
   * null when there is none red-dev can keep: a server, a desktop it
   * could not read, or one already showing red-dev's own art.
   */
  currentWallpaper?: string | null;
}

/** The wallpaper answer that keeps the desktop's own image. */
export const KEEP_CURRENT_WALLPAPER = "current";

export function questions(
  p: Platform,
  agents: Choice[],
  apps: Choice[],
  runtimes: Choice[],
  redApps: Choice[] = [],
  wslTuning: Choice[] = [],
  facts: SetupFacts = {},
): Question[] {
  // Annotated rather than inferred: the return type does not reach
  // through `.filter` to type a step's callbacks, so `choicesFrom` and
  // `available` would arrive with implicit `any` parameters.
  const all: Question[] = [
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
      id: "wsl-tuning",
      title: "WSL tuning",
      description:
        "red-dev never stops a live distro. This is the safety policy applied " +
        "across Windows and WSL before builds, " +
        "tests and coding agents begin using the machine. These are safe defaults, " +
        "not optional tools; Enter accepts the inventory and continues.",
      multi: true,
      choices: wslTuning,
      preset: [],
      applies: (pl: Platform) => pl.env === "wsl" || pl.os === "windows",
    },
    {
      id: "agents",
      title: "Agents",
      description:
        "Picking any CLI agent also installs red-skills, which registers its " +
        "marketplace in Claude Code and Codex and generates plugin modules for RedCode. " +
        "Only the RedDB set arrives ticked: the rest are other vendors' assistants, " +
        "which plenty of managed machines are not allowed to run. Space adds one.",
      multi: true,
      choices: agents,
      // The one list on this screen that is opt-in rather than opt-out.
      // Everything else red-dev offers is a curated tool it would
      // install anyway; an assistant is somebody else's account and
      // somebody else's network, and a corporate laptop that quietly
      // installed four of them is a support ticket.
      preset: agents.filter((agent) => agent.recommended === true).map((agent) => agent.key),
      applies: () => true,
    },
    {
      // Immediately after the hosts, because it is a question about the
      // answer just given and about nothing else.
      //
      // Shown only when the selection left a real choice. Tick one CLI
      // host and this step is never drawn — that host is the Default
      // agent and there was nothing to ask. See src/default-agent.ts.
      id: "default-agent",
      title: "Default",
      description:
        "The one host red-dev hands work to: a crash to diagnose, a launch shortcut, " +
        "a profile's required host. red-dev never starts it with a permission bypass " +
        "— unattended is a decision you make when you type it, not one shipped as a " +
        "default. Change it later with `red-dev agents default <key>`.",
      multi: false,
      choices: [],
      // From the hosts on the previous screen rather than the catalog,
      // so a host reads the same on both — including whether it is
      // already installed.
      choicesFrom: (picked) => {
        const keys = defaultAgentCandidates(picked("agents")).map((agent) => agent.key);
        return agents.filter((agent) => keys.includes(agent.key));
      },
      preset: [],
      applies: () => true,
      available: (picked) => needsDefaultAgentChoice(picked("agents")),
    },
    {
      // Right after the hosts, because it is about what goes into them.
      //
      // The package set carries every plugin whatever is answered here,
      // so a plugin left off costs nothing and is a flag to switch on
      // later. What the answer decides is which of them the hosts
      // install — and a plugin that is not installed into a host runs
      // none of its hooks or MCP servers there, which is the reason
      // Memory and Brain start off: each of them acts on every session
      // of a host it is in, and that is not a thing to switch on because
      // it happened to be in the tarball.
      id: "redskills",
      title: "RedSkills",
      description:
        "Which RedSkills plugins the agent hosts switch on. The package set " +
        "carries all of them either way; a plugin left off is not installed " +
        "into any host, so none of its hooks or MCP servers run. Memory needs " +
        "dev and brings it along. Change it later with `red-dev agents plugins`.",
      multi: true,
      choices: PLUGIN_CHOICES.map((plugin) => ({
        key: plugin.key,
        label: plugin.label,
        note: plugin.note,
      })),
      preset: [...DEFAULT_ACTIVATED_PLUGINS],
      applies: () => true,
      // Hidden when nothing picked on the Agents page hosts skills: the
      // desktop applications take no plugin, so there is nothing to ask.
      available: (picked) => redSkillsHostKeys(picked("agents")).length > 0,
    },
    {
      id: "runtimes",
      title: "Runtimes",
      description:
        "Owned by mise, so node resolves the same way in WSL, on the desktop " +
        "and in Git Bash. A version manager that manages nothing is how pnpm " +
        "ends up working in one shell and not another. Space enables a language; " +
        "left/right chooses its version. Java, Ruby and Go start off.",
      multi: true,
      choices: runtimes,
      preset: runtimes.filter((runtime) => runtimeSelectedByDefault(runtime.key)).map((runtime) => runtime.key),
      applies: () => true,
    },
    {
      id: "reddb",
      title: "RedDB",
      description:
        "The RedDB family red-dev keeps together. A dot means the base converge " +
        "already includes it; an arrow points to a choice on another page, and " +
        "checkboxes are optional integrations you can untick.",
      multi: true,
      choices: redApps,
      preset: redApps.map((app) => app.key),
      applies: () => redApps.length > 0,
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
        "Follow the colour theme, keep the image the desktop shows today, or " +
        "pin any Red wallpaper independently. A kept or pinned wallpaper stays " +
        "put when the theme changes, and Redwall draws the machine state over " +
        "whichever art you choose rather than replacing it. Any other picture: " +
        "`red-dev wallpaper <path or https URL>`.",
      multi: false,
      choices: [
        { key: "theme", label: "Follow the theme", note: "the default" },
        // Offered only when there is something to keep. A desktop red-dev
        // could not read, or one already showing red-dev's own art, has
        // no "current" that differs from the answers below it.
        ...(facts.currentWallpaper
          ? [
              {
                key: KEEP_CURRENT_WALLPAPER,
                label: "Keep the current wallpaper",
                // "kept" rather than "imported": an image somebody else
                // put there is imported, and red-dev's own art is
                // pinned, and the row has to be true of both.
                note: `${facts.currentWallpaper} — kept as it is, and Redwall draws over it`,
              },
            ]
          : []),
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
  ];
  return all.filter((q) => q.applies(p));
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
  rightArrow?: boolean;
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
  const choices = (): Choice[] => stepChoices(step(), get);

  /**
   * The next step in a direction that still has something to ask, or
   * null when there is none.
   *
   * Takes the answers explicitly rather than reading the signal,
   * because the step being left may have just changed them — and
   * whether the following step applies can depend on exactly that.
   */
  const adjacent = (from: number, dir: 1 | -1, state: Record<string, string[]>): number | null => {
    const at = (id: string): string[] => state[id] ?? [];
    for (let i = from + dir; i >= 0 && i < steps.length; i += dir) {
      if (stepAvailable(steps[i]!, at)) return i;
    }
    return null;
  };

  return {
    steps,
    stepIndex,
    cursor,
    selection,
    pickedFor: get,
    wizard,
    answers: () => {
      // Resolved rather than read straight out of the step, because the
      // step may never have been drawn: one CLI host answers this
      // question by existing, and someone who narrowed the selection
      // after answering it leaves a key here that is no longer chosen.
      const defaultAgent = defaultAgentFrom(get("agents"), get("default-agent")[0]);
      return {
        theme: get("theme")[0] ?? DEFAULT_THEME,
        ...(get("wallpaper")[0] && get("wallpaper")[0] !== "theme"
          ? { wallpaper: get("wallpaper")[0] as string }
          : {}),
        font: get("font")[0] ?? "firacode",
        apps: selectedSetupApps(steps, get),
        runtimes: get("runtimes"),
        agents: get("agents"),
        redSkillsPlugins: get("redskills"),
        ...(defaultAgent ? { defaultAgent } : {}),
        blesh: get("plugins").includes("blesh"),
        redwall: get("redwall")[0] === "yes",
        share: get("share")[0] === "yes",
        ...(get("shell")[0] ? { terminalShell: get("shell")[0] as "wsl" | "gitbash" } : {}),
        completed: true,
      };
    },
    handleKey: (input, key) => {
      const q = step();
      const options = choices();
      const max = options.length - 1;

      if (key.upArrow || input === "k") {
        setCursor(Math.max(0, cursor() - 1));
        return "handled";
      }
      if (key.downArrow || input === "j") {
        setCursor(Math.min(max, cursor() + 1));
        return "handled";
      }
      if (q.id === "runtimes" && (key.leftArrow || key.rightArrow || input === "h" || input === "l")) {
        const choice = options[cursor()];
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
        return "handled";
      }
      if (input === " " && q.multi) {
        const choice = options[cursor()];
        if (!choice || !choiceSelectable(q, choice)) return "handled";
        const k = choice.key;
        const cur = selection();
        setPicked({
          ...picked(),
          [q.id]: q.id === "runtimes"
            ? toggleRuntimeSelection(cur, k)
            : cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k],
        });
        return "handled";
      }
      if (key.return) {
        const from = stepIndex();
        // Single-choice steps take whatever the cursor is on, so there is
        // no separate "select then confirm" for a one-of-N answer.
        const answered = q.multi || !options[cursor()]
          ? picked()
          : { ...picked(), [q.id]: [options[cursor()]!.key] };
        if (answered !== picked()) setPicked(answered);
        wizard.markCompleted(from);
        const next = adjacent(from, 1, answered);
        if (next === null) return "done";
        setStepIndex(next);
        setCursor(stepInitialCursor(steps[next]!));
        // Once per step crossed, so the wizard's own position keeps up
        // with a jump over a question that had nothing to ask.
        for (let i = from; i < next; i++) wizard.next();
        return "handled";
      }
      if ((key.leftArrow && q.id !== "runtimes") || key.escape) {
        const from = stepIndex();
        const back = adjacent(from, -1, picked());
        if (back !== null) {
          setStepIndex(back);
          setCursor(stepInitialCursor(steps[back]!));
          for (let i = back; i < from; i++) wizard.prev();
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
  redApps: Choice[] = [],
  wslTuning: Choice[] = [],
  facts: SetupFacts = {},
): { steps: Question[]; wizard: ReturnType<typeof createWizard> } {
  const steps = questions(p, agents, apps, runtimes, redApps, wslTuning, facts);
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
  const options = stepChoices(q, m.pickedFor);
  const activeKey = options[m.cursor()]?.key ?? "";
  // A step the answers have ruled out is not a step someone is going to
  // reach, so it does not belong in the timeline or in the count of how
  // much is left.
  const timeline = m.steps
    .map((s, i) => ({ step: s, index: i }))
    .filter(({ step }) => stepAvailable(step, m.pickedFor));
  const position = timeline.findIndex(({ index }) => index === m.stepIndex());

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
        value: Math.max(0, position),
        max: timeline.length,
        width: Math.min(frame.width - 8, 48),
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
              ...timeline.map(({ step, index }) =>
                ListItem({
                  primary: step.title,
                  selected: index === m.stepIndex(),
                  status: m.wizard.isCompleted(index)
                    ? "success"
                    : index === m.stepIndex()
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
          ...(isWslTuning
            ? options.map((c, i) =>
                Text(
                  { ...(i === m.cursor() ? { color: ui.accent } : {}) },
                  `• ${c.label}: ${c.note}`,
                )
              )
            : options.map((c, i) => {
                const runtimeId = selectedRuntimeId(m.selection(), c.key);
                const checked = isRuntimes
                  ? m.selection().includes(runtimeId)
                  : m.selection().includes(c.key);
                const selectable = choiceSelectable(q, c);
                const showNote = !isRuntimes && (q.id !== "reddb" || selectable);
                const inventoryMarker = c.marker === "elsewhere" ? "→ " : "• ";
                return ListItem({
                  primary: isRuntimes
                    ? `${checked ? "[x]" : "[ ]"} ${c.label}  ‹ ${runtimeVersionLabel(runtimeId)} ›`
                    : `${q.multi ? (selectable ? (checked ? "[x] " : "[ ] ") : inventoryMarker) : ""}${c.label}`,
                  ...(showNote ? { secondary: c.note } : {}),
                  selected: i === m.cursor(),
                });
              })),
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
          ...(stepHasChoices(q) ? [{ shortcut: "space", action: "toggle" }] : []),
          ...(isRuntimes ? [{ shortcut: "left/right", action: "version" }] : []),
          {
            shortcut: "enter",
            action: position === timeline.length - 1 ? "install" : "next",
          },
          ...(m.stepIndex() > 0 && !isRuntimes ? [{ shortcut: "left", action: "back" }] : []),
          ...(m.stepIndex() > 0 && isRuntimes ? [{ shortcut: "esc", action: "back" }] : []),
          { shortcut: "q", action: "skip" },
        ],
      }),
    ),
  );
}
