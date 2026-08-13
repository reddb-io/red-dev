/**
 * The boundary immediately after a completed row.
 *
 * This is where the Ubuntu report appeared to stop: `dit — present` was
 * visible, while the next managed item was already fetching a Nerd Font.
 * Cross the real hook/render boundary so a regression cannot hide behind a
 * structural assertion about source text.
 */

import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createScrollArea, render, renderToString, useEffect } from "tuiuiu.js";
import { converge } from "./converge.ts";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import {
  InstallLayout,
  CompletionLayout,
  type InstallModel,
  type InstallOutcome,
  type InstallTuiOptions,
  useInstallModel,
} from "./tui-install.ts";

const desktop: Platform = {
  os: "linux",
  env: "desktop",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

function terminal() {
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream;
  Object.assign(stdin, { isTTY: true, isRaw: false, setRawMode: () => stdin });
  Object.assign(stdout, { isTTY: true, columns: 96, rows: 30 });
  return { stdin, stdout };
}

const base: Omit<InstallTuiOptions, "converge"> = {
  platform: desktop,
  ctx: { platform: desktop, theme: "reddb", font: "firacode", opacity: 100 },
  scopes: ["desktop"],
};

describe("the final converge boundary", () => {
  test("the fullscreen completion explains a sudo deferral without opening the log", () => {
    const frame = renderToString(
      CompletionLayout(
        {
          failed: 0,
          deferred: 2,
          elapsedMs: 1_000,
          results: [
            {
              tool: "btop",
              outcome: "deferred",
              detail: "sudo needs a password and nothing here can supply one.",
              remedy: "Run `sudo -v` first, then re-run red-dev.",
            },
            {
              tool: "red-ui",
              outcome: "deferred",
              detail: "sudo needs a password and nothing here can supply one.",
              remedy: "Run `sudo -v` first, then re-run red-dev.",
            },
          ],
        },
        96,
        30,
        "/tmp/install.log",
      ),
      96,
      30,
    );

    expect(frame).toContain("Waiting");
    expect(frame).toContain("sudo needs a password");
    expect(frame).toContain("btop, red-ui");
    expect(frame).toContain("sudo -v");
  });

  test("the fullscreen completion shows the provider's error without opening the log", () => {
    const frame = renderToString(
      CompletionLayout(
        {
          failed: 1,
          deferred: 0,
          elapsedMs: 1_000,
          results: [
            {
              tool: "nerd-font",
              outcome: "failed",
              detail: "GitHub API 403 for ryanoasis/nerd-fonts — rate limited",
            },
          ],
        },
        96,
        30,
        "/tmp/install.log",
      ),
      96,
      30,
    );

    expect(frame).toContain("Errors");
    expect(frame).toContain("GitHub API 403 for ryanoasis/nerd-fonts");
  });

  test("names and narrates the step after a present dit while it is still running", async () => {
    let releaseFont!: () => void;
    const fontMayFinish = new Promise<void>((resolve) => (releaseFont = resolve));
    const runner: typeof converge = async (_opts, observer = {}) => {
      const dit = {
        scope: "desktop" as const,
        tool: "dit",
        provider: "installer:dit",
        index: 1,
        total: 2,
      };
      observer.stepStart?.(dit);
      observer.stepEnd?.({ ...dit, outcome: "present", ms: 0 });

      const font = {
        scope: "desktop" as const,
        tool: "nerd-font",
        provider: "builtin:nerd-font",
        index: 2,
        total: 2,
      };
      observer.stepStart?.(font);
      log.info("downloading https://example.invalid/FiraCode.zip");
      await fontMayFinish;
      const result = { ...font, outcome: "applied" as const, ms: 250 };
      observer.stepEnd?.(result);
      return { results: [{ ...dit, outcome: "present", ms: 0 }, result], failed: 0, deferred: 0 };
    };

    let model!: InstallModel;
    let finished: InstallOutcome | null = null;
    const logScroll = createScrollArea({ height: 10, content: [], autoScroll: true });
    function App() {
      model = useInstallModel({ ...base, converge: runner }, logScroll, (outcome) => {
        finished = outcome;
      });
      useEffect(() => model.begin());
      return InstallLayout(model, 96, 30);
    }

    const io = terminal();
    const app = render(App, { ...io, fullHeight: true });
    try {
      await Bun.sleep(60);
      expect(model.current()).toBe("nerd-font");
      expect(model.lines()).toContain(":: nerd-font — builtin:nerd-font");
      expect(model.lines()).toContain("    info downloading https://example.invalid/FiraCode.zip");
      expect(finished).toBeNull();

      releaseFont();
      await Bun.sleep(60);
      expect(finished).not.toBeNull();
    } finally {
      releaseFont();
      app.unmount();
    }
  });

  test("an unexpected rejection becomes a failed completion instead of working forever", async () => {
    const runner: typeof converge = async (_opts, observer = {}) => {
      const dit = {
        scope: "desktop" as const,
        tool: "dit",
        provider: "installer:dit",
        index: 1,
        total: 1,
      };
      observer.stepStart?.(dit);
      observer.stepEnd?.({ ...dit, outcome: "present", ms: 0 });
      throw new Error("probe exploded after dit");
    };

    let model!: InstallModel;
    let finished: InstallOutcome | null = null;
    const logScroll = createScrollArea({ height: 10, content: [], autoScroll: true });
    function App() {
      model = useInstallModel({ ...base, converge: runner }, logScroll, (outcome) => {
        finished = outcome;
      });
      useEffect(() => model.begin());
      return InstallLayout(model, 96, 30);
    }

    const io = terminal();
    const app = render(App, { ...io, fullHeight: true });
    try {
      await Bun.sleep(60);
      expect(model.finished()).toBe(true);
      expect((finished as InstallOutcome | null)?.failed).toBe(1);
      expect((finished as InstallOutcome | null)?.results.at(-1)).toMatchObject({
        tool: "dit",
        outcome: "failed",
        detail: "probe exploded after dit",
      });
      expect(model.lines().join("\n")).toContain("probe exploded after dit");
    } finally {
      app.unmount();
    }
  });
});
