/**
 * Launching the Default agent, and the flag red-dev never adds.
 *
 * ADR 0001's amendment of 2026-08-15 puts one entry on the do-not-copy
 * list: Omarchy starts its default agent in bypass/auto-approve mode,
 * and red-dev's never does. That sentence is a promise until something
 * reads the argv, so the first half of this file enumerates every host
 * red-dev can start and asserts what is on its command line — and then
 * proves the enumeration can fail, by running it over a host that
 * carries `--yolo`. A guard that cannot fail is a comment.
 *
 * The second half pins the other way this goes wrong: launching the
 * host that happens to be installed rather than the host that was
 * chosen. The recorded answer decides, or nothing launches.
 */

import { describe, expect, test } from "bun:test";
import { AGENTS, type AgentSpec } from "./agents.ts";
import {
  hostLaunchArgv,
  launchTarget,
  permissionBypassFlags,
  resolveLaunch,
} from "./agent-launch.ts";
import { isDefaultAgentCandidate } from "./default-agent.ts";

/** Every host red-dev can hand work to, and therefore can start. */
const LAUNCHABLE = AGENTS.filter(isDefaultAgentCandidate);

/** A PATH lookup with no machine behind it. */
const found = (...commands: string[]) => (command: string): string | null =>
  commands.includes(command) ? `/usr/bin/${command}` : null;

/**
 * A host that carries the flag, for the guard to catch.
 *
 * Deliberately shaped like a real catalog entry: this is what a future
 * entry would look like the day someone adds a launch argument without
 * reading the ADR.
 */
const BYPASSING_HOST: AgentSpec = {
  key: "fixture",
  label: "Fixture Agent",
  about: "a host that starts itself unattended",
  cmd: "fixture",
  recommended: false,
  launchArgs: ["--yolo"],
};

describe("the launch argv of every agent host", () => {
  test("there are hosts to check", () => {
    // Guards against the enumeration passing because it enumerated
    // nothing — the way this test would rot if the catalog moved.
    expect(LAUNCHABLE.length).toBeGreaterThan(3);
  });

  test("is the host's plain invocation and nothing else", () => {
    for (const host of LAUNCHABLE) {
      expect(hostLaunchArgv(host, `/usr/bin/${host.cmd}`)).toEqual([`/usr/bin/${host.cmd}`]);
    }
  });

  test("carries no bypass, auto-approve or yolo flag", () => {
    const offenders = LAUNCHABLE.filter(
      (host) => permissionBypassFlags(hostLaunchArgv(host, `/usr/bin/${host.cmd}`)).length > 0,
    );
    expect(offenders.map((host) => host.key)).toEqual([]);
  });

  test("and the same enumeration fails a host that carries one", () => {
    const offenders = [...LAUNCHABLE, BYPASSING_HOST].filter(
      (host) => permissionBypassFlags(hostLaunchArgv(host, `/usr/bin/${host.cmd}`)).length > 0,
    );
    expect(offenders.map((host) => host.key)).toEqual(["fixture"]);
  });

  test("refuses to be built at all when it would carry one", () => {
    // The enumeration above catches a catalog entry before it ships.
    // This catches the same entry on the machine of whoever ships it
    // anyway, which is the difference between a test and a guard.
    expect(() => launchTarget(BYPASSING_HOST, "/usr/bin/fixture")).toThrow(/--yolo/);
  });
});

describe("the flags that count as one", () => {
  test("are recognised in the spellings the hosts actually use", () => {
    for (
      const flag of [
        "--dangerously-skip-permissions",
        "--dangerously-bypass-approvals-and-sandbox",
        "--permission-mode=bypassPermissions",
        "--permission-mode=acceptEdits",
        "--approval-mode=auto_edit",
        "--full-auto",
        "--yolo",
        "-y",
        "--sandbox=danger-full-access",
        "--trust-all-tools",
      ]
    ) {
      expect(permissionBypassFlags([flag])).toEqual([flag]);
    }
  });

  test("are recognised when the value arrives as a second token", () => {
    // `--permission-mode bypassPermissions` hides the answer one token
    // to the right, which is where a scan of flag names alone misses it.
    expect(permissionBypassFlags(["--permission-mode", "bypassPermissions"]))
      .toEqual(["bypassPermissions"]);
  });

  test("do not swallow the ordinary arguments a host takes", () => {
    expect(permissionBypassFlags([
      "--model",
      "opus",
      "--permission-mode",
      "plan",
      "--resume",
      "--force-color",
      "/home/someone/project",
    ])).toEqual([]);
  });
});

describe("launching", () => {
  test("resolves through the Default agent, not through what is installed", () => {
    // Both hosts are on this machine and claude-code is first in the
    // catalog. The record says codex, so codex is what starts.
    const decision = resolveLaunch(
      { agents: ["claude-code", "codex"], defaultAgent: "codex" },
      found("claude", "codex"),
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.target.key).toBe("codex");
    expect(decision.target.argv).toEqual(["/usr/bin/codex"]);
  });

  test("follows the record when it changes, with no other input changing", () => {
    const machine = found("claude", "codex");
    const selection = ["claude-code", "codex"];
    const key = (stored: string) => {
      const decision = resolveLaunch({ agents: selection, defaultAgent: stored }, machine);
      return decision.ok ? decision.target.key : null;
    };
    expect(key("codex")).toBe("codex");
    expect(key("claude-code")).toBe("claude-code");
  });

  test("resolves a selection recorded under the host's older name", () => {
    const decision = resolveLaunch({ agents: ["opencode"], defaultAgent: "opencode" }, found("redcode"));
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.target.key).toBe("redcode");
  });

  test("starts nothing when the recorded host is no longer installed", () => {
    // Not "start the other one". A machine that has lost Claude Code
    // says so; it does not quietly become a Codex machine.
    const decision = resolveLaunch(
      { agents: ["claude-code", "codex"], defaultAgent: "claude-code" },
      found("codex"),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.detail).toContain("Claude Code");
    expect(decision.detail).not.toContain("Codex");
  });

  test("starts nothing when no Default agent has been chosen", () => {
    const decision = resolveLaunch({ agents: ["claude-code", "codex"] }, found("claude", "codex"));
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.detail).toContain("red-dev agents default");
  });

  test("starts nothing when the record names a host red-dev cannot hand work to", () => {
    const decision = resolveLaunch({ agents: ["herdr"], defaultAgent: "herdr" }, found("herdr"));
    expect(decision.ok).toBe(false);
  });

  test("adds nothing of its own to what it starts", () => {
    const decision = resolveLaunch({ defaultAgent: "claude-code" }, found("claude"));
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.target.added).toEqual([]);
    expect(permissionBypassFlags(decision.target.argv)).toEqual([]);
  });

  test("carries what the person typed through untouched, that flag included", () => {
    // The promise is that red-dev never adds one, not that it refuses
    // to pass one on: unattended is a decision someone makes at the
    // moment they type it, and this is them typing it.
    const decision = resolveLaunch({ defaultAgent: "claude-code" }, found("claude"), [
      "--dangerously-skip-permissions",
    ]);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.target.added).toEqual([]);
    expect(decision.target.argv).toEqual([
      "/usr/bin/claude",
      "--dangerously-skip-permissions",
    ]);
  });
});

describe("a host installed as a Windows shim", () => {
  test("is interpreted rather than exec'd, and gains no arguments by it", () => {
    // CreateProcess cannot exec a .cmd directly, so the argv grows a
    // cmd.exe prefix. Pinned because that is the one place red-dev
    // rewrites a launch command line at all.
    const claude = AGENTS.find((host) => host.key === "claude-code")!;
    const argv = hostLaunchArgv(claude, "C:\\npm\\claude.cmd", ["--resume"]);
    expect(argv).toEqual(["cmd.exe", "/c", "C:\\npm\\claude.cmd", "--resume"]);
    expect(permissionBypassFlags(argv)).toEqual([]);
  });
});
