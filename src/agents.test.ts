/**
 * Resolving a command to something the operating system can run.
 *
 * On Windows the extension is not decoration: a VS Code install puts
 * both `code` — a shell script for Git Bash, which Windows itself
 * cannot execute — and `code.cmd` in one directory, and a PATH lookup
 * lists the script first. Taking the first match is taking the wrong
 * one exactly when both exist.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { commandPath } from "./agents.ts";

describe("resolving a command on Windows", () => {
  test("prefers an extension the OS can execute over one it cannot", () => {
    // Measured: the VS Code extension step failed with `ENOENT: no such
    // file or directory` while `code` was on PATH and working, because
    // what red-dev had resolved was the bash script beside it.
    const source = readFileSync(new URL("./agents.ts", import.meta.url), "utf8");
    const fn = source.slice(source.indexOf("export function commandPath("));

    expect(fn).toContain('platform !== "win32"');
    // In this order: `.cmd` and `.exe` are what a Windows PATH lookup
    // runs, and the bare name stays last so nothing that worked stops.
    expect(fn.indexOf('".cmd"')).toBeLessThan(fn.indexOf('".exe"'));
    expect(fn.indexOf('".exe"')).toBeLessThan(fn.indexOf('""]'));
  });

  test("answers null for something that is not there, on either platform", () => {
    expect(commandPath("definitely-not-a-real-command-xyz", "linux")).toBeNull();
    expect(commandPath("definitely-not-a-real-command-xyz", "win32")).toBeNull();
  });

  test("still finds an ordinary command where an extension means nothing", () => {
    expect(commandPath("sh", "linux")).not.toBeNull();
  });
});
