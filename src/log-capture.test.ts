/**
 * A child process must not write to a screen it does not own.
 *
 * `log` calls were routed into the fullscreen interface from the start;
 * the processes those steps spawn were not. They inherited stdout, so
 * curl, apt and every vendor install script wrote straight to the
 * terminal — landing wherever the cursor happened to be, which during a
 * converge is the middle of a frame the renderer is painting. The
 * screenshot that reported it had installer output through the progress
 * panel and a torn log above it.
 */

import { describe, expect, test } from "bun:test";
import { captureTo, logIsCaptured } from "./log.ts";
import { spawnLogged } from "./providers.ts";

/** Collect whatever the log emits while `body` runs. */
async function collect(body: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const restore = captureTo((line) => seen.push(line));
  try {
    await body();
  } finally {
    restore();
  }
  return seen;
}

describe("logIsCaptured", () => {
  test("is false when the terminal is the interface", () => {
    expect(logIsCaptured()).toBe(false);
  });

  test("is true while a sink is installed, and false again after", async () => {
    const during: boolean[] = [];
    await collect(async () => {
      during.push(logIsCaptured());
    });
    expect(during).toEqual([true]);
    expect(logIsCaptured()).toBe(false);
  });
});

describe("a spawned child while the interface owns the screen", () => {
  test("sends stdout to the log", async () => {
    const seen = await collect(async () => {
      await spawnLogged(["sh", "-c", "echo hello-from-child"]);
    });
    expect(seen.join("\n")).toContain("hello-from-child");
  });

  test("sends stderr there too", async () => {
    // The half that matters most: a failing installer says why on
    // stderr, and that is the line worth having under its own step.
    const seen = await collect(async () => {
      await spawnLogged(["sh", "-c", "echo the-reason >&2"]);
    });
    expect(seen.join("\n")).toContain("the-reason");
  });

  test("still reports the exit code", async () => {
    let code = -1;
    await collect(async () => {
      code = await spawnLogged(["sh", "-c", "exit 3"]);
    });
    expect(code).toBe(3);
  });

  test("keeps one line per line", async () => {
    const seen = await collect(async () => {
      await spawnLogged(["sh", "-c", "printf 'one\\ntwo\\nthree\\n'"]);
    });
    expect(seen).toEqual(["one", "two", "three"]);
  });

  test("resolves a progress line to what it last said", async () => {
    // A download bar rewrites one line with carriage returns. Kept
    // whole it becomes every state it passed through concatenated into
    // one unreadable row, which is worse than the wrapping this frame
    // already suffers from.
    const seen = await collect(async () => {
      await spawnLogged(["sh", "-c", "printf '10%%\\r50%%\\r100%%\\n'"]);
    });
    expect(seen).toEqual(["100%"]);
  });

  test("drops the blank lines a script pads its output with", async () => {
    const seen = await collect(async () => {
      await spawnLogged(["sh", "-c", "printf 'a\\n\\n\\nb\\n'"]);
    });
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("mise, which used to write straight onto the frame", () => {
  test("is spawned through the one helper that asks where output goes", async () => {
    // The report that started this: an install inside the fullscreen
    // interface looked like two programs fighting over one window,
    // because it was. mise redraws progress with carriage returns and
    // colour, several lines a second, and it was spawned through a
    // `Bun.spawn` of its own with `stdout: "inherit"` — the one path
    // that never asked `logIsCaptured()`.
    const source = await Bun.file(new URL("./providers.ts", import.meta.url)).text();
    const runMise = source.slice(
      source.indexOf("async function runMise("),
      source.indexOf("export function expandArchiveArgv("),
    );

    expect(runMise).toContain("spawnLogged(");
    expect(runMise).not.toContain('stdout: "inherit"');
    expect(runMise).not.toContain("Bun.spawn");
    // The unattended environment still rides along: a prompt inside a
    // converge is a hang, not a question.
    expect(runMise).toContain('MISE_YES: "1"');
    expect(runMise).toContain("miseReleaseAgeEnv(platform)");
  });

  test("no provider spawn inherits without asking first", async () => {
    // `spawnLogged` inherits only when the terminal is the interface,
    // and pipes into the log when it is not. A second spawn that
    // inherits unconditionally is the bug coming back under a new name.
    const source = await Bun.file(new URL("./providers.ts", import.meta.url)).text();
    const inherits = source.split("\n").filter((line) => line.includes('stdout: "inherit"'));
    // Exactly one: the branch inside spawnLogged that already checked.
    expect(inherits).toHaveLength(1);
    expect(source.slice(0, source.indexOf('stdout: "inherit"'))).toContain("if (!logIsCaptured())");
  });
});
