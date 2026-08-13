/** The installer should remain a composed card on a large Ubuntu terminal. */

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

const choice = (key: string): Choice => ({ key, label: key, note: "" });
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

function setupFrame(width: number, height: number): string[] {
  const steps = questions(
    UBUNTU_26,
    [choice("codex")],
    [choice("btop")],
    OFFERED_RUNTIMES.map((runtime) => ({
      key: runtime.id,
      label: runtime.label,
      note: runtime.about,
    })),
  );
  const runtimeStep = steps.findIndex((step) => step.id === "runtimes");
  const model = {
    steps,
    stepIndex: () => runtimeStep,
    cursor: () => 0,
    selection: () => ["node@24"],
    pickedFor: () => [],
    wizard: { isCompleted: (index: number) => index < runtimeStep },
  } as unknown as SetupModel;
  return strip(renderToString(SetupLayout(model, UBUNTU_26, width, height), width, height))
    .split("\n");
}

function occupiedBounds(rows: string[]) {
  const occupied = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.trim().length > 0);
  return {
    top: occupied[0]?.index ?? 0,
    bottom: occupied.at(-1)?.index ?? 0,
    left: Math.min(...occupied.map(({ row }) => row.search(/\S/))),
  };
}

describe("the Ubuntu installer composition", () => {
  test("centres a bounded setup card instead of stretching from the top-left", () => {
    const bounds = occupiedBounds(setupFrame(140, 42));
    expect(bounds.top).toBeGreaterThanOrEqual(4);
    expect(bounds.bottom).toBeLessThanOrEqual(37);
    expect(bounds.left).toBeGreaterThanOrEqual(12);
  });

  test("still fits a normal 80x24 terminal", () => {
    const rows = setupFrame(80, 24);
    expect(rows).toHaveLength(24);
    expect(rows.some((row) => row.includes("24 LTS"))).toBe(true);
    expect(rows.some((row) => row.length > 80)).toBe(false);
  });
});
