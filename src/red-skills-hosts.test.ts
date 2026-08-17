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
 *
 * Two of those describes go further and actually run a generator, out of
 * a fixture tree with a real script in it. That is the only way to assert
 * the thing the split exists for: a skill added to the tree appears on
 * the machine with nothing here changed, and unwiring removes what the
 * generator's own manifest recorded rather than what this repo guesses.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Platform } from "./platform.ts";
import {
  REFRESH_HOSTS,
  readHostStamp,
  refreshSkillHosts,
  unwireSkillHosts,
  type HostContext,
  type HostRefreshOptions,
  type SkillHostRefresh,
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

const CTX: HostContext = { plugins: PLUGINS, source: NEW };

/** The hosts red-dev drives with its own CLI calls. */
const CLI_HOSTS = ["claude", "codex"];
/** The hosts wired by the generators inside the installed tree. */
const GENERATOR_HOSTS = ["opencode", "redcode", "pi"];

function hostNamed(name: string): SkillHostRefresh {
  const host = REFRESH_HOSTS.find((h) => h.name === name);
  if (!host) throw new Error(`no host named ${name}`);
  return host;
}

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

/** What one host is asked, as lines, in the order it is asked. */
function wireOf(host: SkillHostRefresh, ctx: HostContext = CTX): string[] {
  return host.wire(ctx).map((s) => s.argv.join(" "));
}

/**
 * The commands one host answered for.
 *
 * Matched against that host's own steps rather than against the CLI
 * name: three of the five hosts are wired by a script path, and two of
 * those three are the same script told which host it is working for.
 */
function forHost(calls: string[][], host: SkillHostRefresh, ctx: HostContext = CTX): string[] {
  const mine = new Set(wireOf(host, ctx));
  return calls.map((c) => c.join(" ")).filter((c) => mine.has(c));
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
    expect(calls.map((c) => c.join(" "))).toEqual(REFRESH_HOSTS.flatMap((h) => wireOf(h)));
  });

  test("and issues them exactly once per host, not once per plugin set", async () => {
    // The failure this pins is a loop nested one level too deep: the
    // marketplace refreshed once per plugin rather than once per host.
    const { calls, run } = recorder();
    await refresh({ home: home(), source: NEW, run });

    for (const name of CLI_HOSTS) {
      const host = hostNamed(name);
      const marketplace = forHost(calls, host).filter((c) => c.includes("marketplace"));
      expect(marketplace.length, name).toBe(1);
    }
    // And the generators are invoked once each, whatever the plugin set:
    // which plugins to render is the tree's question, not this repo's.
    for (const name of GENERATOR_HOSTS) {
      expect(forHost(calls, hostNamed(name)).length, name).toBe(1);
    }
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
    // Asserted for every host in turn, because the generator hosts are
    // absent from far more machines than Claude is.
    for (const skip of REFRESH_HOSTS) {
      const { calls, run } = recorder();
      const out = await refresh({
        home: home(),
        source: NEW,
        present: (cmd) => cmd !== skip.cmd,
        run,
      });

      const skipped = out.find((o) => o.host === skip.name);
      expect(skipped?.refreshed, skip.name).toBe(false);
      expect(skipped?.reason, skip.name).toContain("not installed");
      expect(forHost(calls, skip), skip.name).toEqual([]);
      expect(out.filter((o) => o.host !== skip.name).every((o) => o.refreshed), skip.name).toBe(
        true,
      );
    }
  });

  test("and is refreshed on the converge after it appears", async () => {
    // Absence must not be stamped. A skipped host recorded as current is
    // a host installed tomorrow and left on yesterday's tree forever.
    const first = hostNamed("claude");
    const root = home();
    await refresh({ home: root, source: NEW, present: (c) => c !== first.cmd, run: recorder().run });
    expect(readHostStamp(root)[first.name]).toBeUndefined();

    const { calls, run } = recorder();
    const out = await refresh({ home: root, source: NEW, run });

    expect(out.find((o) => o.host === first.name)?.refreshed).toBe(true);
    expect(forHost(calls, first).length).toBeGreaterThan(0);
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
      expect(forHost(calls, host), host.name).toEqual(wireOf(host));
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
      expect(forHost(calls, host).length, host.name).toBeGreaterThan(0);
    }
  });

  test("is retried on the next converge, because it was never stamped", async () => {
    const first = hostNamed("claude");
    const root = home();
    const failing = recorder((cmd) => (cmd[0] === first.cmd ? 1 : 0));
    await refresh({ home: root, source: NEW, run: failing.run });
    expect(readHostStamp(root)[first.name]).toBeUndefined();

    const { calls, run } = recorder();
    const out = await refresh({ home: root, source: NEW, run });

    expect(out.find((o) => o.host === first.name)?.refreshed).toBe(true);
    expect(forHost(calls, first)).toEqual(wireOf(first));
    expect(readHostStamp(root)[first.name]).toBe(NEW);
  });
});

describe("what the hosts are asked", () => {
  test("the five hosts are the ones the spec settled, by name", () => {
    expect(REFRESH_HOSTS.map((h) => h.name)).toEqual([...CLI_HOSTS, ...GENERATOR_HOSTS]);
  });

  test("Claude and Codex are red-dev's own CLI calls", () => {
    // Not a script, not a generator: the two hosts with a marketplace are
    // the two red-dev drives itself, and every argv it issues is
    // addressed to the CLI whose presence gated the call.
    for (const name of CLI_HOSTS) {
      const host = hostNamed(name);
      for (const step of [...host.wire(CTX), ...host.unwire(CTX)]) {
        expect(step.argv[0], `${name}: ${step.argv.join(" ")}`).toBe(host.cmd);
      }
      expect(wireOf(host).some((c) => c.includes("marketplace")), name).toBe(true);
    }
  });

  test("every host refreshes each declared plugin", async () => {
    // Derived from the argument, never a literal here: the plugin set is
    // the manifest's answer, and a test that wrote one down would be a
    // second place for it to be declared. Only the CLI hosts take it —
    // the generators read the tree they ship in.
    for (const name of CLI_HOSTS) {
      const host = hostNamed(name);
      const argv = wireOf(host);
      for (const plugin of PLUGINS) {
        expect(
          argv.some((c) => c.includes(`${plugin}@red-skills`)),
          `${name}/${plugin}`,
        ).toBe(true);
      }
    }
  });

  test("Codex removes and re-adds, because it has no plugin update", () => {
    // Codex's CLI has `marketplace upgrade` and `plugin add`, and no
    // `plugin update` at all. So the refresh is a remove followed by an
    // add of the same plugin, in that order, against the marketplace
    // snapshot the line above them just upgraded.
    const codex = hostNamed("codex");
    const steps = codex.wire(CTX);
    expect(steps[0]?.argv).toEqual(["codex", "plugin", "marketplace", "upgrade", "red-skills"]);
    expect(steps.some((s) => s.argv.includes("update"))).toBe(false);

    for (const plugin of PLUGINS) {
      const at = steps.findIndex(
        (s) => s.argv.includes("remove") && s.argv.includes(`${plugin}@red-skills`),
      );
      expect(at, plugin).toBeGreaterThan(-1);
      expect(steps[at + 1]?.argv, plugin).toEqual([
        "codex",
        "plugin",
        "add",
        `${plugin}@red-skills`,
      ]);
      // The remove is the fallback half, not a precondition: a plugin
      // this machine has never installed makes it exit non-zero, and
      // that is not a broken host.
      expect(steps[at]?.optional, plugin).toBe(true);
      expect(steps[at + 1]?.optional, plugin).toBeUndefined();
    }
  });

  test("a plugin Codex has never seen does not fail the host", async () => {
    // The same fact as above, held at the trace: a non-zero `remove` is
    // stepped over, the `add` still runs, and the host is stamped.
    const root = home();
    const codex = hostNamed("codex");
    const { calls, run } = recorder((cmd) => (cmd.includes("remove") ? 1 : 0));
    const out = await refresh({ home: root, source: NEW, hosts: [codex], run });

    expect(out).toEqual([{ host: "codex", refreshed: true }]);
    expect(calls.map((c) => c.join(" "))).toEqual(wireOf(codex));
    expect(readHostStamp(root)["codex"]).toBe(NEW);
  });

  test("an empty plugin set still refreshes the marketplace", async () => {
    // A machine that opted every plugin out still carries the core, and
    // the marketplace it registers is what a later opt-in reads.
    const { calls, run } = recorder();
    await refresh({ home: home(), source: NEW, plugins: [], run });
    const empty: HostContext = { plugins: [], source: NEW };
    expect(calls.map((c) => c.join(" "))).toEqual(REFRESH_HOSTS.flatMap((h) => wireOf(h, empty)));
    for (const name of CLI_HOSTS) {
      expect(forHost(calls, hostNamed(name), empty).length, name).toBe(1);
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
});

describe("the three generator hosts", () => {
  test("are wired by invoking a script inside the installed tree", async () => {
    // The split the spec settled, held at the argv. Nothing here spells
    // out a plugin module, a skill path or an MCP entry: the whole of
    // red-dev's contribution is naming a script under the checkout.
    for (const name of GENERATOR_HOSTS) {
      const host = hostNamed(name);
      for (const step of [...host.wire(CTX), ...host.unwire(CTX)]) {
        expect(step.argv[0], `${name}: ${step.argv.join(" ")}`).toStartWith(`${NEW}/scripts/`);
        expect(step.argv[0], name).toEndWith(".sh");
      }
    }
  });

  test("take the resolved checkout as their source, not a path of our own", async () => {
    // A generator renders the skills that ship beside it, so the tree it
    // is invoked out of is the tree it renders. Moving the checkout has
    // to move every command — a path pinned anywhere in this repo would
    // render yesterday's tree on a machine mise has already advanced.
    for (const name of GENERATOR_HOSTS) {
      const host = hostNamed(name);
      const old = host.wire({ plugins: PLUGINS, source: OLD });
      expect(old.every((s) => s.argv.join(" ").includes(OLD)), name).toBe(true);
      expect(old.some((s) => s.argv.join(" ").includes(NEW)), name).toBe(false);
    }
  });

  test("are the same generator for OpenCode and RedCode, told which host", () => {
    // RedCode is an OpenCode-compatible host: one generator, two config
    // directories. Two implementations of that would be the drift this
    // whole split exists to avoid, in miniature.
    const opencode = hostNamed("opencode").wire(CTX)[0]?.argv ?? [];
    const redcode = hostNamed("redcode").wire(CTX)[0]?.argv ?? [];
    expect(opencode[0]).toBe(redcode[0]);
    expect(opencode.slice(opencode.indexOf("--host"))).toEqual(["--host", "opencode"]);
    expect(redcode.slice(redcode.indexOf("--host"))).toEqual(["--host", "redcode"]);
  });

  test("hand pi the checkout explicitly, because it can install from npm instead", () => {
    const pi = hostNamed("pi").wire(CTX)[0]?.argv ?? [];
    expect(pi[0]).toBe(`${NEW}/scripts/install-pi.sh`);
    expect(pi.slice(1)).toEqual(["--source-dir", NEW, "--user"]);
  });
});

/**
 * A tree shaped like the installed checkout, with a real generator in it.
 *
 * The script is a stand-in for `scripts/install-opencode.sh` and holds
 * only the part of its contract these tests are about: it renders every
 * skill it finds under the tree it lives in, and it records every path
 * it wrote in an uninstall manifest that its own `--uninstall` reads
 * back. Everything red-dev knows about that contract is the two argv
 * lines above; the rest is deliberately on the other side of the fence.
 */
function fixtureTree(skills: string[]): string {
  const tree = mkdtempSync(join(tmpdir(), "red-hosts-tree-"));
  mkdirSync(join(tree, "scripts"), { recursive: true });
  const script = join(tree, "scripts", "install-opencode.sh");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -euo pipefail
tree="$(cd "$(dirname "$0")/.." && pwd)"
action=install
host=opencode
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) action=uninstall ;;
    --host) host="$2"; shift ;;
  esac
  shift
done
config="\${XDG_CONFIG_HOME:?}/$host"
manifest="$config/redskills-install-manifest.txt"
if [[ "$action" == "uninstall" ]]; then
  if [[ -f "$manifest" ]]; then
    while IFS= read -r path || [[ -n "$path" ]]; do
      if [[ -n "$path" ]]; then rm -rf "$path"; fi
    done < "$manifest"
    rm -f "$manifest"
  fi
  exit 0
fi
mkdir -p "$config/skills"
: > "$manifest"
for skill in "$tree"/plugins/*/skills/*/SKILL.md; do
  name="$(basename "$(dirname "$skill")")"
  mkdir -p "$config/skills/$name"
  cp "$skill" "$config/skills/$name/SKILL.md"
  printf '%s\\n' "$config/skills/$name" >> "$manifest"
done
`,
  );
  chmodSync(script, 0o755);
  for (const skill of skills) addSkill(tree, skill);
  return tree;
}

/** One more skill in the tree, which is the only edit these tests make. */
function addSkill(tree: string, name: string): void {
  const dir = join(tree, "plugins", "dev", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
}

/** Runs the argv for real, against a config directory of our own. */
function spawner(config: string): (cmd: string[]) => Promise<number> {
  return async (cmd: string[]) => {
    const proc = Bun.spawn(cmd, {
      env: { ...process.env, XDG_CONFIG_HOME: config },
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    return await proc.exited;
  };
}

function skillPath(config: string, host: string, name: string): string {
  return join(config, host, "skills", name, "SKILL.md");
}

describe("no generator logic is reimplemented here", () => {
  test("a skill added to the tree lands on the machine with nothing changed here", async () => {
    // The reason for the whole split, made observable. The only edit
    // between the two converges below is one directory inside a fixture
    // tree — no table in this repo names a skill, so none had to grow a
    // row for `arrived-later` to appear.
    const tree = fixtureTree(["shipped"]);
    const config = mkdtempSync(join(tmpdir(), "red-hosts-config-"));
    const opencode = hostNamed("opencode");

    const first = await refresh({
      home: home(),
      source: tree,
      hosts: [opencode],
      run: spawner(config),
    });
    expect(first).toEqual([{ host: "opencode", refreshed: true }]);
    expect(existsSync(skillPath(config, "opencode", "shipped"))).toBe(true);
    expect(existsSync(skillPath(config, "opencode", "arrived-later"))).toBe(false);

    addSkill(tree, "arrived-later");
    // A fresh home so the stamp does not skip: the point is what the
    // generator renders, not when the walk decides to ask it.
    const second = await refresh({
      home: home(),
      source: tree,
      hosts: [opencode],
      run: spawner(config),
    });

    expect(second).toEqual([{ host: "opencode", refreshed: true }]);
    expect(existsSync(skillPath(config, "opencode", "arrived-later"))).toBe(true);
    expect(existsSync(skillPath(config, "opencode", "shipped"))).toBe(true);
  });
});

describe("unwiring a generator host", () => {
  test("goes through the same script and removes exactly what the manifest recorded", async () => {
    // The conservative removal belongs to the generator, because the
    // manifest is the only record of what it wrote. A second opinion in
    // this repo would be a list of paths that drifts from the tree —
    // and the way it fails is by deleting somebody else's file.
    const tree = fixtureTree(["shipped", "also-shipped"]);
    const config = mkdtempSync(join(tmpdir(), "red-hosts-config-"));
    const root = home();
    const redcode = hostNamed("redcode");

    await refresh({ home: root, source: tree, hosts: [redcode], run: spawner(config) });
    expect(existsSync(skillPath(config, "redcode", "shipped"))).toBe(true);
    expect(readHostStamp(root)["redcode"]).toBe(tree);

    // Something the generator never wrote, in the directory it writes
    // into. Nothing recorded it, so nothing may remove it.
    const mine = join(config, "redcode", "skills", "hand-written");
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, "SKILL.md"), "mine\n");

    const calls: string[][] = [];
    const run = spawner(config);
    const out = await unwireSkillHosts(UBUNTU, {
      home: root,
      source: tree,
      plugins: PLUGINS,
      present: () => true,
      hosts: [redcode],
      run: (cmd) => {
        calls.push(cmd);
        return run(cmd);
      },
    });

    expect(out).toEqual([{ host: "redcode", unwired: true }]);
    expect(calls.map((c) => c.join(" "))).toEqual([
      `${tree}/scripts/install-opencode.sh --uninstall --global --host redcode`,
    ]);
    // What the manifest recorded is gone, and only that.
    expect(existsSync(skillPath(config, "redcode", "shipped"))).toBe(false);
    expect(existsSync(skillPath(config, "redcode", "also-shipped"))).toBe(false);
    expect(existsSync(join(config, "redcode", "redskills-install-manifest.txt"))).toBe(false);
    expect(existsSync(join(mine, "SKILL.md"))).toBe(true);
    // And the host is no longer claimed as refreshed against that tree,
    // so the next converge wires it again rather than skipping it.
    expect(readHostStamp(root)["redcode"]).toBeUndefined();
  });

  test("with no checkout on the machine, unwires nothing rather than guessing", async () => {
    // The scripts live in the tree. With no tree there is no record of
    // what was written, and this repo does not hold a second copy of it.
    const { calls, run } = recorder();
    const out = await unwireSkillHosts(UBUNTU, {
      home: home(),
      source: null,
      plugins: PLUGINS,
      present: () => true,
      run,
    });

    expect(calls).toEqual([]);
    expect(out).toEqual([]);
  });

  test("a host that is not installed is skipped with a reason", async () => {
    const { calls, run } = recorder();
    const out = await unwireSkillHosts(UBUNTU, {
      home: home(),
      source: NEW,
      plugins: PLUGINS,
      present: (cmd) => cmd !== "pi",
      run,
    });

    const pi = out.find((o) => o.host === "pi");
    expect(pi?.unwired).toBe(false);
    expect(pi?.reason).toContain("not installed");
    expect(calls.some((c) => c.join(" ").includes("install-pi.sh"))).toBe(false);
    expect(out.filter((o) => o.host !== "pi").every((o) => o.unwired)).toBe(true);
  });

  test("every host's removal is the undo of its own wiring", () => {
    // Held for all five: the CLI hosts hand back their marketplace, the
    // generator hosts hand back to the script that wired them.
    for (const host of REFRESH_HOSTS) {
      const steps = host.unwire(CTX);
      expect(steps.length, host.name).toBeGreaterThan(0);
      if (GENERATOR_HOSTS.includes(host.name)) {
        expect(steps.map((s) => s.argv[0]), host.name).toEqual(
          host.wire(CTX).map((s) => s.argv[0]),
        );
        expect(steps.every((s) => s.argv.includes("--uninstall")), host.name).toBe(true);
      } else {
        expect(steps.some((s) => s.argv.includes("marketplace")), host.name).toBe(true);
        // Removing what may never have been added is allowed to fail: an
        // uninstall that throws halfway leaves a host part-wired.
        expect(steps.every((s) => s.optional === true), host.name).toBe(true);
      }
    }
  });
});
