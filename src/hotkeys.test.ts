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

  test("compares before saving", () => {
    // The regression this guards is the reason CTRL+ALT+T kept dying.
    // Explorer registers a Start Menu shortcut's hotkey by scanning the
    // folder; rewriting the .lnk makes it drop the registration and
    // re-scan, and the re-registration often does not happen until the
    // next logon. An unconditional Save() therefore had a good chance of
    // unbinding the key on every single converge.
    expect(script).toContain("$same =");
    expect(script).toContain("$s.TargetPath -eq $target");
    expect(script).toContain("$s.HotKey -eq $combo");
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
