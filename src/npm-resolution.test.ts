/**
 * npm has to be findable in the same run that installed it.
 *
 * The failure this pins, from a real converge on native Windows:
 *
 *   fail Gemini CLI: npm not on PATH — install a Node runtime first
 *   ...
 *   :: mise: node@lts
 *    ok  node@lts
 *
 * Three agents refused over a prerequisite the same function satisfied
 * four lines later. Two separate mistakes stacked: agents ran before
 * runtimes (fixed by ordering), and even ordered correctly,
 * Bun.which("npm") answers from a PATH read at process start — so a
 * node installed mid-run is invisible to it forever. These are source
 * scans because the behaviour needs a Windows box with mise mid-install;
 * what can be pinned is that the code asks the right oracle.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { codexPortableExecutable, npmEnvironment } from "./agents.ts";

const agents = readFileSync(`${import.meta.dir}/agents.ts`, "utf8");
const firstrun = readFileSync(`${import.meta.dir}/firstrun.ts`, "utf8");
const runtimes = readFileSync(`${import.meta.dir}/runtimes.ts`, "utf8");

describe("resolving npm", () => {
  test("puts node beside npm at the front of both Windows PATH spellings", () => {
    const env = npmEnvironment(
      "C:\\Users\\filip\\AppData\\Local\\mise\\installs\\node\\24.18.1\\npm.cmd",
      "win32",
      { Path: "C:\\Windows\\System32", PATH: "stale" },
    );

    const expected =
      "C:\\Users\\filip\\AppData\\Local\\mise\\installs\\node\\24.18.1;" +
      "C:\\Windows\\System32";
    expect(env.Path).toBe(expected);
    expect(env.PATH).toBe(expected);
  });

  test("asks mise, not only the process PATH", () => {
    // runtimeTool falls back to `mise which`, whose answer does not
    // depend on when this process was born.
    expect(runtimes).toContain("export async function runtimeTool");
    expect(runtimes).toContain('run([mise, "which", name])');
  });

  test("agents resolve npm through it in both branches", () => {
    expect(agents).toContain("await resolveNpm()");
    expect(agents).not.toContain('Bun.which("npm")');
  });

  test("npm.cmd goes through cmd.exe, like winget does", () => {
    // mise resolves npm to npm.cmd on Windows, and CreateProcess cannot
    // exec a batch file directly.
    expect(agents).toContain('["cmd.exe", "/c", npm, ...args]');
  });
});

describe("ordering and implication", () => {
  test("runtimes install before agents", () => {
    const runtimesAt = firstrun.indexOf("await useRuntimes(");
    const agentsAt = firstrun.indexOf("await installAgent(");
    expect(runtimesAt).toBeGreaterThan(-1);
    expect(agentsAt).toBeGreaterThan(-1);
    expect(runtimesAt).toBeLessThan(agentsAt);
  });

  test("choosing an npm agent implies node@lts", () => {
    // Picking Gemini without ticking node is not a contradiction the
    // user should have to notice; it names an end and leaves the means
    // to the tool whose job that is.
    expect(firstrun).toContain('runtimes.unshift("node@lts")');
  });
});

describe("winget portable commands", () => {
  test("finds Codex's real executable without mistaking its helpers for the CLI", () => {
    expect(
      codexPortableExecutable([
        "codex-command-runner.exe",
        "codex-windows-sandbox-setup.exe",
        "codex-x86_64-pc-windows-msvc.exe",
      ]),
    ).toBe("codex-x86_64-pc-windows-msvc.exe");
  });

  test("the exposed command is a real exe so Git Bash can resolve it", () => {
    expect(agents).toContain('const exposed = `${bin}\\\\codex.exe`');
    expect(agents).toContain("linkSync(target, exposed)");
    expect(agents).toContain("copyFileSync(target, exposed)");
    expect(agents).not.toContain("codex.cmd");
  });
});
