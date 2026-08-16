/**
 * What a converge writes to a GNOME desktop, and what it must not.
 *
 * Nothing here can be answered by the machine the tests run on: dconf
 * belongs to a signed-in session, and the interesting states — a machine
 * that already matches, one carrying a person's own shortcuts, one still
 * holding a red-dev entry the registry has since dropped — are states
 * nobody would create by hand to find out. They are fixtures, and the
 * plan is a pure function of them for exactly that reason.
 *
 * Four promises are held below. The writes are the ones GNOME reads,
 * paths included; a converge that changes nothing writes nothing; a
 * withdrawal reaches red-dev's own entries and no others; and an action
 * this adapter will not bind is reported with a reason rather than
 * handed a second chord — which is ADR 0006's rule and the one a
 * well-meaning adapter breaks first.
 */

import { describe, expect, test } from "bun:test";
import { ACTIONS, actionById, parseChord } from "./actions/index.ts";
import {
  commandLine,
  CUSTOM_ROOT,
  GNOME_ACTIONS,
  GNOME_BINDINGS,
  gnomeAccel,
  gnomeCustoms,
  gnomePlan,
  gnomeRefusal,
  installGnomeKeys,
  isOwned,
  normalAccel,
  ownedPath,
  parseGvariantList,
  type GnomeCustom,
  type GnomeState,
} from "./gnome-keys.ts";
import { firePlan, keyEntries } from "./keys.ts";
import type { Platform } from "./platform.ts";

const MEDIA_KEYS = "org.gnome.settings-daemon.plugins.media-keys";
const CUSTOM_SCHEMA = `${MEDIA_KEYS}.custom-keybinding`;

const desktop: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

/** Everything this machine could want is on PATH, so commands are fixed. */
const anything = (cmd: string): string => `/usr/bin/${cmd}`;
const nothing = (): string | null => null;

const fire = (id: string) => firePlan(id, desktop, anything);

/** A GNOME with nothing of its own and nothing of ours. */
function bare(over: Partial<GnomeState> = {}): GnomeState {
  return { list: [], owned: [], launchTerminal: ["<Primary><Alt>t"], ...over };
}

/** The state a machine is in once this adapter has converged onto it. */
function converged(customs: readonly GnomeCustom[], theirs: readonly string[] = []): GnomeState {
  return {
    list: [...theirs, ...customs.map((c) => c.path)],
    owned: customs.map((c) => ({ ...c })),
    // Cleared, because red-dev holds Ctrl+Alt+T on a converged machine.
    launchTerminal: [],
  };
}

const { customs } = gnomeCustoms(fire);

describe("the shortcuts a GNOME desktop is given", () => {
  test("are the actions that apply here, minus the ones declared refused", () => {
    // The criterion in one line and derived from the registry rather
    // than repeated: an action added to `src/actions/` with `desktop`
    // among its platforms fails this until somebody decides, out loud,
    // whether it gets a chord here or a reason.
    const applicable = ACTIONS.filter((a) => a.platforms.includes("desktop")).map((a) => a.id);
    const answered = [...GNOME_ACTIONS, ...applicable.filter((id) => gnomeRefusal(id))];
    expect([...answered].sort()).toEqual([...applicable].sort());
  });

  test("carry the registry's chord, spelled the way GTK spells one", () => {
    // No second copy of any chord lives in this adapter. Change the
    // registry and the accelerator moves with it; hard-code one here and
    // this fails the moment they disagree.
    for (const binding of GNOME_BINDINGS) {
      const chord = actionById(binding.id)?.chord;
      expect(chord).toBeDefined();
      expect(binding.accel).toBe(gnomeAccel(parseChord(chord as string) as never) as string);
    }
    const accel = (id: string) => GNOME_BINDINGS.find((b) => b.id === id)?.accel;
    expect(accel("terminal.new")).toBe("<Control><Alt>t");
    expect(accel("keys.viewer")).toBe("<Shift><Control><Alt>k");
  });

  test("live at paths named after the action, never at GNOME's custom0", () => {
    // Ownership is the path. GNOME's Settings allocates custom0,
    // custom1, … and renumbers nothing, so an adapter picking the next
    // free index would hand back a path somebody else's shortcut owns
    // after a reorder — and withdrawal would then delete theirs.
    expect(ownedPath("terminal.new")).toBe(`${CUSTOM_ROOT}red-dev-terminal-new/`);
    expect(isOwned(ownedPath("panel.audio"))).toBe(true);
    expect(isOwned(`${CUSTOM_ROOT}custom0/`)).toBe(false);
    for (const binding of GNOME_BINDINGS) expect(binding.path).toBe(ownedPath(binding.id));
  });

  test("and are named so a person browsing GNOME's Settings sees whose they are", () => {
    expect(GNOME_BINDINGS.map((b) => b.name)).toContain("red-dev: Keys viewer");
    for (const binding of GNOME_BINDINGS) {
      expect(binding.name).toBe(`red-dev: ${actionById(binding.id)?.label}`);
    }
  });
});

describe("what a converge writes", () => {
  const steps = gnomePlan(bare(), customs);
  const argvs = steps.map((s) => s.argv);

  test("is name, command and binding, for each registered action", () => {
    // The whole write per shortcut, path included, because the path is
    // the allocation: a right name and command under the wrong path is a
    // keybinding GNOME never reads, and two actions sharing one path is
    // one shortcut overwriting the other.
    for (const [id, name, command, accel] of [
      ["terminal.new", "red-dev: Terminal", "alacritty", "<Control><Alt>t"],
      ["menu.open", "red-dev: red-dev menu", "alacritty -e red-dev menu", "<Shift><Control><Alt>m"],
      ["keys.viewer", "red-dev: Keys viewer", "alacritty -e red-dev keys", "<Shift><Control><Alt>k"],
      ["emoji.pick", "red-dev: Emoji picker", "alacritty -e red-dev emoji", "<Shift><Control><Alt>e"],
      ["panel.network", "red-dev: Network panel", "alacritty -e red-dev panel network", "<Shift><Control><Alt>n"],
      ["panel.audio", "red-dev: Audio panel", "alacritty -e red-dev panel audio", "<Shift><Control><Alt>a"],
      ["panel.power", "red-dev: Power panel", "alacritty -e red-dev panel power", "<Shift><Control><Alt>p"],
      ["agent.launch", "red-dev: Default agent", "alacritty -e red-dev agents run", "<Shift><Control><Alt>g"],
      ["agent.multiplex", "red-dev: Agent multiplexer", "alacritty -e herdr", "<Shift><Control><Alt>h"],
    ] as const) {
      const schema = `${CUSTOM_SCHEMA}:${CUSTOM_ROOT}red-dev-${id.replace(".", "-")}/`;
      expect(argvs).toContainEqual(["set", schema, "name", name]);
      expect(argvs).toContainEqual(["set", schema, "command", command]);
      expect(argvs).toContainEqual(["set", schema, "binding", accel]);
    }
  });

  test("then the list GNOME actually reads, once, with every path on it", () => {
    // Values first and the list second: a path is inert until it is
    // listed, so this order never leaves a listed shortcut half written.
    const list = argvs.filter((a) => a[2] === "custom-keybindings");
    expect(list).toHaveLength(1);
    expect(list[0]?.[3]).toBe(`[${customs.map((c) => `'${c.path}'`).join(", ")}]`);
    const values = argvs
      .map((a, i) => (a[0] === "set" && a[1]?.startsWith(CUSTOM_SCHEMA) ? i : -1))
      .filter((i) => i >= 0);
    expect(Math.max(...values)).toBeLessThan(argvs.indexOf(list[0] as string[]));
  });

  test("and clears GNOME's own Ctrl+Alt+T, so the chord has one owner", () => {
    // GNOME ships launch-terminal on the same key — which is why ADR
    // 0006 adopted it rather than colliding with it — and it opens
    // whatever the session's default handler is, not the terminal red-dev
    // installed. Two grabs on one accelerator is not a behaviour to find
    // out about on somebody's machine.
    expect(argvs).toContainEqual(["set", MEDIA_KEYS, "terminal", "@as []"]);
  });

  test("the command is the one Enter runs in the viewer, not a second copy of it", () => {
    // One decision, `firePlan`, feeding both. A chord and the viewer
    // opening two different things is the failure this avoids, and it is
    // the kind nobody notices until the day the two disagree.
    const plan = firePlan("panel.network", desktop, anything);
    const custom = customs.find((c) => c.path === ownedPath("panel.network"));
    expect(custom?.command).toBe(commandLine(plan.ok ? plan.argv : []));
  });

  test("and is quoted where GNOME would otherwise split it into two arguments", () => {
    expect(commandLine(["red-dev", "panel", "network"])).toBe("red-dev panel network");
    expect(commandLine(["/opt/my tools/red-dev", "keys"])).toBe("'/opt/my tools/red-dev' keys");
  });

  test("an action with nothing here to run is skipped, and said to be skipped", () => {
    // A keybinding pointing at a program that is not installed is a key
    // somebody was told works. herdr is the one that is genuinely
    // optional; on a machine with no terminal emulator at all, every
    // surface lands here.
    const withoutHerdr = gnomeCustoms((id) =>
      firePlan(id, desktop, (cmd) => (cmd === "herdr" ? null : anything(cmd))),
    );
    expect(withoutHerdr.customs.map((c) => c.path)).not.toContain(ownedPath("agent.multiplex"));
    expect(withoutHerdr.skipped.map((s) => s.id)).toEqual(["agent.multiplex"]);
    expect(withoutHerdr.skipped[0]?.detail).toContain("herdr is not installed");

    const headless = gnomeCustoms((id) => firePlan(id, desktop, nothing));
    expect(headless.customs).toEqual([]);
    expect(headless.skipped).toHaveLength(GNOME_BINDINGS.length);
  });
});

describe("a converge that finds the machine already right", () => {
  test("writes nothing at all", () => {
    // Not a micro-optimisation: every step is a write to the person's
    // own dconf, and a converge that rewrites four keys per action per
    // run is one whose diff nobody can read — and whose log says it
    // changed something every time it did not.
    expect(gnomePlan(converged(customs), customs)).toEqual([]);
  });

  test("even where a person's own shortcuts share the list", () => {
    const theirs = [`${CUSTOM_ROOT}custom0/`, `${CUSTOM_ROOT}custom1/`];
    expect(gnomePlan(converged(customs, theirs), customs)).toEqual([]);
  });

  test("and where GNOME spells the accelerator its own way", () => {
    // `<Primary>` is GTK's other name for Control and a hand-edited
    // `<Alt><Control>T` means the same key. Comparing literally would
    // rewrite every binding on every converge, which is the regression
    // the Windows adapter shipped twice before its Normal() landed.
    const state = converged(customs);
    const rewritten = state.owned.map((c) => ({
      ...c,
      binding: c.binding.replace("<Control>", "<Primary>"),
    }));
    expect(gnomePlan({ ...state, owned: rewritten }, customs)).toEqual([]);
    expect(normalAccel("<Primary><Alt>t")).toBe(normalAccel("<Alt><Control>T"));
  });

  test("but repairs one whose command has drifted", () => {
    const state = converged(customs);
    const stale = state.owned.map((c) =>
      c.path === ownedPath("emoji.pick") ? { ...c, command: "xterm -e red-dev emoji" } : c,
    );
    const steps = gnomePlan({ ...state, owned: stale }, customs);
    expect(steps.map((s) => s.argv)).toEqual([
      ["set", `${CUSTOM_SCHEMA}:${ownedPath("emoji.pick")}`, "name", "red-dev: Emoji picker"],
      ["set", `${CUSTOM_SCHEMA}:${ownedPath("emoji.pick")}`, "command", "alacritty -e red-dev emoji"],
      ["set", `${CUSTOM_SCHEMA}:${ownedPath("emoji.pick")}`, "binding", "<Shift><Control><Alt>e"],
    ]);
  });

  test("and the converge itself calls gsettings only to read", async () => {
    // The same promise held one layer up, through the code a converge
    // actually runs: a machine that matches is read and left alone.
    const calls: string[][] = [];
    const state = converged(customs, [`${CUSTOM_ROOT}custom0/`]);
    const run = async (argv: string[]): Promise<string | null> => {
      calls.push(argv);
      return answer(argv, state);
    };
    await installGnomeKeys(desktop, run, fire);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((a) => a[0] !== "get")).toEqual([]);
  });

  test("and a machine with no GNOME to ask is skipped rather than guessed at", async () => {
    const calls: string[][] = [];
    await installGnomeKeys(desktop, async (argv) => {
      calls.push(argv);
      return null;
    }, fire);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["get", MEDIA_KEYS, "custom-keybindings"]);
  });
});

describe("withdrawing what red-dev no longer registers", () => {
  const mine = `${CUSTOM_ROOT}red-dev-panel-bluetooth/`;
  const yours = `${CUSTOM_ROOT}custom0/`;
  const state: GnomeState = {
    list: [yours, mine, ...customs.map((c) => c.path)],
    owned: [
      { path: mine, name: "red-dev: Bluetooth panel", command: "alacritty -e red-dev panel bluetooth", binding: "<Shift><Control><Alt>b" },
      ...customs.map((c) => ({ ...c })),
    ],
    launchTerminal: [],
  };
  const steps = gnomePlan(state, customs);

  test("resets red-dev's own stale entry", () => {
    expect(steps.map((s) => s.argv)).toContainEqual(["reset-recursively", `${CUSTOM_SCHEMA}:${mine}`]);
  });

  test("and touches nothing a person set themselves", () => {
    // The one that would be invisible until somebody's shortcut stopped
    // working: withdrawal reaches only paths carrying red-dev's own
    // segment, and `custom0` is not one however long it has been there.
    // The schema a step addresses is what decides whose setting it
    // changes. `custom0` appears once below, inside the list value that
    // keeps it — and nowhere as something being written or reset.
    const argvs = steps.map((s) => s.argv);
    expect(argvs.some((a) => (a[1] ?? "").includes("custom0"))).toBe(false);
    expect(argvs).not.toContainEqual(["reset-recursively", `${CUSTOM_SCHEMA}:${yours}`]);
  });

  test("keeping their entry, in their order, in the list it rewrites", () => {
    const list = steps.find((s) => s.argv[2] === "custom-keybindings");
    expect(list?.argv[3]).toBe(`[${[yours, ...customs.map((c) => c.path)].map((p) => `'${p}'`).join(", ")}]`);
    expect(parseGvariantList(list?.argv[3] as string)[0]).toBe(yours);
  });

  test("and the entry leaves the list before its values are reset", () => {
    // The reverse of the order a write uses, and for the same reason: a
    // listed path whose keys have been reset is a shortcut GNOME reads
    // while it is half gone.
    const argvs = steps.map((s) => s.argv);
    const listed = argvs.findIndex((a) => a[2] === "custom-keybindings");
    const reset = argvs.findIndex((a) => a[0] === "reset-recursively");
    expect(listed).toBeGreaterThan(-1);
    expect(listed).toBeLessThan(reset);
  });

  test("and GNOME's own launch-terminal binding comes back when red-dev drops that chord", () => {
    // The takeover is exactly as reversible as everything else here.
    // Only where red-dev is the one letting go: an empty
    // launch-terminal binding on a machine red-dev never took it from is
    // the person's own setting.
    const withoutTerminal = customs.filter((c) => c.path !== ownedPath("terminal.new"));
    const steps = gnomePlan(state, withoutTerminal);
    expect(steps.map((s) => s.argv)).toContainEqual(["reset", MEDIA_KEYS, "terminal"]);

    const untouched = gnomePlan({ ...bare(), launchTerminal: [] }, withoutTerminal);
    expect(untouched.map((s) => s.argv)).not.toContainEqual(["reset", MEDIA_KEYS, "terminal"]);
  });
});

describe("an action this adapter will not bind", () => {
  test("is reported unbound, with the reason, on the row that keeps its chord", () => {
    // ADR 0006: where a host will not take the chord, the adapter
    // reports the action unbound with the reason. The elevated shell is
    // that case on Linux — there is no such act here for a key to open.
    const entry = keyEntries(desktop).find((e) => e.id === "terminal.elevated");
    expect(entry?.state).toBe("unsupported");
    expect(entry?.reason).toBe(gnomeRefusal("terminal.elevated") as string);
    expect(entry?.reason).toContain("sudo in the terminal you already have");
    // Not "broken": nobody has a shortcut to fix, and reporting it that
    // way would send whoever reads it looking for one.
    expect(entry?.reason).not.toContain("no chord came back");
    // The chord it was given stays on the row, unbound. It is the same
    // key on every target, and blanking it here would make the viewer
    // disagree with the Windows machine the same person uses.
    expect(entry?.chord).toBe("Ctrl+Alt+Shift+T");
  });

  test("and gets no second chord anywhere in the adapter", () => {
    // The rule a well-meaning adapter breaks first: no substitute is
    // invented for it, on any path, under any name.
    expect(GNOME_ACTIONS).not.toContain("terminal.elevated");
    expect(GNOME_BINDINGS.map((b) => b.id)).not.toContain("terminal.elevated");
    expect(customs.map((c) => c.path)).not.toContain(ownedPath("terminal.elevated"));
    const written = gnomePlan(bare(), customs).map((s) => s.argv.join(" ")).join("\n");
    expect(written).not.toContain("red-dev-terminal-elevated");
    // And no accelerator red-dev writes is one the registry did not
    // choose, which is the general form of the same promise.
    const chords = new Set(
      ACTIONS.map((a) => gnomeAccel(parseChord(a.chord) as never)).filter(Boolean),
    );
    for (const custom of customs) expect(chords.has(custom.binding)).toBe(true);
  });

  test("and a chord GNOME has no name for is refused rather than approximated", () => {
    // The other half of "never invents a local substitute", held on the
    // spelling: a key this adapter cannot name for GTK produces no
    // accelerator at all, rather than the nearest one it does know.
    expect(gnomeAccel({ ctrl: true, alt: true, shift: false, win: false, key: "MOON" })).toBeNull();
    expect(gnomeAccel({ ctrl: true, alt: true, shift: true, win: false, key: "PAGEUP" }))
      .toBe("<Shift><Control><Alt>Page_Up");
  });
});

/** What a machine in `state` answers to each read the converge makes. */
function answer(argv: string[], state: GnomeState): string | null {
  const [verb, schema, key] = argv;
  if (verb !== "get") return "";
  if (schema === MEDIA_KEYS && key === "custom-keybindings") {
    return `[${state.list.map((p) => `'${p}'`).join(", ")}]`;
  }
  if (schema === MEDIA_KEYS && key === "terminal") {
    return state.launchTerminal === null ? null : `[${state.launchTerminal.map((a) => `'${a}'`).join(", ")}]`;
  }
  const path = (schema ?? "").split(":")[1] ?? "";
  const custom = state.owned.find((c) => c.path === path);
  if (!custom) return null;
  const value = key === "name" ? custom.name : key === "command" ? custom.command : custom.binding;
  return `'${value}'`;
}
