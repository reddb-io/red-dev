/**
 * The rules ADR 0006 wrote down, run against the registry and against
 * actions that break each rule on purpose.
 *
 * A validator is only worth having if it fails, so every rule is checked
 * twice here: once against the real list, which must be clean, and once
 * against a fixture action built to violate exactly that rule. The
 * reserved-key rule is the one that motivated the whole check — a chord
 * that collides with GNOME or Windows is invisible until it is on
 * somebody's machine, and by then it is in a release.
 */

import { describe, expect, test } from "bun:test";
import { ACTIONS, actionById } from "./index.ts";
import { GNOME_RESERVED, WINDOWS_RESERVED } from "./reserved.ts";
import { chordText, parseChord } from "./types.ts";
import type { SemanticAction } from "./types.ts";
import { validateActions } from "./validate.ts";

/** An action that is fine in every way except the one under test. */
function fixture(overrides: Partial<SemanticAction>): SemanticAction {
  return {
    id: "fixture.one",
    label: "A fixture",
    platforms: ["desktop"],
    mutates: false,
    privileged: false,
    chord: "Ctrl+Alt+J",
    ...overrides,
  };
}

/** The problems reported for one fixture, as sentences. */
function problems(...actions: SemanticAction[]): string[] {
  return validateActions(actions).map((p) => p.problem);
}

describe("the registry itself", () => {
  test("passes its own validation", () => {
    expect(validateActions(ACTIONS)).toEqual([]);
  });

  test("carries the actions the areas have so far", () => {
    // Empty areas are aggregated too, so this is the whole list and not
    // just the module that happens to be filled.
    expect(ACTIONS.map((a) => a.id)).toEqual(["terminal.new", "terminal.elevated"]);
  });

  test("gives every action exactly one chord, in the Ctrl+Alt family", () => {
    for (const action of ACTIONS) {
      const chord = parseChord(action.chord);
      expect(chord).not.toBeNull();
      expect(chord?.ctrl).toBe(true);
      expect(chord?.alt).toBe(true);
      expect(chord?.win).toBe(false);
    }
  });

  test("has unique ids", () => {
    expect(new Set(ACTIONS.map((a) => a.id)).size).toBe(ACTIONS.length);
  });

  test("has unique chords", () => {
    const chords = ACTIONS.map((a) => chordText(parseChord(a.chord) as never));
    expect(new Set(chords).size).toBe(chords.length);
  });

  test("finds an action by its id, and says nothing when there is none", () => {
    expect(actionById("terminal.new")?.label).toBe("Terminal");
    expect(actionById("terminal.gone")).toBeUndefined();
  });
});

describe("a chord that collides with the host", () => {
  test("from GNOME's reserved list fails validation", () => {
    // Ctrl+Alt+Left is a workspace switch on every GNOME session; an
    // action claiming it would fight the desktop for the key.
    expect(problems(fixture({ chord: "Ctrl+Alt+Left" }))).toEqual([
      "chord CTRL+ALT+LEFT is reserved by GNOME",
      "chord CTRL+ALT+LEFT is reserved by Windows",
    ]);
  });

  test("from GNOME alone fails too", () => {
    expect(problems(fixture({ chord: "Ctrl+Alt+L" }))).toEqual([
      "chord CTRL+ALT+L is reserved by GNOME",
    ]);
  });

  test("from Windows' reserved list fails validation", () => {
    expect(problems(fixture({ chord: "Ctrl+Alt+Tab" }))).toEqual([
      "chord CTRL+ALT+TAB is reserved by GNOME",
      "chord CTRL+ALT+TAB is reserved by Windows",
    ]);
  });

  test("is caught whichever way it is spelled", () => {
    // Del and Delete are the same key; a check that only knew one
    // spelling would pass the other straight through.
    expect(problems(fixture({ chord: "ctrl+alt+del" }))).toEqual([
      "chord CTRL+ALT+DELETE is reserved by GNOME",
      "chord CTRL+ALT+DELETE is reserved by Windows",
    ]);
  });

  test("but the family red-dev lives in is not itself reserved", () => {
    // GNOME ships Ctrl+Alt+T as launch-terminal, which is the same act
    // terminal.new performs. Adopting it is not colliding with it, and
    // pinning it as reserved would fail the registry on its own chord.
    expect(GNOME_RESERVED.has("CTRL+ALT+T")).toBe(false);
    expect(WINDOWS_RESERVED.has("CTRL+ALT+T")).toBe(false);
    expect(WINDOWS_RESERVED.has("CTRL+ALT+SHIFT+T")).toBe(false);
  });

  test("and every pinned entry is spelled the way a parsed chord is", () => {
    // A reserved entry nothing can ever match is a check that silently
    // does nothing.
    for (const entry of [...GNOME_RESERVED, ...WINDOWS_RESERVED]) {
      const chord = parseChord(entry);
      expect(chord).not.toBeNull();
      expect(chordText(chord as never)).toBe(entry);
    }
  });
});

describe("the rest of the rules", () => {
  test("a chord outside the Ctrl+Alt family fails", () => {
    expect(problems(fixture({ chord: "Ctrl+Shift+T" }))).toEqual([
      "chord CTRL+SHIFT+T is outside the Ctrl+Alt family",
    ]);
  });

  test("a Super chord fails, and is named as the host's", () => {
    expect(problems(fixture({ chord: "Super+Space" }))).toEqual([
      "chord WIN+SPACE claims Super/Win, which ADR 0006 leaves to the host",
    ]);
  });

  test("two chords on one action is not two chords, it is no chord", () => {
    expect(problems(fixture({ chord: "Ctrl+Alt+J+K" }))).toEqual([
      'chord "Ctrl+Alt+J+K" is not one readable chord',
    ]);
  });

  test("an action with no chord fails", () => {
    expect(problems(fixture({ chord: "" }))).toEqual([
      'chord "" is not one readable chord',
    ]);
  });

  test("modifiers alone are not a chord", () => {
    expect(problems(fixture({ chord: "Ctrl+Alt" }))).toEqual([
      'chord "Ctrl+Alt" is not one readable chord',
    ]);
  });

  test("a repeated id fails, and both actions are named", () => {
    const twice = problems(
      fixture({ id: "fixture.one", chord: "Ctrl+Alt+J" }),
      fixture({ id: "fixture.one", chord: "Ctrl+Alt+K" }),
    );
    expect(twice).toEqual(['id "fixture.one" is used twice']);
  });

  test("an id that is not a lowercase dotted name fails", () => {
    expect(problems(fixture({ id: "Fixture" }))).toEqual([
      'id "Fixture" is not a lowercase dotted name',
    ]);
  });

  test("two actions reaching for the same chord fails", () => {
    expect(
      problems(fixture({ id: "fixture.one" }), fixture({ id: "fixture.two" })),
    ).toEqual(["chord CTRL+ALT+J already belongs to fixture.one"]);
  });

  test("an action that applies nowhere fails", () => {
    expect(problems(fixture({ platforms: [] }))).toEqual(["applies to no platform"]);
  });

  test("an action with no label fails", () => {
    expect(problems(fixture({ label: "  " }))).toEqual(["has no label"]);
  });

  test("every problem names the action it belongs to", () => {
    const found = validateActions([fixture({ id: "fixture.two", chord: "Ctrl+Alt+Delete" })]);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((p) => p.id === "fixture.two")).toBe(true);
  });
});
