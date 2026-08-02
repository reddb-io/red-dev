/**
 * The two extensions the red-skills installer leaves behind.
 *
 * Its install.sh wires Claude, Codex and OpenCode and stops. The VS Code
 * extension and the herdr plugin live in the same monorepo, are
 * installed by hand, and therefore are not installed.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TOOLS, providerFor } from "./manifest.ts";
import type { Platform } from "./platform.ts";

function platform(over: Partial<Platform>): Platform {
  return {
    os: "linux", distro: "ubuntu", version: "24.04", codename: "noble",
    env: "wsl", arch: "x64",
    caps: { apt: true, gui: false, systemd: true, winget: true, flatpak: false },
    ...over,
  } as Platform;
}

const vscode = TOOLS.find((t) => t.name === "red-skills-vscode");
const herdr = TOOLS.find((t) => t.name === "red-skills-herdr");
const src = readFileSync("src/red-skills-ext.ts", "utf8");

describe("both are offered rather than assumed", () => {
  test("are in the optional scope", () => {
    expect(vscode?.scope).toBe("optional");
    expect(herdr?.scope).toBe("optional");
  });

  test("and unticked, because both build a turbo workspace first", () => {
    expect(vscode?.offByDefault).toBe(true);
    expect(herdr?.offByDefault).toBe(true);
  });

  test("herdr's is skipped on Windows, which has no stable herdr", () => {
    const win = platform({ os: "windows", env: "windows" });
    expect(providerFor(herdr!, win).kind).toBe("skip");
  });
});

describe("what the run taught", () => {
  test("looks for the .vsix at the workspace root", () => {
    // `pnpm -C apps/vscode-redskilled package` writes to dist/ at the
    // repo root, not under the app. The first version looked under the
    // app, found nothing, and threw on a build that had succeeded.
    expect(src).toContain("${root}/dist");
  });

  test("hands the editors a path with the symlink resolved", () => {
    // These are Windows programs even when invoked from a distro: they
    // translate to \\wsl.localhost\... and open over 9P, where the
    // `current` symlink does not survive. VSCodium reported ENOENT on a
    // file that plainly existed.
    expect(src).toContain("realpathSync");
  });

  test("installs into every editor found rather than asking which", () => {
    expect(src).toContain('["code", "codium", "cursor"]');
  });

  test("skips loudly when the host or the source is missing", () => {
    expect(src).toContain("no VS Code-family editor installed");
    expect(src).toContain("red-skills is not installed");
    expect(src).toContain("herdr is not installed");
  });

  test("only pays for the workspace when something needs it", () => {
    // A pnpm install of this monorepo is not a side effect anyone
    // should get from converging something else.
    expect(src).toContain("already prepared");
  });
});
