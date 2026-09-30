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

import { AGENTS, availableAgents, commandPath, currentAgentKeys } from "./agents.ts";
import { WORKSTATION_APPS, REQUIRED_WORKSTATION_APPS } from "./workstation-lock.ts";
import type { Platform } from "./platform.ts";

describe("retired Gemini CLI installer", () => {
  test("is absent from current CLI and offline installation catalogues", () => {
    expect(AGENTS.some((agent) => agent.key === "gemini")).toBe(false);
    expect(WORKSTATION_APPS.some((app) => app.id === "gemini")).toBe(false);
    expect([...REQUIRED_WORKSTATION_APPS] as string[]).not.toContain("gemini");
    for (const os of ["linux", "windows"] as const) {
      const p: Platform = {
        os, env: os === "linux" ? "desktop" : "windows", arch: "x64",
        distro: null, version: null, codename: null,
        caps: { apt: os === "linux", gui: true, systemd: false, winget: os === "windows", flatpak: false },
      };
      expect(availableAgents(p).some((agent) => agent.key === "gemini")).toBe(false);
    }
  });

  test("drops legacy installer selections while preserving other migrations", () => {
    expect(currentAgentKeys(["gemini", "codex", "opencode", "redcode", "gemini"]))
      .toEqual(["codex", "redcode"]);
    expect(currentAgentKeys(["gemini"])).toEqual([]);
  });
});

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
