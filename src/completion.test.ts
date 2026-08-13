/**
 * The closing frame has to be right about the run it closes.
 *
 * Everything a person takes away from a converge they watched for four
 * minutes is in one sentence at the bottom of it, and the sentence is
 * produced from counts by a function nobody looks at afterwards. The
 * expensive mistakes are the quiet ones: a machine with an item waiting
 * on rights reported as converged, so nobody ever runs the elevated
 * half; a run with a failure in the middle reported the same way, so the
 * next person discovers it a week later.
 *
 * Five shapes, because a converge has five: nothing to do, work applied,
 * work waiting on rights, work that broke, and both at once.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  completionBanner,
  convergeVerdict,
  shortenHome,
  wrapTo,
  type VerdictItem,
} from "./completion.ts";

const item = (tool: string, over: Partial<VerdictItem> = {}): VerdictItem => ({
  tool,
  outcome: "present",
  ...over,
});

const plain = (lines: string[]): string[] => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

describe("the verdict", () => {
  test("a machine with nothing to do is converged, and asked to do nothing", () => {
    const v = convergeVerdict([item("git"), item("eza")], 4_000);
    expect(v.status).toBe("converged");
    expect(v.headline).toContain("converged");
    // No shell instruction: nothing was installed, so there is nothing
    // new for a new session to pick up.
    expect(v.nextSteps).toEqual([]);
    expect(v.counts).toMatchObject({ total: 2, changed: 0, present: 2 });
    expect(v.elapsed).toBe("4.0s");
  });

  test("work applied is converged, and says where to see it", () => {
    const v = convergeVerdict(
      [item("git", { outcome: "installed" }), item("dotfiles", { outcome: "applied" })],
      1_000,
    );
    expect(v.status).toBe("converged");
    expect(v.counts.changed).toBe(2);
    expect(v.nextSteps.some((s) => s.includes("new terminal"))).toBe(true);
  });

  test("deferral is not failure, and carries the gate's own remedy once", () => {
    const v = convergeVerdict(
      [
        item("git", { outcome: "installed" }),
        item("ssh-server", { outcome: "deferred", remedy: "Run `sudo -v` first." }),
        item("ufw", { outcome: "deferred", remedy: "Run `sudo -v` first." }),
      ],
      1_000,
    );
    expect(v.status).toBe("deferred");
    expect(v.headline).toContain("converged, except 2 items");
    // Two items behind one gate share one key. Printing it twice reads
    // as two separate things to go and do.
    expect(v.nextSteps.filter((s) => s.includes("sudo -v"))).toHaveLength(1);
  });

  test("one deferred item is counted in words, not as '1 items'", () => {
    const v = convergeVerdict([item("ssh-server", { outcome: "deferred" })], 1_000);
    expect(v.headline).toContain("one item");
    // No remedy on the item, so the verdict still has to say something
    // actionable rather than leaving the reader with a count.
    expect(v.nextSteps.some((s) => s.includes("rights"))).toBe(true);
  });

  test("deferred items show their shared cause without opening the log", () => {
    const detail = "sudo needs a password and nothing here can supply one.";
    const v = convergeVerdict(
      [
        item("btop", { outcome: "deferred", detail }),
        item("red-ui", { outcome: "deferred", detail }),
      ],
      1_000,
    );

    expect(v.deferrals).toEqual([
      { tool: "btop", detail },
      { tool: "red-ui", detail },
    ]);
    const banner = plain(completionBanner(v, 72, { color: false })).join("\n");
    expect(banner).toContain("Waiting");
    expect(banner).toContain("sudo needs a password");
  });

  test("a failure says the machine is not converged, and names the item", () => {
    const v = convergeVerdict([item("docker", { outcome: "failed" })], 90_000);
    expect(v.status).toBe("failed");
    expect(v.headline).toContain("not converged");
    expect(v.headline).toContain("docker");
    expect(v.nextSteps[0]).toContain("Re-run");
    expect(v.elapsed).toBe("1m 30s");
  });

  test("a failure carries its cause into the closing verdict", () => {
    const failed = item("nerd-font", {
      outcome: "failed",
      detail: "GitHub API 403 for ryanoasis/nerd-fonts — rate limited",
    });
    const v = convergeVerdict([failed], 1_000);

    expect(v.failures).toEqual([
      {
        tool: "nerd-font",
        detail: "GitHub API 403 for ryanoasis/nerd-fonts — rate limited",
      },
    ]);
    expect(plain(completionBanner(v, 72, { color: false })).join("\n")).toContain(
      "GitHub API 403 for ryanoasis/nerd-fonts",
    );
  });

  test("failures outrank deferrals when a run has both", () => {
    // A machine with a broken item is broken; the item waiting on rights
    // is not the news, and reporting it as the verdict buries the one
    // thing somebody has to act on.
    const v = convergeVerdict(
      [
        item("docker", { outcome: "failed" }),
        item("ssh-server", { outcome: "deferred", remedy: "Run `sudo -v` first." }),
      ],
      1_000,
    );
    expect(v.status).toBe("failed");
    expect(v.counts).toMatchObject({ failed: 1, deferred: 1 });
    // Both remainders still get their instruction: the run has two.
    expect(v.nextSteps.some((s) => s.includes("Re-run"))).toBe(true);
    expect(v.nextSteps.some((s) => s.includes("sudo -v"))).toBe(true);
  });

  test("a preview never claims a machine converged", () => {
    const v = convergeVerdict([item("git", { outcome: "installed" })], 1_000, { dryRun: true });
    expect(v.status).toBe("preview");
    expect(v.headline).toContain("nothing on this machine changed");
    expect(v.nextSteps.some((s) => s.includes("red-dev install"))).toBe(true);
  });

  test("the transcript is carried through when one was opened", () => {
    expect(convergeVerdict([], 1, { logPath: "/tmp/run.log" }).logPath).toBe("/tmp/run.log");
    expect(convergeVerdict([], 1).logPath).toBeNull();
  });
});

describe("the banner", () => {
  const verdict = convergeVerdict(
    [
      item("git", { outcome: "installed" }),
      item("ssh-server", { outcome: "deferred", remedy: "Run `sudo -v` first, then re-run." }),
    ],
    12_345,
    { logPath: "/home/somebody/.local/state/red-dev/2026-08-12-install.log" },
  );

  test("says the verdict where a reader lands", () => {
    const lines = plain(completionBanner(verdict, 100, { color: false }));
    // Collapsed, because a long headline is wrapped across rows of the
    // frame — what matters is that all of it is there, in order.
    const flat = lines.join(" ").replace(/[│┌┐└┘─]/g, " ").replace(/\s+/g, " ");
    expect(flat).toContain(verdict.headline);
    expect(lines.some((l) => l.includes("12.3s"))).toBe(true);
    expect(lines.some((l) => l.includes("sudo -v"))).toBe(true);
  });

  test("every row is the same width, and never wider than the rule", () => {
    for (const columns of [30, 61, 80, 200]) {
      const drawn = plain(completionBanner(verdict, columns, { color: false })).filter(
        (l) => l !== "",
      );
      const widths = new Set(drawn.map((l) => [...l].length));
      expect(widths.size).toBe(1);
      expect([...widths][0]).toBeLessThanOrEqual(Math.min(Math.max(columns, 28), 72));
    }
  });

  test("colour never changes the shape", () => {
    const bare = plain(completionBanner(verdict, 72, { color: false }));
    const painted = plain(completionBanner(verdict, 72, { color: true }));
    expect(painted).toEqual(bare);
  });

  test("a frame is drawn, closed, and stands off the output above it", () => {
    const lines = completionBanner(verdict, 72, { color: false });
    expect(lines[0]).toBe("");
    expect(lines[1]?.startsWith("┌")).toBe(true);
    expect(lines[lines.length - 2]?.startsWith("└")).toBe(true);
    expect(lines[lines.length - 1]).toBe("");
  });
});

/**
 * Structural, because the alternative needs a terminal and a keystroke.
 *
 * What can be checked without one is that neither fullscreen path can
 * quietly go back to ending on a menu redraw: both draw the completion
 * screen when the converge is done, and the terminal is handed the same
 * verdict after the frame is released.
 */
describe("where each path ends", () => {
  const read = (p: string): string => readFileSync(p, "utf8");

  test("both fullscreen entries land on the completion screen", () => {
    for (const file of ["src/tui.ts", "src/tui-install.ts"]) {
      expect(read(file)).toContain("CompletionLayout(");
    }
  });

  test("the terminal keeps the verdict after the interface releases it", () => {
    const main = read("src/main.ts");
    expect(main).toContain("completionBanner");
    // Every converge exit goes through the one function that prints it.
    expect(main.match(/\bendInstall\(/g) ?? []).toHaveLength(4);
  });
});

describe("the log path", () => {
  test("wears a tilde so it fits the frame whole", () => {
    // Cut instead, it is a path nobody can open — which is the only
    // reason it is printed at all.
    expect(shortenHome("/home/somebody/.local/state/red-dev/run.log", "/home/somebody")).toBe(
      "~/.local/state/red-dev/run.log",
    );
  });

  test("leaves anything outside home alone", () => {
    expect(shortenHome("/var/log/run.log", "/home/somebody")).toBe("/var/log/run.log");
    expect(shortenHome("/var/log/run.log", undefined)).toBe("/var/log/run.log");
    expect(shortenHome(null, "/home/somebody")).toBeNull();
  });

  test("a home-shaped prefix that is not the home directory is not shortened", () => {
    expect(shortenHome("/home/somebody-else/run.log", "/home/somebody")).toBe(
      "/home/somebody-else/run.log",
    );
  });
});

describe("wrapping", () => {
  test("breaks on words", () => {
    expect(wrapTo("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });

  test("cuts a word that cannot fit rather than breaking the frame", () => {
    // A transcript path is one word and can be longer than the box.
    const [only] = wrapTo("/a/very/long/path/that/never/ends.log", 12);
    expect([...(only ?? "")].length).toBe(12);
    expect(only?.endsWith("…")).toBe(true);
  });

  test("an empty line stays one line", () => {
    expect(wrapTo("", 20)).toEqual([""]);
  });
});
