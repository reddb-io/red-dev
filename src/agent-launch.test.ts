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
 *
 * Between them sits the path a *chord* takes, which is the one the
 * enumeration used not to reach. `agent.launch` is a semantic action
 * with a key on it, and an action that assembled a host command line of
 * its own would be a second launcher — outside the guard, outside the
 * record, and pressed far more often than `red-dev agents run` is
 * typed.
 */

import { describe, expect, test } from "bun:test";
import { ACTIONS } from "./actions/index.ts";
import { AGENTS, type AgentSpec } from "./agents.ts";
import {
  hostLaunchArgv,
  launchTarget,
  permissionBypassFlags,
  resolveLaunch,
} from "./agent-launch.ts";
import { isDefaultAgentCandidate } from "./default-agent.ts";
import { firePlan } from "./keys.ts";
import type { Platform } from "./platform.ts";

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

  test("and neither does the other command line red-dev builds for a host", () => {
    // The readiness probe is the only other argv red-dev assembles from
    // a catalog entry. It asks a host for its version, and a host that
    // needed a bypass to answer that would be telling us something.
    for (const host of AGENTS) {
      expect(permissionBypassFlags(host.probeArgs ?? [])).toEqual([]);
    }
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

/** A target for a fire plan, since a chord needs a machine to be pressed on. */
function machine(over: Partial<Platform>): Platform {
  return {
    os: "linux",
    distro: "ubuntu",
    version: "24.04",
    codename: "noble",
    env: "desktop",
    arch: "x64",
    caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
    ...over,
  };
}

/** Every target a chord can be pressed on, plus the one that has no keyboard. */
const TARGETS: readonly Platform[] = [
  machine({}),
  machine({ env: "wsl" }),
  machine({ os: "windows", env: "windows", distro: null, version: null, codename: null }),
  machine({ env: "server", caps: { apt: true, gui: false, systemd: true, winget: false, flatpak: false } }),
];

/** Everything is on PATH, so a plan is refused for its own reasons and not for PATH's. */
const anything = (command: string): string => `/usr/bin/${command}`;

describe("the chord that starts the Default agent", () => {
  test("fires `red-dev agents run`, and names no host of its own", () => {
    // The whole reason the action delegates. `red-dev agents run` is the
    // single place that reads the recorded choice — resolveLaunch, in
    // the describe below — and the single place launchTarget's guard
    // stands. An action that assembled `claude …` here would be right
    // on most machines, silently wrong on the ones where somebody
    // chose, and outside both.
    const plan = firePlan("agent.launch", machine({}), anything);
    expect(plan.ok && plan.argv).toEqual(["alacritty", "-e", "red-dev", "agents", "run"]);

    const argv = plan.ok ? plan.argv : [];
    const named = AGENTS.filter((host) => host.cmd !== "" && argv.includes(host.cmd));
    expect(named.map((host) => host.key)).toEqual([]);
  });

  test("and what that command then starts is the recorded host, plainly", () => {
    // The far end of the same path, so the chord's promise is pinned end
    // to end rather than at the handover: the person's recorded answer
    // decides, and red-dev contributes nothing to the command line.
    const decision = resolveLaunch(
      { agents: ["claude-code", "codex"], defaultAgent: "codex" },
      found("claude", "codex"),
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.target.key).toBe("codex");
    expect(decision.target.added).toEqual([]);
    expect(permissionBypassFlags(decision.target.argv)).toEqual([]);
  });

  test("and no action's fire plan carries a bypass flag, on any target", () => {
    // The enumeration, widened from the host catalog to the action path.
    // A chord is a command line red-dev assembles, which is exactly the
    // thing ADR 0001's amendment is about, and until this ran the guard
    // could only see the half of it that a person types.
    const checked: string[] = [];
    const offenders: string[] = [];
    for (const p of TARGETS) {
      for (const action of ACTIONS) {
        const plan = firePlan(action.id, p, anything);
        if (!plan.ok) continue;
        checked.push(`${action.id} on ${p.env}`);
        if (permissionBypassFlags(plan.argv).length > 0) {
          offenders.push(`${action.id} on ${p.env}`);
        }
      }
    }
    // Guards against the enumeration passing because it enumerated
    // nothing — the same way the host enumeration above guards itself.
    expect(checked.length).toBeGreaterThan(ACTIONS.length);
    expect(offenders).toEqual([]);
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
