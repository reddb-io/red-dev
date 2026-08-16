/**
 * The Default agent: chosen, recorded, reported.
 *
 * The four things that have to stay true are the four ways this goes
 * wrong. One host must not produce a question nobody needed. Several
 * hosts must not produce an answer nobody gave. A host that has been
 * uninstalled must be named, not replaced. And the recorded answer must
 * survive the next converge, which rewrites the file it lives in.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { AGENTS, type AgentSpec } from "./agents.ts";
import {
  defaultAgentCandidates,
  defaultAgentFrom,
  impliedDefaultAgent,
  needsDefaultAgentChoice,
  readDefaultAgent,
  reportDefaultAgent,
} from "./default-agent.ts";
import { checkDefaultAgent } from "./drift.ts";
import { preferencesFromAnswers } from "./firstrun.ts";
import type { Platform } from "./platform.ts";
import { readPreferences, writePreferences } from "./preferences.ts";
import { questions, stepChoices, stepAvailable, type SetupAnswers } from "./tui-setup-model.ts";

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
async function onFreshMachine<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env["HOME"];
  const home = mkdtempSync(`${tmpdir()}/red-dev-default-agent-`);
  process.env["HOME"] = home;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

/** The interview's Default step, built over the real host catalog. */
function defaultStep(selected: string[]) {
  const hosts = AGENTS.filter((agent) => agent.cmd.length > 0).map((agent) => ({
    key: agent.key,
    label: agent.label,
    note: agent.about,
  }));
  const step = questions(LINUX, hosts, [], []).find((q) => q.id === "default-agent");
  if (!step) throw new Error("no 'default-agent' step");
  const picked = (id: string): string[] => (id === "agents" ? selected : []);
  return {
    shown: stepAvailable(step, picked),
    choices: stepChoices(step, picked).map((choice) => choice.key),
    step,
  };
}

function answers(overrides: Partial<SetupAnswers> = {}): SetupAnswers {
  return {
    theme: "dark",
    font: "firacode",
    apps: [],
    runtimes: [],
    agents: [],
    blesh: false,
    redwall: true,
    share: false,
    completed: true,
    ...overrides,
  };
}

const installed = (...keys: string[]) => (agent: AgentSpec): boolean => keys.includes(agent.key);

describe("one CLI host", () => {
  test("is the Default agent without being asked about", () => {
    expect(impliedDefaultAgent(["claude-code"])).toBe("claude-code");
    expect(needsDefaultAgentChoice(["claude-code"])).toBe(false);
  });

  test("closes the question in the interview rather than posing it", () => {
    // Not "the step is answered for you" — the step is not drawn at
    // all. A one-answer question is a keypress asking for nothing.
    expect(defaultStep(["claude-code"]).shown).toBe(false);
  });

  test("is still the one host when the rest of the selection cannot answer prompts", () => {
    // Claude Desktop has no command and Herdr runs agents rather than
    // being one, so neither makes this a choice.
    expect(impliedDefaultAgent(["claude-code", "claude-desktop", "herdr"])).toBe("claude-code");
    expect(defaultStep(["claude-code", "herdr"]).shown).toBe(false);
  });

  test("is settled the same way whichever name the selection was recorded under", () => {
    // OpenCode was renamed RedCode; a selection recorded before that is
    // one host, not an unknown one.
    expect(impliedDefaultAgent(["opencode"])).toBe("redcode");
  });
});

describe("several CLI hosts", () => {
  test("require an explicit choice", () => {
    expect(needsDefaultAgentChoice(["claude-code", "codex"])).toBe(true);
    expect(impliedDefaultAgent(["claude-code", "codex"])).toBeNull();
  });

  test("leave the Default agent unset until someone answers", () => {
    // The failure this pins is a silent first-in-the-list default,
    // which records the same value whether or not anyone was asked.
    expect(defaultAgentFrom(["claude-code", "codex"])).toBeUndefined();
    expect(defaultAgentFrom(["claude-code", "codex"], "codex")).toBe("codex");
  });

  test("do not accept an answer that is not one of them", () => {
    expect(defaultAgentFrom(["claude-code", "codex"], "gemini")).toBeUndefined();
  });

  test("are the interview's choices, and nothing else on the catalog", () => {
    const step = defaultStep(["claude-code", "codex"]);
    expect(step.shown).toBe(true);
    expect(step.choices).toEqual(["claude-code", "codex"]);
  });

  test("are asked about immediately after the hosts", () => {
    const ids = questions(LINUX, [{ key: "claude-code", label: "Claude Code", note: "" }], [], [])
      .map((step) => step.id);
    expect(ids[ids.indexOf("agents") + 1]).toBe("default-agent");
  });

  test("narrowing back to one drops the question and the stale answer with it", () => {
    // Someone who answers, goes back and unticks a host has not chosen
    // the one they removed.
    expect(defaultAgentFrom(["claude-code"], "codex")).toBe("claude-code");
  });
});

describe("a stored Default agent that is no longer installed", () => {
  test("is reported under its own name", () => {
    const reading = readDefaultAgent("claude-code", installed("codex"));
    expect(reading.state).toBe("absent");
    expect(reading.key).toBe("claude-code");
  });

  test("is never silently re-chosen as the host that is still there", () => {
    const reading = readDefaultAgent("claude-code", installed("codex", "redcode"));
    const report = reportDefaultAgent(reading, ["claude-code", "codex", "redcode"]);
    expect(report.status).toBe("drift");
    expect(report.detail).toContain("Claude Code");
    expect(report.detail).not.toContain("Codex");
    expect(report.detail).not.toContain("RedCode");
  });

  test("is reported by doctor, with the host it is still waiting for", async () => {
    await onFreshMachine(async () => {
      await writePreferences(LINUX, {
        agents: ["claude-code", "codex"],
        defaultAgent: "claude-code",
      });
      const check = await checkDefaultAgent(LINUX, installed("codex"));
      expect(check.status).toBe("drift");
      expect(check.detail).toContain("Claude Code");
      expect(check.fix).toContain("red-dev agents claude-code");
    });
  });

  test("is distinguished from a record that names nothing red-dev knows", () => {
    const reading = readDefaultAgent("kubernetes", installed("codex"));
    expect(reading.state).toBe("unknown");
    expect(reportDefaultAgent(reading, ["codex"]).status).toBe("drift");
  });

  test("is not the same as never having chosen one", () => {
    // Unset is a legitimate state, so doctor does not report a fault
    // for a question this machine was never asked.
    expect(readDefaultAgent(undefined, installed("codex")).state).toBe("unset");
    expect(reportDefaultAgent(readDefaultAgent(undefined, () => true), []).status).toBe("n/a");
    expect(
      reportDefaultAgent(readDefaultAgent("  ", () => true), ["claude-code", "codex"]).status,
    ).toBe("n/a");
  });
});

describe("the recorded choice", () => {
  test("survives a converge and is readable by doctor", async () => {
    await onFreshMachine(async () => {
      await writePreferences(
        LINUX,
        preferencesFromAnswers(
          answers({ agents: ["claude-code", "codex"], defaultAgent: "codex" }),
        ),
      );

      // What a converge does to this file: rewrite the answers it knows
      // about. An interview that settled on nothing must not take the
      // recorded host down with it.
      await writePreferences(
        LINUX,
        preferencesFromAnswers(answers({ theme: "cobalt", agents: ["claude-code", "codex"] })),
      );

      expect((await readPreferences(LINUX)).defaultAgent).toBe("codex");
      const check = await checkDefaultAgent(LINUX, installed("claude-code", "codex"));
      expect(check.status).toBe("ok");
      expect(check.detail).toContain("Codex CLI");
      expect(check.detail).toContain("codex");
    });
  });

  test("is what the interview writes down when the selection settles it alone", () => {
    const prefs = preferencesFromAnswers(
      answers({ agents: ["claude-code"], defaultAgent: "claude-code" }),
    );
    expect(prefs.defaultAgent).toBe("claude-code");
  });

  test("is absent from a write that has nothing to say about it", () => {
    // Present-and-undefined would erase the stored value on merge,
    // which is the same bug as choosing a replacement, arrived at by
    // accident.
    expect("defaultAgent" in preferencesFromAnswers(answers({ agents: ["a", "b"] }))).toBe(false);
  });
});

describe("the hosts a Default agent may be", () => {
  test("exclude desktop applications and the multiplexer", () => {
    const keys = defaultAgentCandidates(AGENTS.map((agent) => agent.key)).map((a) => a.key);
    expect(keys).toContain("claude-code");
    expect(keys).not.toContain("claude-desktop");
    expect(keys).not.toContain("codex-desktop");
    expect(keys).not.toContain("t3code");
    expect(keys).not.toContain("herdr");
  });
});
