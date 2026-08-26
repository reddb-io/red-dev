/** The organisation's products have one honest page in first-run setup. */

import { describe, expect, test } from "bun:test";
import { renderToString } from "tuiuiu.js";
import { buildSetupSteps } from "./firstrun.ts";
import type { Platform } from "./platform.ts";
import {
  otherOptionalChoices,
  redFamilyChoices,
  RED_FAMILY_OPTIONAL,
} from "./red-family.ts";
import {
  choiceSelectable,
  questions,
  SetupLayout,
  selectedSetupApps,
  stepInitialCursor,
  type Choice,
  type SetupModel,
} from "./tui-setup-model.ts";

const DESKTOP: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

const WSL: Platform = {
  ...DESKTOP,
  env: "wsl",
  caps: { ...DESKTOP.caps, gui: false, winget: true, flatpak: false },
};

const agents: Choice[] = [
  { key: "codex", label: "Codex", note: "OpenAI's CLI" },
  { key: "redcode", label: "RedCode", note: "RedDB's terminal agent" },
];

describe("the dedicated RedDB setup page", () => {
  test("is wired into the setup flow used by install", async () => {
    const { steps } = await buildSetupSteps(WSL);
    const red = steps.find((step) => step.id === "reddb");
    expect(red?.title).toBe("RedDB");
    expect(red?.choices.some((choice) => choice.key === "red-dev")).toBe(true);
    expect(red?.choices.some((choice) => choice.key === "red-skills-vscode")).toBe(true);
  });

  test("names the apps and every declared RedSkills plugin/integration", () => {
    const keys = redFamilyChoices(DESKTOP, agents).map((choice) => choice.key);
    expect(keys).toEqual([
      "red-dev",
      "red",
      "tq",
      "red-request",
      "red-ui",
      "redcode",
      "dit",
      "red-skills-core",
      "red-skills-dev",
      "red-skills-memory",
      "red-skills-brain",
      "red-skills-vscode",
      "red-skills-herdr",
    ]);
  });

  test("keeps a RedDB page on WSL while omitting desktop-only products", () => {
    const red = redFamilyChoices(WSL, agents);
    const keys = red.map((choice) => choice.key);
    expect(keys).not.toContain("red-request");
    expect(keys).not.toContain("red-ui");
    expect(keys).not.toContain("dit");
    expect(keys).toContain("redcode");
    expect(questions(WSL, agents, otherOptionalChoices(WSL), [], red).map((q) => q.id))
      .toContain("reddb");
  });

  test("distinguishes base inventory from genuine optional integrations", () => {
    const choices = redFamilyChoices(DESKTOP, agents);
    const optional = choices.filter((choice) => choice.answer === "apps");
    expect(optional.map((choice) => choice.key)).toEqual([...RED_FAMILY_OPTIONAL]);
    expect(optional.every((choice) => choice.selectable === true)).toBe(true);
    expect(choices.find((choice) => choice.key === "red-dev")?.selectable).toBe(false);
    expect(choices.find((choice) => choice.key === "red-dev")?.marker).toBe("included");
    expect(choices.find((choice) => choice.key === "redcode")?.marker).toBe("elsewhere");
  });

  test("removes RedDB integrations from the generic Tools page", () => {
    const generic = otherOptionalChoices(DESKTOP).map((choice) => choice.key);
    expect(generic).not.toContain("red-skills-vscode");
    expect(generic).not.toContain("red-skills-herdr");
    expect(generic).toContain("just");
  });

  test("sits between runtimes and generic tools", () => {
    const red = redFamilyChoices(DESKTOP, agents);
    const steps = questions(DESKTOP, agents, otherOptionalChoices(DESKTOP), [], red);
    const ids = steps.map((step) => step.id);
    expect(ids.indexOf("reddb")).toBe(ids.indexOf("runtimes") + 1);
    expect(ids.indexOf("apps")).toBe(ids.indexOf("reddb") + 1);
  });

  test("returns only selected optional rows as install answers", () => {
    const red = redFamilyChoices(DESKTOP, agents);
    const steps = questions(DESKTOP, agents, [], [], red);
    const picked = (id: string): string[] => {
      if (id === "reddb") return ["red-dev", "red", "red-skills-vscode"];
      if (id === "apps") return ["just"];
      return [];
    };
    expect(selectedSetupApps(steps, picked)).toEqual(["just", "red-skills-vscode"]);
  });

  test("cannot toggle a base product and starts on the first real choice", () => {
    const step = questions(DESKTOP, agents, [], [], redFamilyChoices(DESKTOP, agents))
      .find((candidate) => candidate.id === "reddb")!;
    expect(choiceSelectable(step, step.choices.find((choice) => choice.key === "red")!)).toBe(false);
    expect(
      choiceSelectable(step, step.choices.find((choice) => choice.key === "red-skills-vscode")!),
    ).toBe(true);
    expect(step.choices[stepInitialCursor(step)]?.key).toBe("red-skills-vscode");
  });

  test("renders inventory, cross-reference, and optional checkboxes", () => {
    const red = redFamilyChoices(DESKTOP, agents);
    const steps = questions(DESKTOP, agents, [], [], red);
    const index = steps.findIndex((step) => step.id === "reddb");
    const selected = red.map((choice) => choice.key);
    const model = {
      steps,
      stepIndex: () => index,
      cursor: () => 0,
      selection: () => selected,
      pickedFor: (id: string) => id === "reddb" ? selected : [],
      wizard: { isCompleted: () => false },
    } as unknown as SetupModel;
    const frame = renderToString(SetupLayout(model, DESKTOP, 110, 34), 110, 34)
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("• red-dev");
    expect(frame).toContain("→ RedCode");
    expect(frame).toContain("[x] RedSkills · VS Code integration");
  });
});
