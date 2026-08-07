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

const agents = readFileSync(`${import.meta.dir}/agents.ts`, "utf8");
const firstrun = readFileSync(`${import.meta.dir}/firstrun.ts`, "utf8");
const runtimes = readFileSync(`${import.meta.dir}/runtimes.ts`, "utf8");

describe("resolving npm", () => {
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
