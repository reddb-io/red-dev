/**
 * Shift+Enter → chat:newline and Ctrl+G unbound, without stepping on what
 * the user already chose.
 *
 * The cases worth testing independently:
 *   - no file yet: create it with both managed keys
 *   - already correct: skip without touching the file
 *   - unrelated bindings present: add ours, keep theirs
 *   - explicit conflicting binding: preserve it, report conflict for that key
 *     alone while the other key still converges
 *   - null is a value, not an absence: an explicit "ctrl+g": null already
 *     satisfies the unbind rather than being rewritten
 *   - malformed JSON: leave the file untouched
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { convergeClaudeKeybinding, type ConvergeResult } from "./claude-keybindings.ts";

function tempPath(): string {
  const dir = mkdtempSync(`${tmpdir()}/claude-kb-`);
  return `${dir}/keybindings.json`;
}

async function chatOf(path: string): Promise<Record<string, string | null>> {
  const content = JSON.parse(await Bun.file(path).text());
  const chat = content.bindings.find((b: { context?: string }) => b.context === "Chat");
  return chat?.bindings ?? {};
}

describe("absent file", () => {
  test("creates it with both managed bindings", async () => {
    const path = tempPath();
    const outcome = await convergeClaudeKeybinding(path);
    expect(outcome).toEqual({ "shift+enter": "wrote", "ctrl+g": "wrote" });
    const chat = await chatOf(path);
    expect(chat["shift+enter"]).toBe("chat:newline");
    expect(chat["ctrl+g"]).toBeNull();
  });

  test("writes ctrl+g as a present key, not an omitted one", async () => {
    const path = tempPath();
    await convergeClaudeKeybinding(path);
    expect(Object.keys(await chatOf(path))).toContain("ctrl+g");
  });
});

describe("already-correct bindings", () => {
  test("returns already-set and does not rewrite the file", async () => {
    const path = tempPath();
    await Bun.write(
      path,
      JSON.stringify({
        bindings: [{ context: "Chat", bindings: { "shift+enter": "chat:newline", "ctrl+g": null } }],
      }),
    );
    const expected: ConvergeResult = { "shift+enter": "already-set", "ctrl+g": "already-set" };
    expect(await convergeClaudeKeybinding(path)).toEqual(expected);
    expect(await convergeClaudeKeybinding(path)).toEqual(expected);
    expect(JSON.parse(await Bun.file(path).text()).bindings).toHaveLength(1);
  });

  test("an explicit null already satisfies the ctrl+g unbind", async () => {
    const path = tempPath();
    await Bun.write(
      path,
      JSON.stringify({ bindings: [{ context: "Chat", bindings: { "ctrl+g": null } }] }),
    );
    const outcome = await convergeClaudeKeybinding(path);
    expect(outcome["ctrl+g"]).toBe("already-set");
    expect(outcome["shift+enter"]).toBe("wrote");
  });
});

describe("unrelated existing bindings", () => {
  test("adds the Chat bindings and preserves the other context", async () => {
    const path = tempPath();
    await Bun.write(
      path,
      JSON.stringify({
        bindings: [{ context: "Other", bindings: { "ctrl+k": "other:action" } }],
      }),
    );
    expect(await convergeClaudeKeybinding(path)).toEqual({
      "shift+enter": "wrote",
      "ctrl+g": "wrote",
    });
    const content = JSON.parse(await Bun.file(path).text());
    const other = content.bindings.find((b: { context?: string }) => b.context === "Other");
    expect(other?.bindings?.["ctrl+k"]).toBe("other:action");
    const chat = await chatOf(path);
    expect(chat["shift+enter"]).toBe("chat:newline");
    expect(chat["ctrl+g"]).toBeNull();
  });

  test("preserves top-level fields like $schema", async () => {
    const path = tempPath();
    await Bun.write(
      path,
      JSON.stringify({
        $schema: "https://www.schemastore.org/claude-code-keybindings.json",
        bindings: [],
      }),
    );
    await convergeClaudeKeybinding(path);
    const content = JSON.parse(await Bun.file(path).text());
    expect(content.$schema).toBe("https://www.schemastore.org/claude-code-keybindings.json");
  });

  test("adds ours alongside existing Chat bindings", async () => {
    const path = tempPath();
    await Bun.write(
      path,
      JSON.stringify({
        bindings: [{ context: "Chat", bindings: { "ctrl+enter": "submit" } }],
      }),
    );
    expect(await convergeClaudeKeybinding(path)).toEqual({
      "shift+enter": "wrote",
      "ctrl+g": "wrote",
    });
    const chat = await chatOf(path);
    expect(chat["ctrl+enter"]).toBe("submit");
    expect(chat["shift+enter"]).toBe("chat:newline");
    expect(chat["ctrl+g"]).toBeNull();
  });
});

describe("conflicting explicit binding", () => {
  test("reports conflict for shift+enter and leaves it untouched", async () => {
    const path = tempPath();
    await Bun.write(
      path,
      JSON.stringify({
        bindings: [{ context: "Chat", bindings: { "shift+enter": "submit" } }],
      }),
    );
    const outcome = await convergeClaudeKeybinding(path);
    expect(outcome["shift+enter"]).toBe("conflict");
    expect((await chatOf(path))["shift+enter"]).toBe("submit");
  });

  test("a conflict on one key does not block the other", async () => {
    const path = tempPath();
    await Bun.write(
      path,
      JSON.stringify({
        bindings: [{ context: "Chat", bindings: { "shift+enter": "submit" } }],
      }),
    );
    const outcome = await convergeClaudeKeybinding(path);
    expect(outcome["ctrl+g"]).toBe("wrote");
    expect((await chatOf(path))["ctrl+g"]).toBeNull();
  });

  test("a ctrl+g the user bound on purpose is kept", async () => {
    const path = tempPath();
    await Bun.write(
      path,
      JSON.stringify({
        bindings: [{ context: "Chat", bindings: { "ctrl+g": "chat:externalEditor" } }],
      }),
    );
    const outcome = await convergeClaudeKeybinding(path);
    expect(outcome["ctrl+g"]).toBe("conflict");
    expect((await chatOf(path))["ctrl+g"]).toBe("chat:externalEditor");
  });
});

describe("malformed JSON", () => {
  test("returns malformed for every key and does not overwrite the file", async () => {
    const path = tempPath();
    const bad = "not valid json {{{";
    await Bun.write(path, bad);
    expect(await convergeClaudeKeybinding(path)).toEqual({
      "shift+enter": "malformed",
      "ctrl+g": "malformed",
    });
    expect(await Bun.file(path).text()).toBe(bad);
  });
});
