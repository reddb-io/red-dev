import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENABLE_EXTENDED_FLAGS,
  ENABLE_QUICK_EDIT_MODE,
  withConsoleSelectionSuspended,
  type ConsoleModePort,
} from "./windows-console-mode.ts";

function port(initial: number): ConsoleModePort & { writes: number[] } {
  let mode = initial;
  const writes: number[] = [];
  return {
    writes,
    read: () => mode,
    write: (next) => {
      writes.push(next);
      mode = next;
      return true;
    },
    close: () => {},
  };
}

describe("a fullscreen view in Windows Console Host", () => {
  test("guards every entry point that owns a render loop", () => {
    for (const file of ["tui.ts", "tui-setup.ts", "tui-install.ts"]) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      expect(source).toContain("withConsoleSelectionSuspended(async () =>");
    }
  });

  test("cannot be frozen by entering QuickEdit selection", async () => {
    const original = ENABLE_QUICK_EDIT_MODE | 0x001f;
    const consoleMode = port(original);

    await withConsoleSelectionSuspended(
      async () => {
        expect(consoleMode.read() & ENABLE_QUICK_EDIT_MODE).toBe(0);
        expect(consoleMode.read() & ENABLE_EXTENDED_FLAGS).toBe(ENABLE_EXTENDED_FLAGS);
      },
      "win32",
      async () => consoleMode,
    );

    expect(consoleMode.writes).toEqual([
      (original | ENABLE_EXTENDED_FLAGS) & ~ENABLE_QUICK_EDIT_MODE,
      original,
    ]);
  });

  test("restores the operator's console mode even when the view throws", async () => {
    const original = ENABLE_QUICK_EDIT_MODE | ENABLE_EXTENDED_FLAGS | 0x001f;
    const consoleMode = port(original);

    await expect(
      withConsoleSelectionSuspended(
        async () => {
          throw new Error("render failed");
        },
        "win32",
        async () => consoleMode,
      ),
    ).rejects.toThrow("render failed");

    expect(consoleMode.read()).toBe(original);
    expect(consoleMode.writes.at(-1)).toBe(original);
  });

  test("does not probe a Unix terminal", async () => {
    let opened = false;
    const answer = await withConsoleSelectionSuspended(
      async () => 42,
      "linux",
      async () => {
        opened = true;
        return null;
      },
    );

    expect(answer).toBe(42);
    expect(opened).toBe(false);
  });

  test("does not sacrifice the view when the Console API is unavailable", async () => {
    let closed = false;
    const answer = await withConsoleSelectionSuspended(
      async () => "still rendered",
      "win32",
      async () => ({
        read: () => {
          throw new Error("not a console handle");
        },
        write: () => false,
        close: () => {
          closed = true;
        },
      }),
    );

    expect(answer).toBe("still rendered");
    expect(closed).toBe(true);
  });
});
