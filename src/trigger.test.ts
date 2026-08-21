/**
 * The one distinction the converge never had.
 */

import { describe, expect, test } from "bun:test";
import { attended, deferred, TRIGGER_ENV, triggerEnv, triggerOf } from "./trigger.ts";

describe("who started this run", () => {
  test("a launcher that says so is believed", () => {
    expect(triggerOf({ [TRIGGER_ENV]: "timer" }, false)).toBe("timer");
    expect(triggerOf({ [TRIGGER_ENV]: "task" }, false)).toBe("task");
    // Even against a terminal: a person can run the unit by hand to see
    // what it does, and what it does must not change because they did.
    expect(triggerOf({ [TRIGGER_ENV]: "timer" }, true)).toBe("timer");
  });

  test("a name this build does not know is not trusted into the answer", () => {
    expect(triggerOf({ [TRIGGER_ENV]: "cron" }, false)).toBe("unknown");
    expect(triggerOf({ [TRIGGER_ENV]: "" }, true)).toBe("typed");
  });

  test("without a launcher, a terminal is the only evidence of a person", () => {
    expect(triggerOf({}, true)).toBe("typed");
    expect(triggerOf({}, false)).toBe("unknown");
  });

  test("only a typed command is attended, and unknown never is", () => {
    expect(attended("typed")).toBe(true);
    // The conservative direction: a run that cannot tell defers.
    expect(attended("unknown")).toBe(false);
    for (const t of ["shell", "timer", "task", "mise", "daemon"] as const) {
      expect(attended(t)).toBe(false);
    }
  });

  test("a prompt hook is not attended, though a person is at the keyboard", () => {
    // Detached, all three streams on /dev/null: anything that asked for
    // an answer would wait forever against nobody.
    expect(attended("shell")).toBe(false);
  });

  test("a launcher carries one pair", () => {
    expect(triggerEnv("timer")).toEqual({ RED_DEV_TRIGGER: "timer" });
  });

  test("a refusal names the command that would do it", () => {
    const line = deferred("vscode: no editor to install into", "red-dev install");
    expect(line).toContain("no person is watching");
    expect(line).toContain("`red-dev install`");
  });
});
