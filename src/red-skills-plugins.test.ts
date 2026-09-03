/**
 * The plugin set, as something the manifest declares rather than a literal.
 *
 * `dev`, `memory` and `brain` used to be spelled out in two loops in
 * agents.ts. That is two costs: a machine that only ever uses one still
 * carried all three, and adding a fourth meant editing two places that
 * were free to disagree — the kind of pair that is correct on the day it
 * is written and wrong within a release.
 *
 * So the tests below never name the set they expect from the manifest.
 * They assert the *relationship*: whatever the manifest declares is what
 * the fragment projects and what the marketplace repairs install, and a
 * fixture manifest declaring something else moves both. A test that
 * repeated the literal would be the third place to keep in step.
 *
 * Everything runs against the pure projection and an injected runner, so
 * it holds with no mise, no network, no agent CLI and no RedSkills on
 * the machine.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOOLS, type Tool, REDSKILLS_MAJOR } from "./manifest.ts";
import { convergeMiseConfig, miseConfigPath, miseEntries, miseToolNames } from "./mise-config.ts";
import type { Platform } from "./platform.ts";
import { REDSKILLS_CORE_SPEC } from "./red-skills-set.ts";
import {
  activatedPlugins,
  chosenPluginsFrom,
  DEFAULT_ACTIVATED_PLUGINS,
  PLUGIN_CHOICES,
  redSkillsPluginEntries,
  redSkillsPluginNames,
  REDSKILLS_PLUGIN_PREFIX,
} from "./red-skills-plugins.ts";
import {
  REGISTRATION_HOSTS,
  convergeMarketplaceOwnership,
} from "./red-skills-registration.ts";

const UBUNTU: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false },
};

const WINDOWS: Platform = {
  ...UBUNTU,
  os: "windows",
  distro: null,
  version: null,
  codename: null,
  env: "windows",
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
};

/** One plugin row, shaped exactly like the ones in the manifest. */
function pluginRow(name: string): Tool {
  const provider = {
    kind: "mise",
    spec: `${REDSKILLS_PLUGIN_PREFIX}${name}`,
    alias: `red-skills-${name}`,
  } as const;
  return {
    name: `red-skills-${name}`,
    scope: "core",
    managed: true,
    u24: provider,
    win: provider,
  };
}

/** A manifest declaring these plugins and nothing else. */
function fixtureManifest(...plugins: string[]): Tool[] {
  return plugins.map(pluginRow);
}

/** The plugin set as it stands in the real manifest, derived not typed out. */
const DECLARED = redSkillsPluginNames(UBUNTU);

/** Collects the argv a repair would have run, and reports success. */
function recorder(): { calls: string[][]; run: (cmd: string[]) => Promise<number> } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (cmd: string[]) => {
      calls.push(cmd);
      return 0;
    },
  };
}

describe("the plugin set comes from the manifest", () => {
  test("the manifest declares plugins at all, each as its own npm entry", () => {
    // The floor under every other test here: a derivation over an empty
    // manifest passes them all and converges nothing.
    expect(DECLARED.length).toBeGreaterThan(0);
    for (const entry of redSkillsPluginEntries(UBUNTU)) {
      expect(entry.spec.startsWith("npm:")).toBe(true);
      // The major, not `latest`: the four packages compose one set, so
      // they cross a major boundary together or the set sits at the
      // oldest version common to all of them.
      expect(entry.version).toBe(REDSKILLS_MAJOR);
      expect(entry.alias).toBeDefined();
    }
  });

  test("the core is a payload, not a plugin", () => {
    // They share a prefix on npm and nothing else: the core carries the
    // marketplace manifests every plugin is listed in, so counting it as
    // one would install it twice and offer it as something to opt out of.
    expect(redSkillsPluginEntries(UBUNTU).map((e) => e.spec)).not.toContain(REDSKILLS_CORE_SPEC);
  });

  test("the fragment projects one entry per declared plugin, and none besides", () => {
    for (const p of [UBUNTU, WINDOWS]) {
      const specs = miseEntries(p)
        .map((e) => e.spec)
        .filter((s) => s.startsWith(REDSKILLS_PLUGIN_PREFIX));
      expect(specs, `${p.os}`).toEqual(
        redSkillsPluginNames(p).map((n) => `${REDSKILLS_PLUGIN_PREFIX}${n}`),
      );
    }
  });

  test("a plugin the manifest does not declare gets no entry", () => {
    // `internal` is published beside the three that ship — maintainer-only
    // skills for operating the red-skills repository. Nothing declares it
    // here, so nothing should install it.
    expect(DECLARED).not.toContain("internal");
    const rendered = miseEntries(UBUNTU).map((e) => e.spec);
    expect(rendered).not.toContain(`${REDSKILLS_PLUGIN_PREFIX}internal`);
  });

  test("entries inherit `mise upgrade`, which is what being an entry buys", () => {
    // Bare `mise upgrade` would reach the user's own runtimes, so the
    // suite is upgraded by name. A plugin missing from that list is
    // declared and never advanced — the frozen-forever shape again.
    const names = miseToolNames(UBUNTU);
    for (const entry of redSkillsPluginEntries(UBUNTU)) {
      expect(names).toContain(entry.alias ?? entry.spec);
    }
  });
});

describe("the set is derived, not written down", () => {
  test("a fixture manifest with a different set produces a different projection", () => {
    const fixture = fixtureManifest("dev", "sparkle");
    expect(redSkillsPluginNames(UBUNTU, fixture)).toEqual(["dev", "sparkle"]);
    expect(miseEntries(UBUNTU, fixture, []).map((e) => e.spec)).toEqual([
      `${REDSKILLS_PLUGIN_PREFIX}dev`,
      `${REDSKILLS_PLUGIN_PREFIX}sparkle`,
    ]);
  });

  test("no hard-coded plugin list is left in the loops that install them", () => {
    // The literal this slice exists to remove. Asserted against the
    // source because the absence of a list is not observable any other
    // way: a second copy would agree with the manifest on the day it was
    // written and drift from it silently afterwards.
    //
    // Both files, because both issue plugin commands: the registration
    // reinstalls what a re-registration replaced, and the host refresh
    // updates what is already installed.
    for (const file of ["agents.ts", "red-skills-registration.ts", "red-skills-hosts.ts"]) {
      const src = readFileSync(`${import.meta.dir}/${file}`, "utf8");
      expect(src, file).not.toContain(`["dev", "memory", "brain"]`);
    }
    // The registration derives what it reinstalls from the activation
    // set, which is itself derived from the manifest.
    expect(readFileSync(`${import.meta.dir}/red-skills-registration.ts`, "utf8")).toContain(
      "resolveActivatedPlugins",
    );
  });
});

/** The `<plugin>@red-skills` arguments a registration asked a host to install. */
function installedBy(calls: string[][]): string[] {
  return calls
    .map((cmd) => cmd.find((arg) => arg.endsWith("@red-skills")))
    .filter((arg): arg is string => arg !== undefined)
    .map((arg) => arg.replace("@red-skills", ""));
}

/** The source red-dev registers, which never has to exist for this. */
const SOURCE = "/home/someone/.red/skills/current";

/**
 * What one host is asked when red-dev declares its registration.
 *
 * The host is picked out of the same table the converge walks, so a
 * spelling that moves there moves here too rather than being asserted
 * against a copy of it.
 */
async function hostCalls(
  name: string,
  tools: readonly Tool[],
  plugins?: readonly string[],
): Promise<string[][]> {
  const host = REGISTRATION_HOSTS.find((h) => h.name === name);
  if (!host) throw new Error(`no host named ${name}`);
  const { calls, run } = recorder();
  await convergeMarketplaceOwnership(UBUNTU, {
    home: mkdtempSync(join(tmpdir(), "red-plugins-registration-")),
    source: SOURCE,
    hosts: [host],
    present: () => true,
    run,
    tools,
    ...(plugins ? { plugins } : {}),
  });
  return calls;
}

function claudeCalls(tools: readonly Tool[], plugins?: readonly string[]): Promise<string[][]> {
  return hostCalls("claude", tools, plugins);
}

function codexCalls(tools: readonly Tool[], plugins?: readonly string[]): Promise<string[][]> {
  return hostCalls("codex", tools, plugins);
}

describe("the loops that reinstall the plugins a registration replaced", () => {
  test("Claude reinstalls the activated plugins, in manifest order", async () => {
    // The activation set and never the whole manifest: a plugin the
    // person switched off is in no host, and a re-registration that
    // brought it back would be the marketplace undoing a choice. Order
    // included: memory builds on dev, and a repair that installs them
    // in some other order can fail on a clean host for a reason nothing
    // on screen explains.
    const activated = activatedPlugins(DECLARED, ["dev", "memory", "brain"]);
    expect(activated).toEqual(DECLARED);
    expect(installedBy(await claudeCalls(TOOLS, activated))).toEqual(DECLARED);
  });

  test("Codex installs the same set from the same source", async () => {
    const activated = activatedPlugins(DECLARED, ["dev", "memory", "brain"]);
    expect(installedBy(await codexCalls(TOOLS, activated))).toEqual(DECLARED);
  });

  test("a machine that chose nothing beyond dev reinstalls dev alone", async () => {
    expect(installedBy(await claudeCalls(TOOLS, activatedPlugins(DECLARED)))).toEqual(["dev"]);
    expect(installedBy(await codexCalls(TOOLS, activatedPlugins(DECLARED)))).toEqual(["dev"]);
  });

  test("a fixture manifest moves both loops with it", async () => {
    const fixture = fixtureManifest("dev", "sparkle");
    const activated = activatedPlugins(["dev", "sparkle"], ["dev", "sparkle"]);
    expect(installedBy(await claudeCalls(fixture, activated))).toEqual(["dev", "sparkle"]);
    expect(installedBy(await codexCalls(fixture, activated))).toEqual(["dev", "sparkle"]);
  });

  test("opting a plugin out installs nothing for it", async () => {
    const kept = DECLARED[0] as string;
    const dropped = DECLARED.filter((n) => n !== kept);
    expect(dropped.length).toBeGreaterThan(0);

    const fixture = fixtureManifest(kept);
    const activated = activatedPlugins([kept], [kept]);
    for (const calls of [await claudeCalls(fixture, activated), await codexCalls(fixture, activated)]) {
      expect(installedBy(calls)).toEqual([kept]);
      for (const name of dropped) {
        expect(calls.flat().join(" ")).not.toContain(`${name}@red-skills`);
      }
    }
  });

  test("the marketplace itself is still registered, whatever the plugin set is", async () => {
    // The plugins are the second half of the declaration. Deriving their
    // set must not quietly drop the first half, which is the
    // re-registration the whole function exists for.
    const calls = await claudeCalls([]);
    expect(calls.map((cmd) => cmd.join(" "))).toEqual([
      "claude plugin marketplace remove red-skills",
      `claude plugin marketplace add ${SOURCE}`,
    ]);
  });
});

describe("opting a plugin out", () => {
  test("removes its entry from the fragment", () => {
    const kept = DECLARED[0] as string;
    const fixture = fixtureManifest(kept);
    const specs = miseEntries(UBUNTU, fixture, []).map((e) => e.spec);
    expect(specs).toEqual([`${REDSKILLS_PLUGIN_PREFIX}${kept}`]);
    for (const name of DECLARED.filter((n) => n !== kept)) {
      expect(specs).not.toContain(`${REDSKILLS_PLUGIN_PREFIX}${name}`);
    }
  });

  test("and a converge after it stops declaring it, so nothing reinstalls it", () => {
    // The failure this pins is the sticky one: the fragment is written
    // once and left alone, so an opted-out plugin keeps being installed
    // by `mise install` from a file nobody rewrote.
    const home = mkdtempSync(join(tmpdir(), "red-plugins-home-"));
    const all = fixtureManifest(...DECLARED);
    const dropped = DECLARED[DECLARED.length - 1] as string;
    const kept = DECLARED.filter((n) => n !== dropped);

    const first = convergeMiseConfig(UBUNTU, { home, tools: all });
    expect(first.changed).toBe(true);
    expect(readFileSync(miseConfigPath(home), "utf8")).toContain(
      `${REDSKILLS_PLUGIN_PREFIX}${dropped}`,
    );

    const second = convergeMiseConfig(UBUNTU, { home, tools: fixtureManifest(...kept) });
    expect(second.changed).toBe(true);
    const fragment = readFileSync(miseConfigPath(home), "utf8");
    expect(fragment).not.toContain(`${REDSKILLS_PLUGIN_PREFIX}${dropped}`);
    for (const name of kept) {
      expect(fragment).toContain(`${REDSKILLS_PLUGIN_PREFIX}${name}`);
    }
  });

  test("a converge that changes nothing rewrites nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "red-plugins-home-"));
    const tools = fixtureManifest(...DECLARED);
    expect(convergeMiseConfig(UBUNTU, { home, tools }).changed).toBe(true);
    expect(convergeMiseConfig(UBUNTU, { home, tools }).changed).toBe(false);
  });
});

/**
 * Which of the carried plugins the hosts switch on.
 *
 * The set carries every payload; the interview decides which of them a
 * host installs. Off means not installed into the host at all — so none
 * of the plugin's hooks or MCP servers run there — which is why Memory
 * and Brain start off and only `dev` is on by itself.
 */
describe("which plugins the hosts switch on", () => {
  const carried = ["dev", "memory", "brain"];

  test("dev alone, unless the machine chose otherwise", () => {
    expect(activatedPlugins(carried)).toEqual(["dev"]);
    expect([...DEFAULT_ACTIVATED_PLUGINS]).toEqual(["dev"]);
  });

  test("a chosen plugin is switched on, in manifest order", () => {
    // Manifest order rather than the order it was asked in: the hosts
    // install in this order, and memory declares dev.
    expect(activatedPlugins(carried, ["brain", "dev"])).toEqual(["dev", "brain"]);
    expect(activatedPlugins(carried, ["dev", "memory", "brain"])).toEqual(carried);
  });

  test("memory brings dev along", () => {
    expect(activatedPlugins(carried, ["memory"])).toEqual(["dev", "memory"]);
  });

  test("nothing chosen switches nothing on", () => {
    expect(activatedPlugins(carried, [])).toEqual([]);
  });

  test("a choice the manifest does not carry activates nothing for it", () => {
    // A stale preference is not a host command: the row is the opt-out,
    // and a name with no row installs nothing.
    expect(activatedPlugins(["dev"], ["dev", "sparkle"])).toEqual(["dev"]);
  });

  test("the recorded choice is read defensively", () => {
    // The preferences file is JSON a person edits. Anything that is not
    // a list of names is the default — never everything off, never
    // everything on.
    expect(chosenPluginsFrom(undefined)).toEqual(["dev"]);
    expect(chosenPluginsFrom("memory")).toEqual(["dev"]);
    expect(chosenPluginsFrom({ memory: true })).toEqual(["dev"]);
    expect(chosenPluginsFrom(["memory", 3, "../etc", "Brain"])).toEqual(["memory"]);
    expect(chosenPluginsFrom([])).toEqual([]);
  });

  test("the interview offers exactly what the manifest declares", () => {
    // A plugin the manifest carries and the interview does not offer is
    // a plugin nobody can switch on; one offered and not carried is a
    // choice that does nothing. The two lists are one fact.
    expect(PLUGIN_CHOICES.map((plugin) => plugin.key)).toEqual(DECLARED);
  });
});
