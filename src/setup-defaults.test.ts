/**
 * What the interview arrives pre-answered with.
 *
 * A preset is not a detail: it is the answer most people will give. The
 * optional tools shipped with none of them ticked and a description
 * arguing that empty was a good answer, which is true for a list you
 * have to evaluate one by one and wrong for a curated one — the whole
 * premise of an omakase setup is that somebody already chose.
 *
 * ble.sh is the deliberate exception, and it needs to stay one: it
 * replaces the line editor that atuin, fzf and carapace bind into, and
 * whether they survive it has never been confirmed from a real terminal.
 */

import { describe, expect, test } from "bun:test";
import { questions, type Choice } from "./tui-setup-model.ts";
import { TOOLS } from "./manifest.ts";
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

  test("except what declares itself too large to be a default", () => {
    // Blender is 1.2 GB. A curated list is a set of answers, but not
    // one that hands somebody a gigabyte for pressing enter.
    const apps = [
      { key: "just", label: "just", note: "" },
      { key: "blender", label: "blender", note: "", off: true },
    ];
    const q = step("apps", apps);
    expect(q.choices.map((c) => c.key)).toContain("blender");
    expect(q.preset).toEqual(["just"]);
  });

  test("and the manifest is where that is declared", () => {
    // Not a name hardcoded in the interview: the cost and the exception
    // live in the same place, so the next heavy tool needs no UI change.
    const blender = TOOLS.find((t) => t.name === "blender");
    expect(blender?.offByDefault).toBe(true);
    expect(TOOLS.filter((t) => t.offByDefault).map((t) => t.name)).toEqual(["blender"]);
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

  test("is the one thing here that is not ticked", () => {
    // Deliberate, and the reason is empirical rather than taste: it
    // replaces the line editor atuin, fzf and carapace bind into.
    expect(step("plugins").preset).toEqual([]);
  });
});
