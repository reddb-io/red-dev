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
 * both terminal actions, a Linux desktop binds neither because no GNOME
 * adapter exists yet, and a server has no display to press a key on —
 * and none of those is answerable by asking the machine underneath.
 */

import { describe, expect, test } from "bun:test";
import { ACTIONS } from "./actions/index.ts";
import type { SemanticAction } from "./actions/index.ts";
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

  test("on Windows, the two terminal actions are bound and carry no reason", () => {
    for (const entry of keyEntries(windows)) {
      expect(entry.state).toBe("bound");
      expect(entry.reason).toBe("");
    }
  });
});

describe("an action this target does not bind", () => {
  test("is listed, not hidden, and the reason says the target has no adapter", () => {
    // Ubuntu desktop today: terminal.new applies here — GNOME ships the
    // same chord for the same act — and nothing red-dev owns registers
    // it, because the GNOME adapter is not written. Reporting that is
    // the ADR's rule; dropping the row would make the viewer agree with
    // a machine that is missing a feature.
    const entry = keyEntries(desktop).find((e) => e.id === "terminal.new");
    expect(entry?.state).toBe("unsupported");
    expect(entry?.reason).toContain("no bindings adapter for desktop");
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

  test("an action the adapter should register and does not is broken too", () => {
    // Applies to Windows, the Windows adapter exists, and it carries no
    // entry for it: a gap, not a platform limit.
    const [entry] = keyEntries(windows, only({}));
    expect(entry?.state).toBe("broken");
    expect(entry?.reason).toContain("Windows Start Menu");
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
    expect(searchKeys(entries, "unsupported")).toEqual([]);
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
    // Ubuntu desktop binds no chord today. Someone who opened the viewer
    // to reach the terminal gets the terminal, rather than a row telling
    // them the chord they came here to find does not work.
    const [terminal] = keyEntries(desktop);
    expect(terminal?.state).toBe("unsupported");
    const started: string[][] = [];
    const outcome = await fireEntry(terminal!, desktop, (argv) => started.push(argv), anything);
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

  test("an action nothing can run yet is named rather than shrugged at", () => {
    const plan = firePlan("terminal.gone", windows, anything);
    expect(plan.ok === false && plan.detail).toContain("terminal.gone");
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
    const further = viewerStep(entries, down, "", press({ downArrow: true })).state;
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
