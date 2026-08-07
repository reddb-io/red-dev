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
import {
  agentInstallMethod,
  AGENTS,
  codexPortableExecutable,
  executablesEnvironment,
  npmEnvironment,
} from "./agents.ts";
import type { Platform } from "./platform.ts";
import { windowsInstallerEnvironment } from "./providers.ts";
import { preferManagedTool, runtimeInstallRequest } from "./runtimes.ts";

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

  test("puts Python beside Node for Hermes' npm postinstall", () => {
    const env = executablesEnvironment(
      [
        "C:\\mise\\node\\npm.cmd",
        "C:\\mise\\python\\python.exe",
      ],
      "win32",
      { Path: "C:\\Windows\\System32" },
    );

    expect(env.Path).toBe(
      "C:\\mise\\node;C:\\mise\\python;C:\\Windows\\System32",
    );
    expect(env.PATH).toBe(env.Path);
  });

  test("a mise-owned npm wins over a stale executable already on PATH", () => {
    expect(
      preferManagedTool(
        { code: 0, out: "/home/me/.local/share/mise/installs/node/lts/bin/npm\n" },
        "/home/me/.local/bin/npm",
      ),
    ).toBe("/home/me/.local/share/mise/installs/node/lts/bin/npm");
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

  test("red-skills receives the Node directory mise resolved in this run", () => {
    const start = agents.indexOf("export async function installRedSkills");
    const end = agents.indexOf("export async function updateRedSkills", start);
    const body = agents.slice(start, end);
    expect(body).toContain('runtimeTool("node")');
    expect(body).toContain("executableEnvironment(node)");
  });

  test("Git Bash keeps its own utilities when red-skills receives a runtime PATH", () => {
    const env = windowsInstallerEnvironment(
      "C:\\Program Files\\Git\\bin\\bash.exe",
      { Path: "C:\\mise\\node;C:\\Windows\\System32", PATH: "stale" },
      "win32",
    );

    expect(env.Path).toBe(
      "C:\\Program Files\\Git\\usr\\bin;C:\\mise\\node;C:\\Windows\\System32",
    );
    expect(env.PATH).toBe(env.Path);
  });
});

describe("Python runtime integrity", () => {
  test("the Python 3.13 choice resolves to the verified precompiled patch", () => {
    expect(runtimeInstallRequest("python@3.13")).toEqual({
      id: "python@3.13.14",
      env: { MISE_PYTHON_COMPILE: "0" },
    });
  });

  test("installation proves SQLite exists before reporting Python as ready", () => {
    const start = runtimes.indexOf("export async function useRuntimes");
    const end = runtimes.indexOf("export async function currentRuntimes", start);
    expect(runtimes.slice(start, end)).toContain("import sqlite3");
  });
});

describe("agent install method", () => {
  const wsl: Platform = {
    os: "linux",
    env: "wsl",
    distro: "ubuntu",
    version: "24.04",
    codename: "noble",
    arch: "x64",
    caps: { apt: true, gui: false, systemd: true, winget: true, flatpak: false },
  };

  test("WSL uses the non-interactive npm packages for OpenClaw and Hermes", () => {
    for (const key of ["openclaw", "hermes"]) {
      const agent = AGENTS.find((candidate) => candidate.key === key)!;
      expect(agentInstallMethod(agent, wsl), key).toBe("npm");
    }
  });

  test("Hermes is present only when its Python-backed command starts", () => {
    const hermes = AGENTS.find((candidate) => candidate.key === "hermes")!;
    expect(hermes.probeArgs).toEqual(["--version"]);
    expect(firstrun).toContain("await isAgentReady(agent)");
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
