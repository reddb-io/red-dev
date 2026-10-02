import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { render, renderToString, useInput } from "tuiuiu.js";
import type { Platform } from "./platform.ts";
import { runSetupPrompts } from "./firstrun.ts";
import {
  SetupLayout, setupSteps, useSetupModel,
  type Choice, type SetupAnswers, type SetupModel,
} from "./tui-setup-model.ts";

const desktop: Platform = {
  os: "linux", env: "desktop", distro: "ubuntu", version: "24.04",
  codename: "noble", arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};
const hosts: Choice[] = [
  { key: "claude-code", label: "Claude Code", note: "Anthropic", recommended: true },
  { key: "codex", label: "Codex", note: "OpenAI", recommended: true },
];

function interview(agents = ["claude-code", "codex"]) {
  return setupSteps(desktop, hosts, [], [{ key: "node@latest", label: "Node", note: "" }], [], [], {
    githubUser: "octocat",
    preferences: {
      setupCompleted: true, agents, defaultAgent: "codex", runtimes: [],
      redSkillsPlugins: [], font: "hack", theme: "cobalt", blesh: false,
      redwall: false, wallpaper: "custom:abc123",
    },
  });
}

function terminal() {
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream;
  Object.assign(stdin, { isTTY: true, isRaw: false, setRawMode: () => stdin });
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 30 });
  return { stdin, stdout };
}

function renderedWizard(agents?: string[]) {
  const { steps, wizard } = interview(agents);
  const { stdin, stdout } = terminal();
  let model!: SetupModel;
  let answers: SetupAnswers | undefined;
  let verdict = "handled";
  const app = render(() => {
    model = useSetupModel(steps, wizard);
    useInput((input, key) => {
      verdict = model.handleKey(input, key);
      if (verdict === "done") answers = model.answers();
    });
    return SetupLayout(model, desktop, 100, 30);
  }, { stdin, stdout, fullHeight: true });
  return {
    app, model: () => model, answers: () => answers, verdict: () => verdict,
    press: async (bytes: string) => { stdin.write(bytes); await Bun.sleep(30); },
  };
}

describe("the shared setup through the real renderer", () => {
  test("SSH typing and Enter complete without an empty-choice crash or lost answers", async () => {
    const view = renderedWizard();
    try {
      await view.press("\r"); // hosts
      expect(view.model().steps[view.model().stepIndex()]!.id).toBe("default-agent");
      expect(view.model().cursor()).toBe(1); // recorded Codex
      await view.press("\r");
      await view.press("\r"); // RedSkills
      expect(view.model().steps[view.model().stepIndex()]!.id).toBe("ssh");
      await view.press("\x7f");
      await view.press("q"); // username input, not the quit shortcut
      expect(view.verdict()).toBe("handled");
      expect(view.model().selection()).toEqual(["octocaq"]);
      for (let count = 0; count < 20 && !view.answers(); count++) await view.press("\r");
      expect(view.answers()).toMatchObject({
        completed: true, defaultAgent: "codex", sshGithubUser: "octocaq",
        agents: ["claude-code", "codex"], runtimes: [], redSkillsPlugins: [],
        theme: "cobalt", font: "hack", blesh: false, redwall: false,
        wallpaper: "custom:abc123",
      });
    } finally { view.app.unmount(); }
  });

  test("an empty host selection skips dependent pages and can return or cancel", async () => {
    const view = renderedWizard([]);
    try {
      expect(view.model().selection()).toEqual([]);
      await view.press("\r");
      expect(view.model().steps[view.model().stepIndex()]!.id).toBe("ssh");
      await view.press("\x1b[B");
      expect(view.model().cursor()).toBe(0);
      await view.press("\x1b");
      expect(view.model().steps[view.model().stepIndex()]!.id).toBe("agents");
      await view.press("q");
      expect(view.verdict()).toBe("quit");
      expect(view.answers()).toBeUndefined();
    } finally { view.app.unmount(); }
  });

  test("reopening starts a fresh interview while retaining the previous answers", async () => {
    const view = renderedWizard();
    try {
      for (let count = 0; count < 20 && !view.answers(); count++) await view.press("\r");
      expect(view.answers()?.completed).toBe(true);
      expect(view.model().isCompleted(0)).toBe(true);
      view.model().reopen();
      await Bun.sleep(30);
      expect(view.model().stepIndex()).toBe(0);
      expect(view.model().wizard.currentIndex()).toBe(0);
      expect(view.model().isCompleted(0)).toBe(false);
      expect(view.model().selection()).toEqual(["claude-code", "codex"]);
      await view.press("\r");
      expect(view.model().steps[view.model().stepIndex()]!.id).toBe("default-agent");
      expect(view.model().cursor()).toBe(1);
    } finally { view.app.unmount(); }
  });

  test("long lists keep the focused row and navigation hints inside the viewport", () => {
    const options = Array.from({ length: 24 }, (_, i) => ({ key: `a${i}`, label: `Agent ${i}`, note: "Official publisher" }));
    const { steps } = setupSteps(desktop, options, [], []);
    const model = {
      steps, stepIndex: () => 0, cursor: () => 23,
      selection: () => ["a23"], pickedFor: () => [],
      isCompleted: () => false,
    } as unknown as SetupModel;
    for (const [width, height] of [[100, 30], [80, 24], [68, 25]]) {
      const frame = renderToString(SetupLayout(model, desktop, width!, height!), width!, height!);
      expect(frame).toContain("Agent 23");
      expect(frame).toContain("of 24");
      expect(frame).toContain("next");
      expect(frame).toContain("skip");
    }
  });
});

test("the narrow fallback uses the same saved choices and dependent steps", async () => {
  const { steps } = interview();
  const answers = await runSetupPrompts(steps, {
    checkbox: async (_title, _choices, fallback) => fallback ?? [],
    select: async (_title, _choices, fallback) => fallback,
    text: async (_title, fallback = "") => fallback,
  });
  expect(answers).toMatchObject({
    defaultAgent: "codex", sshGithubUser: "octocat", theme: "cobalt", font: "hack",
    runtimes: [], redSkillsPlugins: [], blesh: false, redwall: false,
    wallpaper: "custom:abc123",
  });
});
