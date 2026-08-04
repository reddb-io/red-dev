/**
 * Shift+Enter → chat:newline, without stepping on what the user already chose.
 *
 * The five cases worth testing independently:
 *   - no file yet: create it
 *   - already correct: skip without touching the file
 *   - unrelated bindings present: add ours, keep theirs
 *   - explicit conflicting binding: preserve it, report conflict
 *   - malformed JSON: leave the file untouched
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { convergeClaudeKeybinding } from "./claude-keybindings.ts";

function tempPath(): string {
  const dir = mkdtempSync(`${tmpdir()}/claude-kb-`);
  return `${dir}/keybindings.json`;
}

describe("absent file", () => {
  test("creates it with the shift+enter binding", async () => {
    const path = tempPath();
    const outcome = await convergeClaudeKeybinding(path);
    expect(outcome).toBe("wrote");
    const content = JSON.parse(await Bun.file(path).text());
    const chat = content.bindings.find((b: { context?: string }) => b.context === "Chat");
    expect(chat?.bindings?.["shift+enter"]).toBe("chat:newline");
  });
});

describe("already-correct binding", () => {
  test("returns already-set and does not rewrite the file", async () => {
    const path = tempPath();
    const original = JSON.stringify({
      bindings: [{ context: "Chat", bindings: { "shift+enter": "chat:newline" } }],
    });
    await Bun.write(path, original);
    expect(await convergeClaudeKeybinding(path)).toBe("already-set");
    expect(await convergeClaudeKeybinding(path)).toBe("already-set");
    expect(JSON.parse(await Bun.file(path).text()).bindings).toHaveLength(1);
  });
});

describe("unrelated existing bindings", () => {
  test("adds the Chat binding and preserves the other context", async () => {
    const path = tempPath();
    await Bun.write(
      path,
      JSON.stringify({
        bindings: [{ context: "Other", bindings: { "ctrl+k": "other:action" } }],
      }),
    );
    expect(await convergeClaudeKeybinding(path)).toBe("wrote");
    const content = JSON.parse(await Bun.file(path).text());
    const other = content.bindings.find((b: { context?: string }) => b.context === "Other");
    expect(other?.bindings?.["ctrl+k"]).toBe("other:action");
    const chat = content.bindings.find((b: { context?: string }) => b.context === "Chat");
    expect(chat?.bindings?.["shift+enter"]).toBe("chat:newline");
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

  test("adds shift+enter alongside existing Chat bindings", async () => {
    const path = tempPath();
    await Bun.write(
      path,
      JSON.stringify({
        bindings: [{ context: "Chat", bindings: { "ctrl+enter": "submit" } }],
      }),
    );
    expect(await convergeClaudeKeybinding(path)).toBe("wrote");
    const content = JSON.parse(await Bun.file(path).text());
    const chat = content.bindings.find((b: { context?: string }) => b.context === "Chat");
    expect(chat?.bindings?.["ctrl+enter"]).toBe("submit");
    expect(chat?.bindings?.["shift+enter"]).toBe("chat:newline");
  });
});

describe("conflicting explicit binding", () => {
  test("returns conflict and leaves shift+enter untouched", async () => {
    const path = tempPath();
    await Bun.write(
      path,
      JSON.stringify({
        bindings: [{ context: "Chat", bindings: { "shift+enter": "submit" } }],
      }),
    );
    expect(await convergeClaudeKeybinding(path)).toBe("conflict");
    const content = JSON.parse(await Bun.file(path).text());
    const chat = content.bindings.find((b: { context?: string }) => b.context === "Chat");
    expect(chat?.bindings?.["shift+enter"]).toBe("submit");
  });
});

describe("malformed JSON", () => {
  test("returns malformed and does not overwrite the file", async () => {
    const path = tempPath();
    const bad = "not valid json {{{";
    await Bun.write(path, bad);
    expect(await convergeClaudeKeybinding(path)).toBe("malformed");
    expect(await Bun.file(path).text()).toBe(bad);
  });
});
