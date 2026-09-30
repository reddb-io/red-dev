/**
 * A Windows workstation with WSL is two execution environments.
 *
 * Graphical applications belong to Windows. Selected CLI agents and language
 * runtimes are delegated to Linux; redcode remains available on both sides.
 */

import { describe, expect, test } from "bun:test";
import { distroSetupCommands } from "./wsl-sync.ts";

describe("selected tooling sent into WSL", () => {
  test("delegates CLI agents and normalizes legacy runtime selectors", () => {
    expect(
      distroSetupCommands(
        "wsl",
        ["claude-code", "codex", "t3code", "claude-desktop", "codex-desktop"],
        ["node@lts", "python@3.13"],
      ),
    ).toEqual([
      "red-dev lang node@latest,python@latest",
      "red-dev agents claude-code,codex",
    ]);
  });

  test("never sends graphical applications into the distro", () => {
    const commands = distroSetupCommands(
      "wsl",
      ["t3code", "claude-desktop", "codex-desktop"],
      [],
    );
    expect(commands).toEqual([]);
  });

  test("does not touch WSL when Git Bash is the chosen terminal", () => {
    expect(
      distroSetupCommands("gitbash", ["claude-code", "codex"], ["node@lts"]),
    ).toEqual([]);
  });

  test("drops unknown preference values before constructing a shell command", () => {
    expect(
      distroSetupCommands(
        "wsl",
        ["claude-code", "$(touch nope)", "not-an-agent"],
        ["node@lts", "bad; command", "python@latest", "ruby@3.4.7"],
      ),
    ).toEqual([
      "red-dev lang node@latest,python@latest,ruby@latest",
      "red-dev agents claude-code",
    ]);
  });
});
