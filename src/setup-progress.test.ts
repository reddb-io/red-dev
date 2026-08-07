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

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("the setup work plan", () => {
  test("an npm agent brings node and every unit appears once", async () => {
    const plan = await setupPlan(windows, {
      agents: ["gemini", "t3code"],
      runtimes: [],
      apps: [],
    });

    expect(plan.map((step) => step.tool)).toEqual([
      "node@lts",
      "Gemini CLI",
      "T3 Code",
      "red-skills",
    ]);
  });

  test("an explicitly selected node is not counted twice", async () => {
    const plan = await setupPlan(windows, {
      agents: ["gemini"],
      runtimes: ["node@lts"],
      apps: [],
    });

    expect(plan.filter((step) => step.tool === "node@lts")).toHaveLength(1);
  });

  test("desktop-only choices do not pretend red-skills has work", async () => {
    const plan = await setupPlan(windows, {
      agents: ["t3code", "claude-desktop", "codex-desktop"],
      runtimes: [],
      apps: [],
    });

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
      elapsedMs: () => 18_000,
      total: 46,
      logScroll: createScrollArea({ height: 10, content: [], autoScroll: true }),
      prelude: () => {},
      setupBegin: () => {},
      setupStepStart: () => {},
      setupStepEnd: () => {},
      begin: () => {},
      note: () => {},
      handleKey: () => false,
    } as unknown as InstallModel;

    const frame = strip(renderToString(InstallLayout(model, 96, 30), 96, 30));

    expect(frame).toContain("2/50");
    expect(frame).toContain("2 installed");
  });
});
