/**
 * The viewer's two promises, held against machines it cannot be run on.
 *
 * The first is that nothing is hidden: every action in the registry is
 * on the list on every target, and the ones this machine does not bind
 * carry the reason. The second is that Enter fires the action that is
 * highlighted — which is the whole claim of "the viewer is also a
 * launcher", and the one that would fail silently, by starting the
 * neighbouring row's command, if the search and the selection ever
 * disagreed about which list they are indexing.
 *
 * Every platform here is a fixture. The interesting cases are the
 * targets this test process is not running on — a Windows host binds
 * through the Start Menu, a GNOME desktop through custom keybindings,
 * and a server has no display to press a key on — and none of those is
 * answerable by asking the machine underneath.
 */

import { describe, expect, test } from "bun:test";
import { ACTIONS } from "./actions/index.ts";
import type { SemanticAction } from "./actions/index.ts";
import { GNOME_ACTIONS } from "./gnome-keys.ts";
import { START_MENU_ACTIONS } from "./hotkeys.ts";
import {
  fireEntry,
  firePlan,
  keyEntries,
  keyLines,
  searchKeys,
  VIEWER_START,
  viewerStep,
  type KeyEntry,
  type ViewerKey,
  type ViewerState,
} from "./keys.ts";
import type { Platform } from "./platform.ts";

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

const desktop = machine({});
const server = machine({ env: "server", caps: { apt: true, gui: false, systemd: true, winget: false, flatpak: false } });
const windows = machine({ os: "windows", env: "windows", distro: null, version: null, codename: null });

/** Nothing is on PATH unless a test says it is. */
const nothing = (): string | null => null;
const anything = (cmd: string): string => `/usr/bin/${cmd}`;

/** A whole registry of one, so a fault can exist without shipping one. */
function only(over: Partial<SemanticAction>): readonly SemanticAction[] {
  return [
    {
      id: "fixture.one",
      label: "A fixture",
      platforms: ["desktop", "windows"],
      mutates: false,
      privileged: false,
      chord: "Ctrl+Alt+J",
      ...over,
    },
  ];
}

/** No key pressed; each test turns on the one it means. */
function press(over: Partial<ViewerKey> = {}): ViewerKey {
  return {
    upArrow: false,
    downArrow: false,
    return: false,
    escape: false,
    backspace: false,
    delete: false,
    ctrl: false,
    ...over,
  };
}

/** Type a string into the viewer, one keystroke at a time. */
function typed(entries: readonly KeyEntry[], text: string): ViewerState {
  let state = VIEWER_START;
  for (const ch of text) state = viewerStep(entries, state, ch, press()).state;
  return state;
}

describe("the list", () => {
  test("carries every action, on every target", () => {
    for (const p of [desktop, server, windows]) {
      expect(keyEntries(p).map((e) => e.id)).toEqual(ACTIONS.map((a) => a.id));
    }
  });

  test("says which chord each action carries, in the spelling a person says", () => {
    const terminal = keyEntries(windows).find((e) => e.id === "terminal.new");
    expect(terminal?.chord).toBe("Ctrl+Alt+T");
    expect(terminal?.label).toBe("Terminal");
  });

  test("on Windows, every action the Start Menu adapter claims is bound", () => {
    // The acceptance criterion, read off the same list the adapter
    // writes from: a chord printed here is a chord the .lnk carries.
    // This is the row that used to hold the two terminal actions alone,
    // while the other seven printed a chord a person could press to no
    // effect — the viewer promising something the machine did not do.
    for (const id of START_MENU_ACTIONS) {
      const entry = keyEntries(windows).find((e) => e.id === id);
      expect(entry?.state).toBe("bound");
      expect(entry?.reason).toBe("");
    }
    // Named as well as derived, so the loop above cannot pass by being
    // empty and so the set itself is a decision somebody has to change
    // on purpose.
    expect([...START_MENU_ACTIONS]).toEqual([
      "terminal.new",
      "terminal.elevated",
      "menu.open",
      "keys.viewer",
      "emoji.pick",
      "panel.network",
      "panel.audio",
      "panel.power",
      "agent.launch",
    ]);
  });

  test("on a GNOME desktop, every action the keybindings adapter registers is bound", () => {
    // The acceptance criterion, read off the same list the adapter
    // writes from. Until it landed this row read `unsupported` for all
    // ten actions on the target red-dev was born for: the chords were
    // printed, the ADR promised they were the same everywhere, and not
    // one of them fired.
    for (const id of GNOME_ACTIONS) {
      const entry = keyEntries(desktop).find((e) => e.id === id);
      expect(entry?.state).toBe("bound");
      expect(entry?.reason).toBe("");
    }
    // Named as well as derived, so the loop cannot pass by being empty
    // and so the set is a decision somebody has to change on purpose.
    expect([...GNOME_ACTIONS]).toEqual([
      "terminal.new",
      "menu.open",
      "keys.viewer",
      "emoji.pick",
      "panel.network",
      "panel.audio",
      "panel.power",
      "agent.launch",
      "agent.multiplex",
    ]);
  });

  test("and the one it will not bind is the only unbound row there", () => {
    // herdr's chord is bound here and not on Windows, which is the
    // mirror image of the Start Menu's one gap — the same registry, two
    // adapters, each honest about what its host can do.
    const unbound = keyEntries(desktop).filter((e) => e.state !== "bound");
    expect(unbound.map((e) => e.id)).toEqual(["terminal.elevated"]);
  });

  test("an action the Windows adapter has never carried says so, and is not called broken", () => {
    // The distinction that matters, and the one widening the claimed set
    // must not blur: the Start Menu adapter registers the entries it
    // has, and `agent.multiplex` is deliberately not one — herdr has no
    // Windows build, and it runs inside WSL, where a Start Menu .lnk
    // written on every host cannot follow it.
    //
    // Reporting that as "broken" would send whoever reads it looking for
    // a shortcut nobody ever wrote. It is only visible from inside WSL:
    // on a native Windows host the row is answered a step earlier, by
    // the action not applying to `windows` at all.
    const wsl = machine({ env: "wsl" });
    const herdr = keyEntries(wsl).find((e) => e.id === "agent.multiplex");
    expect(herdr?.state).toBe("unsupported");
    expect(herdr?.reason).toContain("Windows Start Menu");
    expect(herdr?.reason).toContain("no shortcut for it yet");
    // Not the registry-failure sentence, which is the other silence and
    // the one that means somebody has to fix a shortcut.
    expect(herdr?.reason).not.toContain("no chord came back");
  });
});

describe("an action this target does not bind", () => {
  test("is listed, not hidden, and the reason says the target has no adapter", () => {
    // A target with no adapter at all, which is the sentence Ubuntu
    // desktop printed for every row until the GNOME adapter landed. It
    // takes a fixture to reach now: the three targets that can press a
    // key all have an adapter, so the only way to a machine without one
    // is an action that applies where no adapter does. Kept, because
    // that is the state every new target starts in.
    const [entry] = keyEntries(server, only({ id: "terminal.new", platforms: ["server"] }));
    expect(entry?.state).toBe("unsupported");
    expect(entry?.reason).toContain("no bindings adapter for server");
  });

  test("that does not apply here at all says so, and names where it does", () => {
    const entry = keyEntries(server).find((e) => e.id === "terminal.new");
    expect(entry?.state).toBe("unsupported");
    expect(entry?.reason).toContain("does not apply to server");
    expect(entry?.reason).toContain("desktop, wsl, windows");
  });

  test("and the reason reaches the printed list, on the row", () => {
    const lines = keyLines(keyEntries(server));
    expect(lines).toHaveLength(ACTIONS.length);
    const line = lines.find((l) => l.includes("terminal.new"));
    expect(line).toContain("unbound");
    expect(line).toContain("does not apply to server");
  });

  test("a bound row is printed without a reason trailing it", () => {
    const line = keyLines(keyEntries(windows)).find((l) => l.includes("terminal.new"));
    expect(line).toContain("bound");
    expect(line).not.toContain("—");
  });
});

describe("broken and not-supported are different news", () => {
  test("a chord nothing can read is broken, in the validator's own words", () => {
    // Not "unsupported": this is wrong everywhere and somebody has to
    // fix it, which is exactly the distinction the two states exist to
    // keep. The sentence is the validator's so the viewer and `doctor`
    // cannot describe one fault two ways.
    const [entry] = keyEntries(desktop, only({ chord: "Ctrl+Alt+J+K" }));
    expect(entry?.state).toBe("broken");
    expect(entry?.reason).toBe('chord "Ctrl+Alt+J+K" is not one readable chord');
  });

  test("an action the adapter has never carried names the adapter, not a fault", () => {
    // Applies to Windows, the Windows adapter exists, and it carries no
    // entry for it. That used to be reported as broken, which read as
    // "somebody has to fix this shortcut" about a shortcut nobody ever
    // wrote — and it is the state every action lands in between joining
    // the registry and its adapter half landing. `broken` is kept for
    // the adapter carrying an entry that yields no chord.
    const [entry] = keyEntries(windows, only({}));
    expect(entry?.state).toBe("unsupported");
    expect(entry?.reason).toContain("Windows Start Menu");
    expect(entry?.reason).toContain("no shortcut for it yet");
  });

  test("and a broken chord is reported even where the action does not apply", () => {
    const [entry] = keyEntries(server, only({ chord: "" }));
    expect(entry?.state).toBe("broken");
  });
});

describe("searching", () => {
  const entries = keyEntries(windows);

  test("with nothing typed, everything is visible", () => {
    expect(searchKeys(entries, "")).toHaveLength(ACTIONS.length);
  });

  test("matches the label, the id and the chord, in any case", () => {
    expect(searchKeys(entries, "elevated").map((e) => e.id)).toEqual(["terminal.elevated"]);
    expect(searchKeys(entries, "terminal.new").map((e) => e.id)).toEqual(["terminal.new"]);
    expect(searchKeys(entries, "ctrl+alt+shift+t").map((e) => e.id)).toEqual([
      "terminal.elevated",
    ]);
  });

  test("every word has to match, in any order", () => {
    expect(searchKeys(entries, "shift terminal").map((e) => e.id)).toEqual([
      "terminal.elevated",
    ]);
    expect(searchKeys(entries, "terminal nonsense")).toEqual([]);
  });

  test("the state is searchable, so 'unbound work' is one query", () => {
    expect(searchKeys(keyEntries(server), "unsupported")).toHaveLength(ACTIONS.length);
    // On Windows the adapter now claims everything that applies, so the
    // query answers with the one row that does not: herdr, which has no
    // Windows build. That is the platform sentence rather than the
    // missing-shortcut one, and it is the whole of what this machine
    // leaves unregistered.
    expect(searchKeys(entries, "unsupported").map((e) => e.id)).toEqual(["agent.multiplex"]);
  });
});

describe("what Enter runs", () => {
  test("selecting an entry dispatches that action, not the row above it", async () => {
    // The whole point of the viewer being a launcher: type enough to
    // isolate a row, press Enter, and the thing that starts is that
    // row's action. A search and a selection indexing different lists
    // would fail here by starting the terminal instead.
    const entries = keyEntries(windows);
    const state = typed(entries, "elev");
    const step = viewerStep(entries, state, "", press({ return: true }));
    expect(step.fire?.id).toBe("terminal.elevated");

    const started: string[][] = [];
    const outcome = await fireEntry(step.fire!, windows, (argv) => {
      started.push(argv);
      return 0;
    }, nothing);

    expect(outcome.fired).toBe(true);
    expect(started).toHaveLength(1);
    expect(started[0]?.join(" ")).toContain("Start-Process powershell -Verb RunAs");
  });

  test("the terminal action opens the same thing its shortcut points at", async () => {
    const [terminal] = keyEntries(windows);
    const started: string[][] = [];
    await fireEntry(terminal!, windows, (argv) => started.push(argv), (cmd) =>
      cmd === "alacritty.exe" ? "C:\\alacritty.exe" : null,
    );
    expect(started[0]).toEqual(["cmd.exe", "/c", "start", "", "alacritty.exe"]);

    // Without Alacritty, WSL in the home directory — the fallback the
    // Start Menu shortcut already uses.
    const withoutIt: string[][] = [];
    await fireEntry(terminal!, windows, (argv) => withoutIt.push(argv), nothing);
    expect(withoutIt[0]).toEqual(["cmd.exe", "/c", "start", "", "wsl.exe", "--cd", "~"]);
  });

  test("an unbound action still runs — that is what the viewer is for", async () => {
    // A machine whose chord nothing registers still opens the thing.
    // Someone who reached the viewer to find the terminal gets the
    // terminal, rather than a row telling them the chord they came here
    // to find does not work.
    const [terminal] = keyEntries(server, only({ id: "terminal.new", platforms: ["server"] }));
    expect(terminal?.state).toBe("unsupported");
    const started: string[][] = [];
    const outcome = await fireEntry(terminal!, server, (argv) => started.push(argv), anything);
    expect(outcome.fired).toBe(true);
    expect(started[0]).toEqual(["alacritty"]);
  });

  test("and a refusal is a sentence, not a process that fails elsewhere", async () => {
    const elevated = keyEntries(desktop).find((e) => e.id === "terminal.elevated")!;
    const started: string[][] = [];
    const outcome = await fireEntry(elevated, desktop, (argv) => started.push(argv), anything);
    expect(outcome.fired).toBe(false);
    expect(outcome.detail).toContain("sudo");
    expect(started).toEqual([]);
  });

  test("a machine with no terminal emulator says which ones were looked for", () => {
    const plan = firePlan("terminal.new", desktop, nothing);
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.detail).toContain("alacritty");
  });

  test("the network Panel opens in a terminal of its own, not inside the viewer", () => {
    // Two full-screen surfaces on one frame is what firing it in place
    // would produce. On Windows that means `start` with the empty title
    // slot, the same idiom the terminal action uses to avoid handing the
    // new window the console red-dev is drawing in.
    const onWindows = firePlan("panel.network", windows, anything);
    expect(onWindows.ok && onWindows.argv).toEqual([
      "cmd.exe", "/c", "start", "", "red-dev.exe", "panel", "network",
    ]);

    const onUbuntu = firePlan("panel.network", desktop, anything);
    expect(onUbuntu.ok && onUbuntu.argv).toEqual([
      "alacritty", "-e", "red-dev", "panel", "network",
    ]);
  });

  test("and every other Panel opens the same way, under the name on its id", () => {
    // firePlan carries one case for all of them and takes the subsystem
    // off the id. Three copies of that block is how the fourth Panel
    // arrives with the gnome-terminal flag wrong, so this holds the
    // shared path rather than the network Panel's copy of it.
    for (const [id, name] of [["panel.audio", "audio"], ["panel.power", "power"]] as const) {
      const onWindows = firePlan(id, windows, anything);
      expect(onWindows.ok && onWindows.argv).toEqual([
        "cmd.exe", "/c", "start", "", "red-dev.exe", "panel", name,
      ]);

      const onUbuntu = firePlan(id, desktop, anything);
      expect(onUbuntu.ok && onUbuntu.argv).toEqual([
        "alacritty", "-e", "red-dev", "panel", name,
      ]);

      const headless = firePlan(id, desktop, nothing);
      expect(headless.ok).toBe(false);
      expect(headless.ok === false && headless.detail).toContain(`red-dev panel ${name}`);
    }
  });

  test("and gnome-terminal is told with `--`, because its -e was deprecated years ago", () => {
    // A wrong flag here opens a terminal with a shell in it and no sign
    // that the command was dropped.
    const plan = firePlan("panel.network", desktop, (cmd) =>
      cmd === "gnome-terminal" ? "/usr/bin/gnome-terminal" : null,
    );
    expect(plan.ok && plan.argv).toEqual([
      "gnome-terminal", "--", "red-dev", "panel", "network",
    ]);
  });

  test("a machine with no terminal emulator is told the command to run instead", () => {
    const plan = firePlan("panel.network", desktop, nothing);
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.detail).toContain("red-dev panel network");
  });

  test("an action nothing can run yet is named rather than shrugged at", () => {
    const plan = firePlan("terminal.gone", windows, anything);
    expect(plan.ok === false && plan.detail).toContain("terminal.gone");
  });
});

describe("the four actions the chord decision named", () => {
  test("`red-dev keys` lists ten of them, on every target", () => {
    // Ten is the count the 2026-08-15 decision named, and this holds it
    // on the plain output rather than on the registry: that is the form
    // a bug report pastes, and the form that would shrink first if a
    // target ever started dropping what it cannot bind.
    for (const p of [desktop, server, windows]) {
      expect(keyLines(keyEntries(p))).toHaveLength(10);
    }
  });

  test("the menu and the keys viewer open in a terminal of their own", () => {
    // The same rule the emoji picker and the Panels follow, and the
    // reason all five share one path now: the viewer is already drawing
    // in this terminal, so firing one of them in place would put two
    // full-screen surfaces on the same frame.
    expect(firePlan("menu.open", desktop, anything)).toMatchObject({
      argv: ["alacritty", "-e", "red-dev", "menu"],
    });
    expect(firePlan("keys.viewer", desktop, anything)).toMatchObject({
      argv: ["alacritty", "-e", "red-dev", "keys"],
    });
    expect(firePlan("menu.open", windows, anything)).toMatchObject({
      argv: ["cmd.exe", "/c", "start", "", "red-dev.exe", "menu"],
    });
    expect(firePlan("keys.viewer", windows, anything)).toMatchObject({
      argv: ["cmd.exe", "/c", "start", "", "red-dev.exe", "keys"],
    });
  });

  test("and a machine with no terminal emulator is told the command instead", () => {
    for (const [id, command] of [["menu.open", "red-dev menu"], ["keys.viewer", "red-dev keys"], ["agent.launch", "red-dev agents run"]] as const) {
      const plan = firePlan(id, desktop, nothing);
      expect(plan.ok).toBe(false);
      expect(plan.ok === false && plan.detail).toContain(command);
    }
  });

  test("the Default agent is started through `red-dev agents run`, never a host by name", () => {
    // Which host that resolves to is decided by the recorded choice, in
    // src/agent-launch.ts, and pinned end to end in
    // src/agent-launch.test.ts — including that the argv this builds
    // carries no bypass flag, on any target.
    expect(firePlan("agent.launch", desktop, anything)).toMatchObject({
      argv: ["alacritty", "-e", "red-dev", "agents", "run"],
    });
    expect(firePlan("agent.launch", windows, anything)).toMatchObject({
      argv: ["cmd.exe", "/c", "start", "", "red-dev.exe", "agents", "run"],
    });
  });

  test("the multiplexer reports itself absent, with a reason, where herdr is not installed", () => {
    const plan = firePlan("agent.multiplex", desktop, nothing);
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.detail).toContain("herdr is not installed");
    // And the sentence is about herdr rather than about the terminal
    // emulator this fixture machine is also missing. Nothing is on PATH
    // here, so a check in the other order would answer a question
    // nobody asked and send somebody to install Alacritty.
    expect(plan.ok === false && plan.detail).not.toContain("terminal emulator");
  });

  test("and starts it where it is installed", () => {
    const plan = firePlan("agent.multiplex", desktop, (cmd) =>
      cmd === "herdr" || cmd === "alacritty" ? `/usr/bin/${cmd}` : null,
    );
    expect(plan.ok && plan.argv).toEqual(["alacritty", "-e", "herdr"]);
  });

  test("inside WSL it starts the distro's herdr, in a window belonging to the host", () => {
    // red-dev is inside the distro here, so the herdr it found on PATH
    // is the one wsl.exe will start — and the window it needs is the
    // Windows host's, exactly as terminal.new's fallback opens one.
    const wsl = machine({ env: "wsl" });
    expect(firePlan("agent.multiplex", wsl, anything)).toMatchObject({
      argv: ["cmd.exe", "/c", "start", "", "wsl.exe", "--", "herdr"],
    });
  });

  test("and on a Windows host it is refused by name, without leaving the list", () => {
    const plan = firePlan("agent.multiplex", windows, anything);
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.detail).toContain("no stable Windows build");
    // Still listed there, which is ADR 0006's rule for a target that
    // cannot honour an action: report it, do not delete it.
    const entry = keyEntries(windows).find((e) => e.id === "agent.multiplex");
    expect(entry?.state).toBe("unsupported");
    expect(entry?.reason).toContain("does not apply to windows");
  });
});

describe("the keystrokes the viewer reads", () => {
  const entries = keyEntries(windows);

  test("letters are the search box, so j and k cannot be navigation", () => {
    expect(typed(entries, "jk").query).toBe("jk");
  });

  test("backspace takes one back, and an empty box swallows it", () => {
    const state = viewerStep(entries, typed(entries, "el"), "", press({ backspace: true })).state;
    expect(state.query).toBe("e");
    expect(viewerStep(entries, VIEWER_START, "", press({ backspace: true })).state.query).toBe("");
  });

  test("the arrows move within what is visible and stop at the ends", () => {
    const down = viewerStep(entries, VIEWER_START, "", press({ downArrow: true })).state;
    expect(down.index).toBe(1);
    // Pressed more times than there are rows, so what stops the cursor
    // is the clamp rather than the arithmetic of this test — which is
    // what used to stop it, back when the registry held three actions.
    let further = down;
    for (let i = 0; i <= entries.length; i++) {
      further = viewerStep(entries, further, "", press({ downArrow: true })).state;
    }
    expect(further.index).toBe(entries.length - 1);
    expect(viewerStep(entries, VIEWER_START, "", press({ upArrow: true })).state.index).toBe(0);
  });

  test("editing the query puts the cursor back on the first match", () => {
    const moved = viewerStep(entries, VIEWER_START, "", press({ downArrow: true })).state;
    expect(viewerStep(entries, moved, "t", press()).state.index).toBe(0);
  });

  test("escape clears a search before it closes the viewer", () => {
    const searching = typed(entries, "zzz");
    const cleared = viewerStep(entries, searching, "", press({ escape: true }));
    expect(cleared.quit).toBeUndefined();
    expect(cleared.state.query).toBe("");
    expect(viewerStep(entries, VIEWER_START, "", press({ escape: true })).quit).toBe(true);
  });

  test("ctrl+c leaves, and no other ctrl chord types into the box", () => {
    expect(viewerStep(entries, VIEWER_START, "c", press({ ctrl: true })).quit).toBe(true);
    const state = viewerStep(entries, VIEWER_START, "a", press({ ctrl: true })).state;
    expect(state.query).toBe("");
  });

  test("enter on a search that found nothing fires nothing", () => {
    const empty = typed(entries, "zzz");
    expect(viewerStep(entries, empty, "", press({ return: true })).fire).toBeUndefined();
  });
});
