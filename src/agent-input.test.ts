import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { convergeOpenCodeInput } from "./terminal-surfaces.ts";
import { mergeWindowsTerminalAgentActions } from "./wsl.ts";

const roots: string[] = [];

function target(name = "tui.json"): string {
  const root = mkdtempSync(`${tmpdir()}/red-dev-agent-input-`);
  roots.push(root);
  return `${root}/${name}`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenCode input convergence", () => {
  test("declares the shared newline and raw-paste contract", async () => {
    const path = target();
    const result = await convergeOpenCodeInput(path);
    const cfg = JSON.parse(readFileSync(path, "utf8"));

    expect(result).toEqual({ input_newline: "wrote", input_paste: "wrote" });
    expect(cfg.keybinds.input_newline).toBe("shift+return,ctrl+return,alt+return,ctrl+j");
    expect(cfg.keybinds.input_paste).toEqual({ key: "ctrl+v", preventDefault: false });
  });

  test("preserves unrelated settings and explicit conflicting bindings", async () => {
    const path = target();
    writeFileSync(path, JSON.stringify({
      attention: { enabled: true },
      keybinds: { input_newline: "ctrl+n", messages_copy: "ctrl+y" },
    }));

    const result = await convergeOpenCodeInput(path);
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    expect(result).toEqual({ input_newline: "conflict", input_paste: "wrote" });
    expect(cfg.attention).toEqual({ enabled: true });
    expect(cfg.keybinds.input_newline).toBe("ctrl+n");
    expect(cfg.keybinds.messages_copy).toBe("ctrl+y");
  });

  test("is idempotent and leaves malformed JSON alone", async () => {
    const path = target();
    await convergeOpenCodeInput(path);
    const before = readFileSync(path, "utf8");
    expect(await convergeOpenCodeInput(path)).toEqual({
      input_newline: "already-set",
      input_paste: "already-set",
    });
    expect(readFileSync(path, "utf8")).toBe(before);

    const malformed = target();
    writeFileSync(malformed, "{ no");
    expect(await convergeOpenCodeInput(malformed)).toEqual({
      input_newline: "malformed",
      input_paste: "malformed",
    });
    expect(readFileSync(malformed, "utf8")).toBe("{ no");
  });
});

describe("Windows Terminal input convergence", () => {
  test("adds Shift+Enter and Alt+V without replacing existing actions", () => {
    const existing = { command: "copy", keys: "ctrl+c", name: "mine" };
    const result = mergeWindowsTerminalAgentActions([existing]);

    expect(result.actions[0]).toBe(existing);
    expect(result.actions).toContainEqual({
      command: { action: "sendInput", input: "\u001b[13;2u" },
      keys: "shift+enter",
    });
    expect(result.actions).toContainEqual({
      command: { action: "sendInput", input: "\u0016" },
      keys: "alt+v",
    });
    expect(result.added).toEqual(["shift+enter", "alt+v"]);
  });

  test("respects user-owned conflicts for either key", () => {
    const actions = [
      { command: "newTab", keys: "shift+enter" },
      { command: "paste", keys: ["alt+v", "ctrl+shift+v"] },
    ];
    const result = mergeWindowsTerminalAgentActions(actions);

    expect(result.actions).toEqual(actions);
    expect(result.added).toEqual([]);
    expect(result.conflicts).toEqual(["shift+enter", "alt+v"]);
  });
});
