import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_STATUS_LINE,
  codexConfigPath,
  convergeCodexStatusline,
  withCodexStatusline,
} from "./codex-statusline.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex statusline", () => {
  test("contains project, directory, branch, model with effort, context and both quota windows", () => {
    expect(CODEX_STATUS_LINE).toEqual([
      "project-name",
      "current-dir",
      "git-branch",
      "model-with-reasoning",
      "context-remaining",
      "five-hour-limit",
      "weekly-limit",
    ]);
  });

  test("adds a tui table without changing existing config", () => {
    const before = 'model = "gpt-5.6-sol"\n\n[plugins.dev]\nenabled = true\n';
    const after = withCodexStatusline(before);
    expect(after).toStartWith(before);
    expect(after).toContain("[tui]\nstatus_line = [");
  });

  test("replaces only an existing status line inside tui", () => {
    const before = '[tui]\nanimations = false\nstatus_line = ["thread-id"]\n\n[history]\npersistence = "save-all"\n';
    const after = withCodexStatusline(before);
    expect(after).toContain("animations = false");
    expect(after).toContain('[history]\npersistence = "save-all"');
    expect(after).not.toContain("thread-id");
    expect(after.match(/status_line/g)).toHaveLength(1);
  });

  test("understands the dotted-key spelling and preserves CRLF", () => {
    const after = withCodexStatusline('model = "x"\r\ntui.status_line = ["thread-id"]\r\n');
    expect(after).toContain("\r\ntui.status_line = [");
    expect(after.split("\r\n")).toHaveLength(3);
  });

  test("replaces a multi-line array without leaving orphaned values", () => {
    const after = withCodexStatusline('[tui]\nstatus_line = [\n  "thread-id",\n  "model-name",\n]\nanimations = true\n');
    expect(after.match(/status_line/g)).toHaveLength(1);
    expect(after).not.toContain('  "thread-id",');
    expect(after).toEndWith("animations = true\n");
  });

  test("writes atomically and is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "red-dev-codex-statusline-"));
    roots.push(root);
    const path = join(root, ".codex", "config.toml");
    expect(await convergeCodexStatusline(path)).toBe("written");
    const first = readFileSync(path, "utf8");
    expect(await convergeCodexStatusline(path)).toBe("unchanged");
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  test("uses USERPROFILE when HOME is absent", () => {
    const home = process.env["HOME"];
    const profile = process.env["USERPROFILE"];
    delete process.env["HOME"];
    process.env["USERPROFILE"] = "C:\\Users\\filipe";
    try {
      expect(codexConfigPath()).toBe("C:/Users/filipe/.codex/config.toml");
    } finally {
      if (home === undefined) delete process.env["HOME"];
      else process.env["HOME"] = home;
      if (profile === undefined) delete process.env["USERPROFILE"];
      else process.env["USERPROFILE"] = profile;
    }
  });
});
