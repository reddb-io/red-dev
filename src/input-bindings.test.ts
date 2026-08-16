/**
 * The generated terminal and agent-host configs, pinned byte for byte.
 *
 * Moving the Shift+Enter sequence and the Alt+V gesture into
 * src/actions/input.ts was a move of the source of truth and nothing
 * else: every file red-dev writes had to come out of the change spelled
 * exactly as it went in. A machine that converged before it and one that
 * converges after must produce identical bytes, or the move becomes a
 * silent reconfiguration of every installed machine — a rewritten
 * keys.toml on disk, a settings.json diff nobody asked for, and a drift
 * report full of files that changed for no reason a person could name.
 *
 * So this pins output, not implementation. It calls the four generators
 * and compares what they produce against the content of the day the
 * registry was introduced. The Alacritty half lives in a fixture because
 * it is a seventy-line file and a fixture diffs readably; the three JSON
 * ones are short enough to read here.
 *
 * The escape sequences are written \u001b throughout, never as a raw
 * control byte, for the same reason the modules do it: a literal 0x1b
 * survives an editor and a review and then dies in a copy-paste.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { keysToml } from "./alacritty.ts";
import { convergeClaudeKeybinding } from "./claude-keybindings.ts";
import { convergeOpenCodeInput } from "./terminal-surfaces.ts";
import { mergeWindowsTerminalAgentActions } from "./wsl.ts";

const root = `${import.meta.dir}/..`;

const scratchRoots: string[] = [];

/** A path in a fresh directory, for the two generators that write a file. */
function scratch(name: string): string {
  const dir = mkdtempSync(`${tmpdir()}/red-dev-input-pin-`);
  scratchRoots.push(dir);
  return `${dir}/${name}`;
}

afterAll(() => {
  for (const dir of scratchRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the terminal configs are what they were", () => {
  test("Alacritty's keys.toml is unchanged, comments included", () => {
    // The whole file, not just the two bindings: the comments in it are
    // the only place a person editing keys is warned that the file is
    // rewritten on every converge, and a template that lost one would
    // still pass a test that only looked at the bindings.
    const pinned = readFileSync(`${root}/src/fixtures/alacritty-keys.toml`, "utf8");
    expect(keysToml()).toBe(pinned);
  });

  test("Windows Terminal gets the same two actions, in the same order", () => {
    const { actions, added, conflicts } = mergeWindowsTerminalAgentActions([]);
    expect(JSON.stringify(actions, null, 2)).toBe(`[
  {
    "command": {
      "action": "sendInput",
      "input": "\\u001b[13;2u"
    },
    "keys": "shift+enter"
  },
  {
    "command": {
      "action": "sendInput",
      "input": "\\u0016"
    },
    "keys": "alt+v"
  }
]`);
    expect(added).toEqual(["shift+enter", "alt+v"]);
    expect(conflicts).toEqual([]);
  });
});

describe("the agent-host configs are what they were", () => {
  test("Claude Code's keybindings.json is unchanged", async () => {
    const path = scratch("keybindings.json");
    await convergeClaudeKeybinding(path);
    expect(readFileSync(path, "utf8")).toBe(`{
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "shift+enter": "chat:newline",
        "ctrl+g": null
      }
    }
  ]
}
`);
  });

  test("RedCode's tui.json is unchanged, keys in the same order", async () => {
    // Field order is load-bearing: the file is rewritten from the
    // registry, so a reordered registry would rewrite tui.json on every
    // machine that already has it.
    const path = scratch("tui.json");
    await convergeOpenCodeInput(path);
    expect(readFileSync(path, "utf8")).toBe(`{
  "$schema": "https://opencode.ai/tui.json",
  "keybinds": {
    "input_newline": "shift+return,ctrl+return,alt+return,ctrl+j",
    "input_paste": {
      "key": "ctrl+v",
      "preventDefault": false
    }
  }
}
`);
  });
});
