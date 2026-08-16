/**
 * A crash handed over, and the three ways that goes wrong.
 *
 * It goes wrong by arriving empty — an agent told "red-dev crashed" and
 * left to ask the person for the stack, the run and the machine, which
 * is the whole failure this exists to remove. It goes wrong by nagging:
 * an offer that comes back after the person has already said no. And it
 * goes wrong by assuming an agent — a machine with none must still
 * capture the crash, because red-dev is usable with no agent at all and
 * "install one" is not an answer to "it crashed".
 *
 * So the tests below pin the brief's contents rather than that a brief
 * was produced, and pin the decline across a real preferences file
 * rather than across one call.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { LaunchTarget } from "./agent-launch.ts";
import { recordCrash, type CrashCapture } from "./crash.ts";
import {
  crashBrief,
  crashHandoffDeclined,
  offerCrashHandoff,
  planCrashHandoff,
  productSkillPointer,
  type CrashEvidence,
  type CrashHandoffDeps,
} from "./crash-handoff.ts";
import type { Platform } from "./platform.ts";
import { summary } from "./platform.ts";
import { readPreferences, writePreferences } from "./preferences.ts";
import { PRODUCT_SKILL_NAME } from "./product-skill.ts";

const LINUX: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

/** A machine with no preferences on it, torn down with the test. */
async function onFreshMachine<T>(run: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env["HOME"];
  const home = mkdtempSync(`${tmpdir()}/red-dev-crash-handoff-`);
  process.env["HOME"] = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

function capture(over: Partial<CrashCapture> = {}): CrashCapture {
  return {
    path: "/home/someone/.local/state/red-dev/crash.log",
    kind: "uncaughtException",
    entry:
      "\n=== 2026-08-16T01:00:00.000Z uncaughtException red-dev 1.0.26 linux ===\n" +
      "TypeError: undefined is not a function\n" +
      "    at applyProvider (src/providers.ts:120:9)\n",
    ...over,
  };
}

function evidence(over: Partial<CrashEvidence> = {}): CrashEvidence {
  return {
    version: "1.0.26",
    capture: capture(),
    transcript: "/home/someone/.local/state/red-dev/2026-08-16T01-00-00-install.log",
    census: summary(LINUX),
    skill: `/home/someone/.claude/skills/${PRODUCT_SKILL_NAME}/SKILL.md`,
    ...over,
  };
}

/** PATH with exactly the named commands on it. */
function locate(...commands: string[]): (command: string) => string | null {
  return (command) => (commands.includes(command) ? `/usr/bin/${command}` : null);
}

function deps(over: Partial<CrashHandoffDeps> = {}): CrashHandoffDeps {
  return {
    prefs: { defaultAgent: "claude-code", agents: ["claude-code", "codex"] },
    locate: locate("claude"),
    interactive: true,
    ask: async () => false,
    remember: async () => {},
    start: async () => 0,
    ...over,
  };
}

describe("the brief", () => {
  test("carries the crash, the run, the machine and the skill", () => {
    const e = evidence();
    const brief = crashBrief(e);

    // The four pieces of evidence, each named where it actually is.
    // An agent that has to ask for any of them is back to diagnosing
    // from a re-description, which is the failure this removes.
    expect(brief).toContain(e.capture.path);
    expect(brief).toContain("TypeError: undefined is not a function");
    expect(brief).toContain("at applyProvider (src/providers.ts:120:9)");
    expect(brief).toContain(e.transcript!);
    expect(brief).toContain("os=linux distro=ubuntu version=24.04 env=desktop arch=x64");
    expect(brief).toContain("caps: apt=1 gui=1 systemd=1 winget=0 flatpak=1");
    expect(brief).toContain(PRODUCT_SKILL_NAME);
    expect(brief).toContain(e.skill!);

    // And it says which build died, so a brief pasted anywhere still
    // identifies itself.
    expect(brief).toContain("red-dev 1.0.26 crashed");
    expect(brief).toContain("uncaughtException");
  });

  test("says so rather than naming a file that is not there", () => {
    const brief = crashBrief(evidence({ transcript: null, skill: null }));
    expect(brief).toContain("No transcript was open");
    expect(brief).toContain(`The \`${PRODUCT_SKILL_NAME}\` skill is not installed`);
    // A pointer at a document the agent cannot open is worse than none.
    expect(brief).not.toContain("SKILL.md");
  });

  test("carries the end of a deep stack and the path to the rest", () => {
    const frames = Array.from({ length: 90 }, (_, i) => `    at frame${i} (src/x.ts:${i}:1)`);
    const brief = crashBrief(
      evidence({
        capture: capture({ entry: `\n=== header ===\nError: deep\n${frames.join("\n")}\n` }),
      }),
    );

    expect(brief).toContain("at frame89");
    expect(brief).not.toContain("at frame0 ");
    expect(brief).toContain("the full stack is in that file");
  });

  test("points at the skill home the skill is actually written to", () => {
    expect(productSkillPointer("claude-code", "/home/someone")).toBe(
      `/home/someone/.claude/skills/${PRODUCT_SKILL_NAME}/SKILL.md`,
    );
    expect(productSkillPointer("codex", "C:\\Users\\someone")).toBe(
      `C:/Users/someone/.codex/skills/${PRODUCT_SKILL_NAME}/SKILL.md`,
    );
    // A host red-dev does not write the skill into, and a machine with
    // no home to resolve against.
    expect(productSkillPointer("gemini", "/home/someone")).toBeNull();
    expect(productSkillPointer("claude-code", null)).toBeNull();
  });
});

describe("declining", () => {
  test("is recorded the moment it is answered", async () => {
    const written: { crashHandoff: boolean }[] = [];
    const outcome = await offerCrashHandoff(
      evidence(),
      deps({ ask: async () => false, remember: async (patch) => void written.push(patch) }),
    );

    expect(outcome.state).toBe("declined");
    expect(written).toEqual([{ crashHandoff: false }]);
  });

  test("is honoured on the next run, and the host is never resolved", async () => {
    await onFreshMachine(async () => {
      // The first crash: asked, declined, and the answer written to the
      // same preferences file every other choice lives in.
      const first = await offerCrashHandoff(
        evidence(),
        deps({
          ask: async () => false,
          remember: (patch) => writePreferences(LINUX, patch),
        }),
      );
      expect(first.state).toBe("declined");
      expect((await readPreferences(LINUX)).crashHandoff).toBe(false);

      // A converge between the two crashes rewrites the file. The
      // decline has to survive that, or it is remembered for as long as
      // nobody uses the tool.
      await writePreferences(LINUX, { theme: "cobalt", defaultAgent: "claude-code" });

      // The second crash: nothing asked, nothing started, and no host
      // even looked for — a machine whose owner said no does not get
      // its PATH searched at every crash.
      let asked = 0;
      let started = 0;
      let located = 0;
      const second = await offerCrashHandoff(
        evidence(),
        deps({
          prefs: await readPreferences(LINUX),
          locate: (command) => (located++, locate("claude")(command)),
          ask: async () => (asked++, true),
          start: async () => (started++, 0),
        }),
      );

      expect(second).toEqual({
        state: "silent",
        reason: "the offer was declined once and is not made again",
      });
      expect([asked, started, located]).toEqual([0, 0, 0]);
      expect(crashHandoffDeclined(await readPreferences(LINUX))).toBe(true);
    });
  });

  test("is a decision, and a session nobody is watching is not", async () => {
    const plan = planCrashHandoff("brief", { defaultAgent: "claude-code" }, {
      locate: locate("claude"),
      interactive: false,
    });
    expect(plan).toEqual({ state: "silent", reason: "nobody to ask on a non-interactive run" });

    // Nothing is recorded for it either: a crash in CI must not answer
    // on behalf of the person who owns the machine.
    const written: unknown[] = [];
    const outcome = await offerCrashHandoff(
      evidence(),
      deps({ interactive: false, remember: async (patch) => void written.push(patch) }),
    );
    expect(outcome.state).toBe("silent");
    expect(written).toEqual([]);
  });
});

describe("a machine with no Default agent", () => {
  test("captures the crash and makes no offer", async () => {
    const dir = mkdtempSync(`${tmpdir()}/red-dev-crash-`);
    try {
      const said: string[] = [];
      const recorded = recordCrash("uncaughtException", new Error("boom"), {
        dir,
        version: "1.0.26",
        platform: "linux",
        at: new Date("2026-08-16T01:00:00.000Z"),
        say: (text) => said.push(text),
      });

      // Captured: the file is on disk with the stack in it, exactly as
      // it is on a machine that has every agent installed.
      expect(recorded.path).toBe(`${dir}/crash.log`);
      const written = readFileSync(recorded.path, "utf8");
      expect(written).toContain("uncaughtException red-dev 1.0.26 linux");
      expect(written).toContain("Error: boom");
      expect(said.join()).toContain(`recorded to ${recorded.path}`);

      // And no offer: nothing asked, nothing started, and the reason is
      // the same sentence doctor prints for an unset Default agent.
      let asked = 0;
      let started = 0;
      const outcome = await offerCrashHandoff(
        evidence({ capture: recorded, skill: null }),
        deps({
          prefs: { agents: ["claude-code", "codex"] },
          ask: async () => (asked++, true),
          start: async () => (started++, 0),
        }),
      );

      expect(outcome.state).toBe("silent");
      expect(outcome).toMatchObject({ reason: expect.stringContaining("not chosen") });
      expect([asked, started]).toEqual([0, 0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("says nothing about agents when the recorded one is gone", async () => {
    const outcome = await offerCrashHandoff(
      evidence(),
      deps({
        prefs: { defaultAgent: "claude-code", agents: ["claude-code"] },
        locate: locate(),
      }),
    );
    expect(outcome).toEqual({
      state: "silent",
      reason: "Claude Code is recorded and no longer installed",
    });
  });
});

describe("handing it over", () => {
  test("starts the recorded host with the brief and nothing of red-dev's", async () => {
    const started: LaunchTarget[] = [];
    const questions: string[] = [];
    const outcome = await offerCrashHandoff(
      evidence(),
      deps({
        ask: async (question) => (questions.push(question), true),
        start: async (target) => (started.push(target), 0),
      }),
    );

    expect(outcome).toEqual({ state: "handed", key: "claude-code", label: "Claude Code" });
    expect(questions).toEqual(["Hand this crash to Claude Code to diagnose?"]);

    const target = started[0]!;
    // The brief is the prompt, and it is the only thing on the command
    // line: what red-dev contributes stays empty, which is the promise
    // agent-launch.ts guards.
    expect(target.added).toEqual([]);
    expect(target.argv[0]).toBe("/usr/bin/claude");
    expect(target.argv).toHaveLength(2);
    expect(target.argv[1]).toContain("crashed on this machine");
    expect(target.argv[1]).toContain(PRODUCT_SKILL_NAME);
  });

  test("accepting one crash is not a standing answer for the next", async () => {
    const written: unknown[] = [];
    await offerCrashHandoff(
      evidence(),
      deps({ ask: async () => true, remember: async (patch) => void written.push(patch) }),
    );
    expect(written).toEqual([]);
  });

  test("a host that will not start is reported, not thrown", async () => {
    const outcome = await offerCrashHandoff(
      evidence(),
      deps({
        ask: async () => true,
        start: async () => {
          throw new Error("spawn claude ENOENT");
        },
      }),
    );
    expect(outcome).toEqual({ state: "failed", reason: "spawn claude ENOENT" });
  });
});
