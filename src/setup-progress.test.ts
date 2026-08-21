/**
 * Work done before converge is still installation work.
 *
 * A native-Windows first run spent minutes installing node and agents while
 * the progress panel stayed at 0/46.  Moving the clock was not enough: the
 * numerator and denominator have to include the choices being carried out.
 */

import { describe, expect, test } from "bun:test";
import { createScrollArea, renderToString } from "tuiuiu.js";
import { setupPlan } from "./firstrun.ts";
import { InstallLayout, type InstallModel } from "./tui-install.ts";
import type { Platform } from "./platform.ts";

const windows: Platform = {
  os: "windows",
  env: "windows",
  distro: null,
  version: null,
  codename: null,
  arch: "x64",
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
};

const wsl: Platform = {
  os: "linux",
  env: "wsl",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  arch: "x64",
  caps: { apt: true, gui: false, systemd: true, winget: true, flatpak: false },
};

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * A machine with no node yet, which is what every plan below describes.
 *
 * Injected rather than probed: the answer is a fact about whatever
 * machine runs the suite, and these assertions are about the plan.
 */
const noNode = async () => false;
const hasNode = async () => true;

describe("the setup work plan", () => {
  test("an npm agent brings node and every unit appears once", async () => {
    const plan = await setupPlan(windows, {
      agents: ["gemini", "t3code"],
      runtimes: [],
      apps: [],
    }, noNode);

    expect(plan.map((step) => step.tool)).toEqual([
      "node@24",
      "Gemini CLI",
      "T3 Code",
      "red-skills",
    ]);
  });

  test("a machine that already has node is not re-pinned to 24 for an npm agent", async () => {
    // The bug this closes, from one install transcript:
    //
    //     :: mise: node@latest    tools: node@26.7.0
    //     :: mise: node@24        tools: node@24.18.0
    //
    // `red-dev lang node@latest` then `red-dev agents …` — two separate
    // commands, which is how the Windows side reproduces a selection
    // inside WSL. The second saw no node in its own choices, took the
    // machine for one without any, and `mise use -g node@24` set the
    // global pin over the `latest` a person had just chosen.
    const plan = await setupPlan(windows, { agents: ["gemini"], runtimes: [], apps: [] }, hasNode);

    expect(plan.map((step) => step.tool)).not.toContain("node@24");
    expect(plan.map((step) => step.tool)).toEqual(["Gemini CLI", "red-skills"]);
  });

  test("and a machine without one still gets it, so npm has something to run", async () => {
    const plan = await setupPlan(windows, { agents: ["gemini"], runtimes: [], apps: [] }, noNode);
    expect(plan.map((step) => step.tool)).toContain("node@24");
  });

  test("an explicitly selected node is not counted twice", async () => {
    const plan = await setupPlan(windows, {
      agents: ["gemini"],
      runtimes: ["node@lts"],
      apps: [],
    }, noNode);

    expect(plan.filter((step) => step.tool === "node@lts")).toHaveLength(1);
  });

  test("Hermes brings both Node and Python before its npm postinstall", async () => {
    const plan = await setupPlan(windows, {
      agents: ["hermes"],
      runtimes: [],
      apps: [],
    }, noNode);

    expect(plan.map((step) => step.tool)).toEqual([
      "node@24",
      "python@3.13",
      "Hermes Agent",
      "red-skills",
    ]);
  });

  test("the unattended WSL copy brings the runtimes its npm agents need", async () => {
    const plan = await setupPlan(wsl, {
      agents: ["openclaw", "hermes"],
      runtimes: [],
      apps: [],
    }, noNode);

    expect(plan.map((step) => step.tool)).toEqual([
      "node@24",
      "python@3.13",
      "OpenClaw",
      "Hermes Agent",
      "red-skills",
    ]);
  });

  test("desktop-only choices do not pretend red-skills has work", async () => {
    const plan = await setupPlan(windows, {
      agents: ["t3code", "claude-desktop", "codex-desktop"],
      runtimes: [],
      apps: [],
    }, noNode);

    expect(plan.map((step) => step.tool)).not.toContain("red-skills");
  });
});

describe("the install progress panel", () => {
  test("counts completed setup work before converge starts", () => {
    const model = {
      lines: () => ["ok  node@lts", "ok  Gemini CLI"],
      results: () => [],
      setupResults: () => [
        { tool: "node@lts", outcome: "installed" },
        { tool: "Gemini CLI", outcome: "installed" },
      ],
      setupTotal: () => 4,
      current: () => "T3 Code",
      scope: () => "setup",
      finished: () => false,
      following: () => true,
      followScroll: () => {},
      elapsedMs: () => 18_000,
      total: 46,
      logScroll: createScrollArea({ height: 10, content: [], autoScroll: true }),
      prelude: () => {},
      setupBegin: () => {},
      setupStepStart: () => {},
      setupStepEnd: () => {},
      begin: () => {},
      note: () => {},
    } as unknown as InstallModel;

    const frame = strip(renderToString(InstallLayout(model, 96, 30), 96, 30));

    expect(frame).toContain("2/50");
    expect(frame).toContain("2 installed");
  });
});
