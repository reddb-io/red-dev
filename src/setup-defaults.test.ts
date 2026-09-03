/**
 * What the interview arrives pre-answered with.
 *
 * A preset is not a detail: it is the answer most people will give. The
 * optional tools shipped with none of them ticked and a description
 * arguing that empty was a good answer. Curated tools and agents are
 * opt-out; project-specific language toolchains may deliberately start
 * off while remaining one keypress away.
 */

import { describe, expect, test } from "bun:test";
import { AGENTS } from "./agents.ts";
import { preferencesFromAnswers } from "./firstrun.ts";
import { questions, stepAvailable, type Choice, type SetupAnswers } from "./tui-setup-model.ts";
import type { Platform } from "./platform.ts";

const WSL: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "wsl",
  arch: "x64",
  caps: { apt: true, gui: false, systemd: true, winget: true, flatpak: false },
};

const choices = (n: number): Choice[] =>
  Array.from({ length: n }, (_, i) => ({ key: `t${i}`, label: `tool ${i}`, note: "" }));

function step(id: string, apps: Choice[] = choices(3)) {
  const found = questions(WSL, choices(2), apps, choices(2)).find((q) => q.id === id);
  if (!found) throw new Error(`no step '${id}'`);
  return found;
}

describe("the optional tools", () => {
  test("arrive with everything ticked", () => {
    const q = step("apps");
    expect(q.preset).toEqual(q.choices.map((c) => c.key));
  });

  test("include entries whose cost is stated in their label", () => {
    const apps = [
      { key: "just", label: "just", note: "" },
      { key: "blender", label: "blender", note: "1.2 GB" },
    ];
    const q = step("apps", apps);
    expect(q.preset).toEqual(["just", "blender"]);
  });

  test("stay ticked however many there are", () => {
    // preset is computed from the list rather than written out, so a
    // tool added to the manifest is ticked without anyone remembering.
    expect(step("apps", choices(9)).preset).toHaveLength(9);
  });

  test("say the list is the only thing that decides", () => {
    // A plain converge never installs these, so an untouched answer is
    // the whole decision and the description has to say so.
    expect(step("apps").description).toContain("converge");
  });
});

describe("multi-choice defaults", () => {
  test("language runtimes leave Java, Ruby and Go unmarked", () => {
    const runtimes = [
      { key: "node@24", label: "Node", note: "" },
      { key: "bun@1.3", label: "Bun", note: "" },
      { key: "python@3.13", label: "Python", note: "" },
      { key: "go@1.26", label: "Go", note: "" },
      { key: "ruby@3.4", label: "Ruby", note: "" },
      { key: "java@25", label: "Java", note: "" },
    ];
    const q = questions(WSL, choices(2), choices(3), runtimes).find(
      (candidate) => candidate.id === "runtimes",
    );
    expect(q?.preset).toEqual(["node@24", "bun@1.3", "python@3.13"]);
  });

  test("only the recommended agents arrive marked", () => {
    // The one opt-in list in the interview. Everything else red-dev
    // offers is a curated tool it would install anyway; an agent host is
    // another vendor's account and another vendor's network, and a
    // managed machine that quietly installed four of them is a support
    // ticket. Untouched, the answer is the RedDB set and nothing else.
    const agents: Choice[] = [
      { key: "claude-code", label: "Claude Code", note: "", recommended: true },
      { key: "openclaw", label: "OpenClaw", note: "", recommended: false },
      { key: "hermes", label: "Hermes", note: "" },
    ];
    const q = questions(WSL, agents, choices(3), choices(2)).find((c) => c.id === "agents")!;
    expect(q.preset).toEqual(["claude-code"]);
    // Still on the page, one keypress away — hidden would be a different
    // and worse answer than unticked.
    expect(q.choices.map((choice) => choice.key)).toEqual(["claude-code", "openclaw", "hermes"]);
    expect(q.multi).toBe(true);
  });

  test("the page says why the rest are not ticked", () => {
    // A list that arrives mostly empty with no sentence explaining it
    // reads like the machine failed to detect anything.
    expect(step("agents").description).toContain("managed machines");
  });

  test("what red-dev recommends is the RedDB set, and nothing of anyone else's", () => {
    // Read off the catalogue rather than restated: a host that becomes
    // recommended later moves this test with it.
    expect(AGENTS.filter((a) => a.recommended).map((a) => a.key)).toEqual([
      "claude-code",
      "codex",
      "redcode",
    ]);
    for (const key of ["openclaw", "hermes", "gemini", "muse", "pi", "oh-my-pi"]) {
      expect(AGENTS.find((a) => a.key === key)?.recommended, key).toBe(false);
    }
  });
});

describe("the wallpaper", () => {
  test("follows the theme by default and offers every Red artwork", () => {
    const q = step("wallpaper");
    expect(q.preset).toEqual(["theme"]);
    expect(q.choices.map((choice) => choice.key)).toEqual([
      "theme",
      "dark",
      "light",
      "obsidian",
      "marble",
      "cobalt",
      "flare",
    ]);
  });

  test("offers to keep the desktop's own image, only when there is one", () => {
    // The desktop's image is a fact observed before the questions are
    // built. With one, "keep it" sits right under the default; without
    // one there is nothing to keep and the row is not drawn — a choice
    // that would resolve to nothing is not a choice.
    const withOne = questions(WSL, choices(2), choices(3), choices(2), [], [], {
      currentWallpaper: "img0.jpg",
    }).find((q) => q.id === "wallpaper")!;
    expect(withOne.choices.map((choice) => choice.key).slice(0, 3)).toEqual([
      "theme",
      "current",
      "dark",
    ]);
    expect(withOne.choices[1]?.note).toContain("img0.jpg");
    expect(withOne.choices[1]?.note).toContain("Redwall");
    expect(withOne.preset).toEqual(["theme"]);

    expect(step("wallpaper").choices.map((choice) => choice.key)).not.toContain("current");
    const none = questions(WSL, choices(2), choices(3), choices(2), [], [], {
      currentWallpaper: null,
    }).find((q) => q.id === "wallpaper")!;
    expect(none.choices.map((choice) => choice.key)).not.toContain("current");
  });
});

describe("the RedSkills plugins", () => {
  const skillHost = AGENTS.find((agent) => !agent.desktopOnly && !agent.multiplexer)!.key;
  const desktopHost = AGENTS.find((agent) => agent.desktopOnly)!.key;
  const withAgents = (selected: string[]) => (id: string): string[] =>
    id === "agents" ? selected : [];

  test("arrive with dev on and memory and brain off", () => {
    const q = step("redskills");
    expect(q.multi).toBe(true);
    expect(q.choices.map((choice) => choice.key)).toEqual(["dev", "memory", "brain"]);
    expect(q.preset).toEqual(["dev"]);
  });

  test("say what off means", () => {
    // The reason memory and brain start off is that each acts on every
    // session of a host it is installed into; the description has to
    // say that off means not installed — no hooks, no MCP.
    expect(step("redskills").description).toContain("hooks");
    expect(step("redskills").description).toContain("not installed");
  });

  test("are asked only when a picked host takes skills", () => {
    const q = step("redskills");
    expect(stepAvailable(q, withAgents([skillHost]))).toBe(true);
    expect(stepAvailable(q, withAgents([skillHost, desktopHost]))).toBe(true);
    expect(stepAvailable(q, withAgents([desktopHost]))).toBe(false);
    expect(stepAvailable(q, withAgents([]))).toBe(false);
  });

  test("sit right after the hosts they go into", () => {
    const order = questions(WSL, choices(2), choices(3), choices(2)).map((q) => q.id);
    expect(order.indexOf("agents")).toBeLessThan(order.indexOf("redskills"));
    expect(order.indexOf("redskills")).toBeLessThan(order.indexOf("runtimes"));
  });

  test("the answer is recorded, and an unasked question leaves the record alone", () => {
    const base: SetupAnswers = {
      theme: "dark",
      font: "firacode",
      apps: [],
      runtimes: [],
      agents: [],
      blesh: true,
      redwall: true,
      share: false,
      completed: true,
    };
    expect(preferencesFromAnswers({ ...base, redSkillsPlugins: ["dev", "memory"] }).redSkillsPlugins)
      .toEqual(["dev", "memory"]);
    // Absent, not undefined: writePreferences merges, and a key present
    // and undefined would erase what an earlier interview recorded.
    expect("redSkillsPlugins" in preferencesFromAnswers(base)).toBe(false);
  });
});

describe("ble.sh", () => {
  test("is a plugin rather than a step of its own", () => {
    // It was one question at the same level as Theme and Runtimes,
    // which left nowhere to put the next thing that plugs into bash.
    const q = step("plugins");
    expect(q.multi).toBe(true);
    expect(q.choices.map((c) => c.key)).toContain("blesh");
  });

  test("no longer has its own step", () => {
    expect(questions(WSL, choices(2), choices(3), choices(2)).map((q) => q.id)).not.toContain(
      "blesh",
    );
  });

  test("arrives ticked and can be opted out", () => {
    const q = step("plugins");
    expect(q.preset).toEqual(q.choices.map((choice) => choice.key));
  });
});
