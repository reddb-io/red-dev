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
import { questions, type Choice } from "./tui-setup-model.ts";
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
      { key: "node@lts", label: "Node", note: "" },
      { key: "bun@latest", label: "Bun", note: "" },
      { key: "python@3.13", label: "Python", note: "" },
      { key: "go@latest", label: "Go", note: "" },
      { key: "ruby@3.4", label: "Ruby", note: "" },
      { key: "java@lts", label: "Java", note: "" },
    ];
    const q = questions(WSL, choices(2), choices(3), runtimes).find(
      (candidate) => candidate.id === "runtimes",
    );
    expect(q?.preset).toEqual(["node@lts", "bun@latest", "python@3.13"]);
  });

  test("all agents arrive marked", () => {
    const q = step("agents");
    expect(q.preset).toEqual(q.choices.map((choice) => choice.key));
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
