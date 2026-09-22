/** The language screen exposes only moving latest channels. */

import { describe, expect, test } from "bun:test";
import { renderToString } from "tuiuiu.js";
import type { Platform } from "./platform.ts";
import { OFFERED_RUNTIMES } from "./runtimes.ts";
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

describe("runtime channel picker", () => {
  test("the language screen shows latest without version controls", () => {
    const frame = runtimesFrame(["node@latest"]);
    expect(frame).toContain("Node.js");
    expect(frame).toContain("latest");
    expect(frame).not.toContain("left/right");
  });

  test("there is no hidden global Versions step anymore", () => {
    const ids = questions(UBUNTU_26, [], [], runtimeChoices()).map((step) => step.id);
    expect(ids).not.toContain("runtime-versions");
  });
});
