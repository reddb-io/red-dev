/**
 * What an untick means, and what it is never allowed to mean.
 *
 * The Catalogue is the one list in this project where a checkbox runs a
 * destructive act, so the three things worth pinning are the three ways
 * that goes wrong: an untick that removes nothing (a checkbox that lies),
 * an untick that reaches a scope nobody offered (the identical layer
 * dismantled by a space bar), and an untick that removes something
 * without saying what (the one thing a checkbox must never do).
 *
 * Every removal here is a fake that records rather than runs, which is
 * the point: the module under test must be provably unable to touch the
 * machine before it has asked, and a test that only checked the happy
 * path would prove that by not noticing.
 */

import { describe, expect, test } from "bun:test";
import {
  ADD_A_WEB_APP,
  catalogueLines,
  catalogueRemovals,
  CATALOGUE_SCOPE,
  catalogueTools,
  removalNotice,
  removeUnticked,
  type CatalogueTool,
  type Going,
} from "./catalogue.ts";
import { toolsInScope, type Scope, type Tool } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import type { WebAppRow } from "./webapps.ts";

/**
 * Every scope that is not the Catalogue's. Spelled out rather than
 * derived, the way uninstall.ts spells its own list out: this is the
 * thing being asserted, and a list computed from the code under test
 * would agree with it no matter what the code did.
 */
const MACHINE_SCOPES = ["core", "desktop", "wsl"] as const satisfies readonly Scope[];

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

const DESKTOP = machine({});
const WINDOWS = machine({
  os: "windows",
  distro: null,
  version: null,
  codename: null,
  env: "windows",
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
});

/**
 * A tool row built by hand rather than probed.
 *
 * `catalogueTools` asks the machine running the test whether `just` is on
 * PATH, and the answer differs between a laptop and CI. What the removal
 * half has to be right about is the shape, so the shape is supplied.
 */
function toolRow(over: Partial<CatalogueTool> & { name: string }): CatalogueTool {
  const tool: Tool = {
    name: over.name,
    about: "a command runner",
    scope: "optional",
    u24: { kind: "apt", pkg: over.name },
    win: { kind: "skip", reason: "not offered here" },
  };
  return {
    tool,
    installed: true,
    present: true,
    removal: {
      tool: over.name,
      how: `apt remove ${over.name}`,
      run: async () => {},
    },
    ...over,
  };
}

function webRow(name: string, installed: boolean): WebAppRow {
  return { app: { name, url: `https://${name.toLowerCase()}.example/` }, installed, ticked: installed };
}

/** A remover that records the names it was handed and touches nothing. */
function recorder(): { calls: string[]; removeWeb: (name: string) => string[] } {
  const calls: string[] = [];
  return { calls, removeWeb: (name) => (calls.push(name), [`${name}.desktop`]) };
}

describe("unticking an installed item", () => {
  test("names the tool it will remove, and how", async () => {
    const lines = catalogueLines({
      tools: [toolRow({ name: "just" })],
      webApps: [],
      canAdd: false,
    });
    const going = catalogueRemovals(lines, new Set(), recorder());

    expect(going.map((g) => g.name)).toEqual(["just"]);
    expect(removalNotice(going)).toEqual(["just — apt remove just"]);
  });

  test("names the web app it will remove, and what goes with it", () => {
    const lines = catalogueLines({
      tools: [],
      webApps: [webRow("ChatGPT", true)],
      canAdd: false,
    });
    const going = catalogueRemovals(lines, new Set(), recorder());

    expect(removalNotice(going)).toEqual(["ChatGPT — its launcher and its icon"]);
  });

  test("removes both halves of the list in one act", async () => {
    const lines = catalogueLines({
      tools: [toolRow({ name: "duf" })],
      webApps: [webRow("ChatGPT", true)],
      canAdd: false,
    });
    const io = recorder();
    const going = catalogueRemovals(lines, new Set(), io);
    const outcome = await removeUnticked(going, async () => true);

    expect(outcome.confirmed).toBe(true);
    expect(outcome.failed).toEqual([]);
    expect(outcome.done).toEqual([
      "duf removed (apt remove duf)",
      "ChatGPT removed (1 file(s))",
    ]);
    expect(io.calls).toEqual(["ChatGPT"]);
  });

  test("a tick left alone removes nothing", () => {
    const lines = catalogueLines({
      tools: [toolRow({ name: "just" })],
      webApps: [webRow("ChatGPT", true)],
      canAdd: true,
    });
    const chosen = new Set(lines.map((l) => l.label));

    expect(catalogueRemovals(lines, chosen, recorder())).toEqual([]);
    // And the list opens with every installed thing ticked, which is what
    // makes the sentence above true in practice rather than only here.
    expect(lines.filter((l) => l.label !== ADD_A_WEB_APP).every((l) => l.ticked)).toBe(true);
  });

  test("unticking something that is not there removes nothing", () => {
    const lines = catalogueLines({
      tools: [toolRow({ name: "gitui", installed: false, present: false, removal: null })],
      webApps: [webRow("Tailscale", false)],
      canAdd: false,
    });

    expect(catalogueRemovals(lines, new Set(), recorder())).toEqual([]);
  });

  test("an installed tool this project cannot undo says so instead of pretending", () => {
    const lines = catalogueLines({
      tools: [toolRow({ name: "blender", removal: null })],
      webApps: [],
      canAdd: false,
    });

    expect(lines[0]?.label).toContain("`red-dev uninstall`");
    expect(catalogueRemovals(lines, new Set(), recorder())).toEqual([]);
  });
});

describe("the scopes an untick can reach", () => {
  test("is exactly one, and it is optional", () => {
    expect(CATALOGUE_SCOPE).toBe("optional");
  });

  test("no core, desktop or wsl tool is ever offered", () => {
    for (const p of [DESKTOP, WINDOWS]) {
      const offered = new Set(catalogueTools(p).map((t) => t.tool.name));
      expect(offered.size).toBeGreaterThan(0);

      for (const scope of MACHINE_SCOPES) {
        for (const tool of toolsInScope(scope)) {
          expect(offered.has(tool.name)).toBe(false);
        }
      }
    }
  });

  test("every row it does offer declares the optional scope", () => {
    for (const p of [DESKTOP, WINDOWS]) {
      for (const row of catalogueTools(p)) expect(row.tool.scope).toBe("optional");
    }
  });

  test("a scope the target cannot use is not offered either", () => {
    // PowerToys is optional and real, and its Linux provider is a skip.
    // Filtering on the scope alone would put a row on a machine where
    // ticking it does nothing and unticking it names a removal that
    // cannot run.
    expect(catalogueTools(DESKTOP).map((t) => t.tool.name)).not.toContain("powertoys");
    expect(catalogueTools(WINDOWS).map((t) => t.tool.name)).toContain("powertoys");
  });
});

describe("the naming step", () => {
  /** A removal that records the order it was asked in, and never runs. */
  function watched(name: string, order: string[]): Going {
    return {
      name,
      what: `apt remove ${name}`,
      run: async () => (order.push(`run:${name}`), "gone"),
    };
  }

  test("a refusal removes nothing", async () => {
    const order: string[] = [];
    const going = [watched("just", order), watched("duf", order)];
    const outcome = await removeUnticked(going, async () => (order.push("asked"), false));

    expect(order).toEqual(["asked"]);
    expect(outcome).toEqual({ confirmed: false, done: [], failed: [] });
  });

  test("the question comes before the first removal, not between them", async () => {
    const order: string[] = [];
    const going = [watched("just", order), watched("duf", order)];
    await removeUnticked(going, async () => (order.push("asked"), true));

    expect(order).toEqual(["asked", "run:just", "run:duf"]);
  });

  test("nothing unticked asks nothing", async () => {
    let asked = 0;
    const outcome = await removeUnticked([], async () => (asked++, true));

    expect(asked).toBe(0);
    expect(outcome).toEqual({ confirmed: false, done: [], failed: [] });
  });

  test("the question counts what it is about to do", async () => {
    const questions: string[] = [];
    const ask = async (q: string): Promise<boolean> => (questions.push(q), false);
    const order: string[] = [];

    await removeUnticked([watched("just", order)], ask);
    await removeUnticked([watched("just", order), watched("duf", order)], ask);

    expect(questions).toEqual(["Remove it?", "Remove all 2?"]);
  });

  test("one failure does not stop the rest, and is reported", async () => {
    const order: string[] = [];
    const going: Going[] = [
      { name: "just", what: "apt remove just", run: async () => { throw new Error("apt is locked"); } },
      watched("duf", order),
    ];
    const outcome = await removeUnticked(going, async () => true);

    expect(outcome.confirmed).toBe(true);
    expect(outcome.done).toEqual(["duf removed (gone)"]);
    expect(outcome.failed).toEqual([{ name: "just", reason: "apt is locked" }]);
  });
});
