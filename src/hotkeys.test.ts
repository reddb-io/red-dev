/**
 * Which keys red-dev is allowed to take from the machine.
 *
 * A global hotkey beats the focused application, so claiming one takes
 * it away everywhere. Ctrl+Shift+T was claimed for the elevated
 * PowerShell and should not have been: it is reopen-closed-tab in every
 * browser, in VS Code and in Windows Terminal itself, and installing
 * red-dev quietly removed that from the whole machine.
 *
 * Two combos, both anchored on Alt, which nothing else in a terminal
 * workflow wants.
 */

import { describe, expect, test } from "bun:test";
import { resolveScript, WINDOWS_HOTKEYS } from "./hotkeys.ts";

const claimed = WINDOWS_HOTKEYS.filter((h) => h.combo !== null).map((h) => h.combo);

describe("the keys taken from the machine", () => {
  test("are exactly the two that were agreed", () => {
    expect(claimed).toEqual(["CTRL+ALT+T", "CTRL+ALT+SHIFT+T"]);
  });

  test("Ctrl+Alt+T is the terminal and Ctrl+Alt+Shift+T is the elevated one", () => {
    // Named rather than implied by order: these two were swapped around
    // twice while the set was being decided, and a silent swap would
    // hand someone an administrator prompt where they wanted a shell.
    const by = (c: string) => WINDOWS_HOTKEYS.find((h) => h.combo === c);
    expect(by("CTRL+ALT+T")?.label).toBe("Terminal");
    expect(by("CTRL+ALT+SHIFT+T")?.label).toContain("Administrator");
  });

  test("never include Ctrl+Shift+T", () => {
    // Named rather than implied by the list above: this is the one that
    // shipped and had to be taken back, and a future addition that
    // reaches for it should fail here rather than on someone's machine.
    expect(claimed).not.toContain("CTRL+SHIFT+T");
  });

  test("all require Alt, which nothing else here competes for", () => {
    expect(claimed.every((c) => c?.includes("ALT"))).toBe(true);
  });

  test("are distinct", () => {
    expect(new Set(claimed).size).toBe(claimed.length);
  });
});

describe("the shortcuts written", () => {
  test("are two, and no more", () => {
    // Every global binding is taken from the whole machine, so the list
    // growing is a decision rather than a detail.
    expect(WINDOWS_HOTKEYS).toHaveLength(2);
  });

  test("all of them carry a key", () => {
    // The elevated one spent a version as a Start Menu entry with no
    // binding. It has Ctrl+Alt+Shift+T now.
    expect(WINDOWS_HOTKEYS.every((h) => h.combo !== null)).toBe(true);
  });
});

describe("the shortcut is only rewritten when it is wrong", () => {
  const script = resolveScript("Ubuntu-24.04");

  test("compares before saving, through a spelling both sides can reach", () => {
    // Two regressions deep. The first: an unconditional Save() unbinds
    // the key on every converge, because Explorer drops the registration
    // when the .lnk is rewritten. The second: the comparison added to
    // fix that compared what we assign (CTRL+ALT+T) against what Windows
    // reads back (Alt+Ctrl+T — re-spelled, reordered), so it was false
    // every time and the Save() it guarded ran anyway. The fix shipped
    // and the key went on dying, which is worse than no fix: it ended
    // the search. Normal() collapses order and case on both sides.
    expect(script).toContain("function Normal($combo)");
    // The escape that broke it in production: the TS template ate the
    // backslash and PowerShell received -split '+', an invalid regex —
    // "Quantifier {x,y} following nothing" — which failed the whole
    // hotkeys step. Assert on the EMITTED script, where PowerShell
    // reads, not on the source.
    expect(script).toContain("-split '\\+'");
    expect(script).not.toContain("-split '+'");
    expect(script).toContain("(Normal $s.HotKey) -eq (Normal $combo)");
    expect(script).not.toContain("$s.HotKey -eq $combo)");
  });

  test("a write that risks the registration is followed by a probe", () => {
    // And a free key after a write means Explorer lost it — restarting
    // Explorer makes it re-scan the Start Menu now rather than at next
    // logon. Only after a real write: the steady state never touches it.
    expect(script).toContain("if ($script:wrote)");
    expect(script).toContain("RegisterHotKey");
    expect(script).toContain("Stop-Process -Name explorer");
  });

  test("and returns before Save() when nothing differs", () => {
    const guard = script.indexOf("if ($same -and (Test-Path $p))");
    const save = script.indexOf("$s.Save()");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(save);
    expect(script.slice(guard, save)).toContain("return");
  });

  test("but still repairs a shortcut that carries the wrong binding", () => {
    // The unconditional write existed for a reason — a machine with an
    // old binding needs the property rewritten to clear it — and losing
    // that would trade one silent breakage for another.
    expect(script).toContain("$s.HotKey = $combo");
    expect(script).toContain("$s.Save()");
  });
});
