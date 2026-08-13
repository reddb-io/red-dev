/** Per-runtime version selection belongs on the language row itself. */

import { describe, expect, test } from "bun:test";
import { renderToString } from "tuiuiu.js";
import type { Platform } from "./platform.ts";
import {
  OFFERED_RUNTIMES,
  shiftRuntimeVersion,
} from "./runtimes.ts";
import {
  questions,
  SetupLayout,
  type Choice,
  type SetupModel,
} from "./tui-setup-model.ts";

const UBUNTU_26: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "26.04",
  codename: "resolute",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
const runtimeChoices = (): Choice[] =>
  OFFERED_RUNTIMES.map((runtime) => ({
    key: runtime.id,
    label: runtime.label,
    note: runtime.about,
  }));

function runtimesFrame(selection: string[]): string {
  const steps = questions(UBUNTU_26, [], [], runtimeChoices());
  const index = steps.findIndex((step) => step.id === "runtimes");
  const model = {
    steps,
    stepIndex: () => index,
    cursor: () => 0,
    selection: () => selection,
    pickedFor: () => [],
    wizard: { isCompleted: () => false },
  } as unknown as SetupModel;
  return strip(renderToString(SetupLayout(model, UBUNTU_26, 100, 30), 100, 30));
}

describe("per-runtime version picker", () => {
  test("Node can move from the supported LTS line to the current line", () => {
    expect(shiftRuntimeVersion(["node@24", "python@3.13"], "node@24", 1)).toEqual([
      "node@26",
      "python@3.13",
    ]);
  });

  test("each selected language keeps its own version", () => {
    expect(shiftRuntimeVersion(["node@26", "python@3.13"], "python@3.13", 1)).toEqual([
      "node@26",
      "python@3.14",
    ]);
  });

  test("version arrows do not also opt an unchecked language in", () => {
    expect(shiftRuntimeVersion(["node@24"], "java@25", 1)).toEqual(["node@24"]);
  });

  test("the language screen shows the active version and its controls", () => {
    const frame = runtimesFrame(["node@26"]);
    expect(frame).toContain("Node.js");
    expect(frame).toContain("26 Current");
    expect(frame).toContain("left/right");
  });

  test("there is no hidden global Versions step anymore", () => {
    const ids = questions(UBUNTU_26, [], [], runtimeChoices()).map((step) => step.id);
    expect(ids).not.toContain("runtime-versions");
  });
});
