/**
 * A failed run copies itself, because the console will not.
 *
 * The classic Windows Console Host copies by selecting with the mouse
 * and pressing Enter — Ctrl+C there is an interrupt. And red-dev
 * disables QuickEdit for the length of a fullscreen view on purpose, so
 * the one screen somebody most wants to send to somebody else is the
 * one they cannot select.
 */

import { describe, expect, test } from "bun:test";

import type { CompletionVerdict } from "./completion.ts";
import { copyFailures, failureReport, worthCopying } from "./failure-clipboard.ts";
import type { Platform } from "./platform.ts";

const WSL: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "wsl",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

function verdict(over: Partial<CompletionVerdict> = {}): CompletionVerdict {
  return {
    headline: "1 item failed — this machine is not converged yet (red-skills-core)",
    counts: { total: 71, changed: 30, present: 35, deferred: 0, failed: 1 },
    elapsed: "4m 30s",
    logPath: "C:/Users/me/AppData/Local/red-dev/logs/run.log",
    failures: [{ tool: "red-skills-core", detail: "mise could not install red-skills@4 (exit 1)" }],
    deferrals: [],
    nextSteps: ["Re-run `red-dev install`"],
    ...over,
  } as CompletionVerdict;
}

describe("what gets copied", () => {
  test("the headline, the counts, the log path and every failure", () => {
    const text = failureReport(verdict(), "1.0.87");
    expect(text).toContain("red-dev 1.0.87");
    expect(text).toContain("1 failed");
    expect(text).toContain("log  C:/Users/me/AppData/Local/red-dev/logs/run.log");
    expect(text).toContain("- red-skills-core: mise could not install red-skills@4 (exit 1)");
  });

  test("is plain text, so it survives being pasted into an issue", () => {
    const text = failureReport(verdict(), "1.0.87");
    // No colour, no box drawing: a bug report full of ANSI escapes and
    // question-mark glyphs is a bug report nobody can read.
    expect(text).not.toMatch(/\u001b\[/);
    expect(text).not.toMatch(/[┌┐└┘│─✗→]/);
  });

  test("names what is waiting too, which is the other thing worth sending", () => {
    const text = failureReport(
      verdict({ deferrals: [{ tool: "ssh-server", detail: "sudo needs a password" }] } as never),
      "1.0.87",
    );
    expect(text).toContain("Waiting");
    expect(text).toContain("- ssh-server: sudo needs a password");
  });
});

describe("when it is copied", () => {
  test("never on a run that worked: a clipboard is not ours to take", () => {
    const clean = verdict({ failures: [], counts: { total: 71, changed: 30, present: 41, deferred: 0, failed: 0 } } as never);
    expect(worthCopying(clean)).toBe(false);
  });

  test("on a failure, through the route the terminal layer already owns", async () => {
    const seen: { argv: readonly string[]; text: string }[] = [];
    const note = await copyFailures(WSL, verdict(), "1.0.87", async (argv, text) => {
      seen.push({ argv, text });
      return 0;
    });

    expect(note).toBe("the errors above are on your clipboard");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.text).toContain("red-skills-core");
    // The WSL bridge — the wrapper the dotfiles own, which is where the
    // three attempts at getting UTF-8 across that boundary ended up.
    // Not an argv this module invented.
    expect(seen[0]?.argv.join(" ")).toContain("windows-clipboard.sh");
  });

  test("a clipboard that refuses is not a failed run", async () => {
    expect(await copyFailures(WSL, verdict(), "1.0.87", async () => 1)).toBeNull();
    expect(
      await copyFailures(WSL, verdict(), "1.0.87", () => Promise.reject(new Error("wedged"))),
    ).toBeNull();
  });

  test("a machine with no clipboard says nothing rather than failing", async () => {
    const headless: Platform = { ...WSL, env: "server", caps: { ...WSL.caps, gui: false } };
    let called = false;
    await copyFailures(headless, verdict(), "1.0.87", async () => {
      called = true;
      return 0;
    });
    expect(called).toBe(false);
  });
});
