/**
 * What a converge asks the agent hosts to do, and when it asks nothing.
 *
 * A marketplace update plus one plugin update per declared plugin, across
 * every host on the machine, is a walk of several CLIs and a network
 * round trip each. Run on every converge it is pure cost: the overwhelming
 * majority of converges resolve the same red-skills version they resolved
 * last time, and refreshing a host against a tree it already read changes
 * nothing on the machine.
 *
 * The observable these tests hold is the command trace, never an internal
 * flag. A refresh that "decided" not to run and issued the commands
 * anyway is the bug; so is one that reports a host as current after the
 * host refused the call. So the runner is injected and what is asserted
 * is the argv that reached it — which also means all of this holds with
 * no red-skills, no marketplace and no agent CLI on the machine.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Platform } from "./platform.ts";
import {
  REFRESH_HOSTS,
  readHostStamp,
  refreshSkillHosts,
  type HostRefreshOptions,
} from "./red-skills-hosts.ts";

const UBUNTU: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false },
};

/** Two versions of the same checkout: the resolved path is what moves. */
const OLD = "/home/someone/.red-skills/versions/v3.3.0";
const NEW = "/home/someone/.red-skills/versions/v3.4.0";

const PLUGINS = ["dev", "memory"];

function home(): string {
  return mkdtempSync(join(tmpdir(), "red-hosts-home-"));
}

/** Collects the argv a refresh issued, and answers with `code`. */
function recorder(code: (cmd: string[]) => number = () => 0): {
  calls: string[][];
  run: (cmd: string[]) => Promise<number>;
} {
  const calls: string[][] = [];
  return {
    calls,
    run: async (cmd: string[]) => {
      calls.push(cmd);
      return code(cmd);
    },
  };
}

/** A machine with every declared host installed, at `source`. */
function refresh(
  opts: HostRefreshOptions & { source: string },
): ReturnType<typeof refreshSkillHosts> {
  return refreshSkillHosts(UBUNTU, {
    plugins: PLUGINS,
    present: () => true,
    ...opts,
  });
}

/** The commands one host answered for, by the CLI they were addressed to. */
function forHost(calls: string[][], cmd: string): string[] {
  return calls.filter((c) => c[0] === cmd).map((c) => c.join(" "));
}

describe("the hosts are refreshed when the resolved version moved", () => {
  test("a first converge refreshes every host once", async () => {
    // Nothing stamped yet, which is the state of a machine that has never
    // been refreshed. Unknown is not "current": an empty stamp has to
    // mean refresh, or a machine gets its first refresh never.
    const root = home();
    const { calls, run } = recorder();
    const out = await refresh({ home: root, source: NEW, run });

    expect(out.every((o) => o.refreshed)).toBe(true);
    expect(out.map((o) => o.host)).toEqual(REFRESH_HOSTS.map((h) => h.name));
    for (const host of REFRESH_HOSTS) {
      expect(forHost(calls, host.cmd), host.name).toEqual(
        host.argv(PLUGINS).map((c) => c.join(" ")),
      );
    }
  });

  test("and issues them exactly once per host, not once per plugin set", async () => {
    // The failure this pins is a loop nested one level too deep: the
    // marketplace refreshed once per plugin rather than once per host.
    const { calls, run } = recorder();
    await refresh({ home: home(), source: NEW, run });

    for (const host of REFRESH_HOSTS) {
      const marketplace = forHost(calls, host.cmd).filter((c) => c.includes("marketplace"));
      expect(marketplace.length, host.name).toBe(1);
    }
    expect(calls.length).toBe(
      REFRESH_HOSTS.reduce((n, h) => n + h.argv(PLUGINS).length, 0),
    );
  });

  test("a converge whose resolved version is unchanged issues no host commands", async () => {
    // The whole point of the slice. Not "issues fewer" and not "issues
    // them and they no-op" — the trace is empty.
    const root = home();
    await refresh({ home: root, source: NEW, run: recorder().run });

    const { calls, run } = recorder();
    const out = await refresh({ home: root, source: NEW, run });

    expect(calls).toEqual([]);
    expect(out.every((o) => !o.refreshed)).toBe(true);
    for (const o of out) expect(o.reason, o.host).toContain("v3.4.0");
  });

  test("a version that moved afterwards refreshes them again", async () => {
    // Both directions, because a gate that only ever says "skip" is as
    // broken as one that never does.
    const root = home();
    await refresh({ home: root, source: OLD, run: recorder().run });

    const { calls, run } = recorder();
    const out = await refresh({ home: root, source: NEW, run });

    expect(out.every((o) => o.refreshed)).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    for (const host of REFRESH_HOSTS) {
      expect(readHostStamp(root)[host.name], host.name).toBe(NEW);
    }
  });

  test("red-skills absent from the machine refreshes nothing", async () => {
    const { calls, run } = recorder();
    const out = await refreshSkillHosts(UBUNTU, {
      home: home(),
      source: null,
      plugins: PLUGINS,
      present: () => true,
      run,
    });

    expect(calls).toEqual([]);
    expect(out).toEqual([]);
  });
});

describe("a host that is not on the machine", () => {
  test("is skipped with a reason rather than counted as refreshed", async () => {
    // The distinction is load-bearing for the stamp below: "we refreshed
    // it" and "it is not here" are different facts, and collapsing them
    // is how a host that arrives next week never gets refreshed at all.
    const first = REFRESH_HOSTS[0] as (typeof REFRESH_HOSTS)[number];
    const { calls, run } = recorder();
    const out = await refresh({
      home: home(),
      source: NEW,
      present: (cmd) => cmd !== first.cmd,
      run,
    });

    const skipped = out.find((o) => o.host === first.name);
    expect(skipped?.refreshed).toBe(false);
    expect(skipped?.reason).toContain("not installed");
    expect(forHost(calls, first.cmd)).toEqual([]);
    expect(out.filter((o) => o.host !== first.name).every((o) => o.refreshed)).toBe(true);
  });

  test("and is refreshed on the converge after it appears", async () => {
    // Absence must not be stamped. A skipped host recorded as current is
    // a host installed tomorrow and left on yesterday's tree forever.
    const first = REFRESH_HOSTS[0] as (typeof REFRESH_HOSTS)[number];
    const root = home();
    await refresh({ home: root, source: NEW, present: (c) => c !== first.cmd, run: recorder().run });
    expect(readHostStamp(root)[first.name]).toBeUndefined();

    const { calls, run } = recorder();
    const out = await refresh({ home: root, source: NEW, run });

    expect(out.find((o) => o.host === first.name)?.refreshed).toBe(true);
    expect(forHost(calls, first.cmd).length).toBeGreaterThan(0);
    // And only that host: the others were already at this version.
    expect(calls.every((c) => c[0] === first.cmd)).toBe(true);
  });
});

describe("a host that refuses the refresh", () => {
  test("does not prevent the others", async () => {
    // One CLI broken for its own reasons — a half-written config, an
    // expired login — is the ordinary state of a machine with several
    // agents on it. It cannot be allowed to end the walk.
    const [first, ...rest] = REFRESH_HOSTS;
    expect(rest.length).toBeGreaterThan(0);

    const { calls, run } = recorder((cmd) => (cmd[0] === (first as { cmd: string }).cmd ? 1 : 0));
    const out = await refresh({ home: home(), source: NEW, run });

    expect(out.find((o) => o.host === (first as { name: string }).name)?.refreshed).toBe(false);
    for (const host of rest) {
      expect(out.find((o) => o.host === host.name)?.refreshed, host.name).toBe(true);
      expect(forHost(calls, host.cmd), host.name).toEqual(
        host.argv(PLUGINS).map((c) => c.join(" ")),
      );
    }
  });

  test("a runner that throws is a failed host, not a failed converge", async () => {
    const [first, ...rest] = REFRESH_HOSTS;
    const calls: string[][] = [];
    const out = await refresh({
      home: home(),
      source: NEW,
      run: async (cmd) => {
        if (cmd[0] === (first as { cmd: string }).cmd) throw new Error("spawn failed");
        calls.push(cmd);
        return 0;
      },
    });

    expect(out.find((o) => o.host === (first as { name: string }).name)?.refreshed).toBe(false);
    for (const host of rest) {
      expect(forHost(calls, host.cmd).length, host.name).toBeGreaterThan(0);
    }
  });

  test("is retried on the next converge, because it was never stamped", async () => {
    const first = REFRESH_HOSTS[0] as (typeof REFRESH_HOSTS)[number];
    const root = home();
    const failing = recorder((cmd) => (cmd[0] === first.cmd ? 1 : 0));
    await refresh({ home: root, source: NEW, run: failing.run });
    expect(readHostStamp(root)[first.name]).toBeUndefined();

    const { calls, run } = recorder();
    const out = await refresh({ home: root, source: NEW, run });

    expect(out.find((o) => o.host === first.name)?.refreshed).toBe(true);
    expect(forHost(calls, first.cmd)).toEqual(first.argv(PLUGINS).map((c) => c.join(" ")));
    expect(readHostStamp(root)[first.name]).toBe(NEW);
  });
});

describe("what the hosts are asked", () => {
  test("every host refreshes the marketplace and each declared plugin", async () => {
    // Derived from the argument, never a literal here: the plugin set is
    // the manifest's answer, and a test that wrote one down would be a
    // second place for it to be declared.
    for (const host of REFRESH_HOSTS) {
      const argv = host.argv(PLUGINS);
      expect(argv.every((c) => c[0] === host.cmd), host.name).toBe(true);
      for (const plugin of PLUGINS) {
        expect(
          argv.some((c) => c.includes(`${plugin}@red-skills`)),
          `${host.name}/${plugin}`,
        ).toBe(true);
      }
    }
  });

  test("an empty plugin set still refreshes the marketplace", async () => {
    // A machine that opted every plugin out still carries the core, and
    // the marketplace it registers is what a later opt-in reads.
    const { calls, run } = recorder();
    await refresh({ home: home(), source: NEW, plugins: [], run });
    expect(calls.length).toBe(REFRESH_HOSTS.length);
    for (const host of REFRESH_HOSTS) {
      expect(forHost(calls, host.cmd).length, host.name).toBe(1);
    }
  });

  test("the converge reaches the refresh on the already-wired path too", () => {
    // Asserted against the source because it is not observable any other
    // way without an agent CLI in the loop, and because the failure it
    // guards is precise: convergeRedSkills used to return at "already
    // wired", which is every ordinary converge. A refresh written and
    // never reached from there would leave the version moving under a
    // machine whose hosts are never told.
    const src = readFileSync(`${import.meta.dir}/agents.ts`, "utf8");
    const converge = src.slice(src.indexOf("export async function convergeRedSkills"));
    const wired = converge.indexOf("already wired into");
    expect(wired).toBeGreaterThan(-1);
    expect(converge.slice(wired)).toContain("refreshSkillHosts");
  });

  test("the hosts are the ones red-dev knows how to drive, by name", () => {
    // Claude and Codex are CLI calls red-dev makes itself. The generator
    // hosts are invoked from the installed tree and arrive with that
    // slice; the table is where they will land.
    expect(REFRESH_HOSTS.map((h) => h.name)).toEqual(["claude", "codex"]);
  });
});
