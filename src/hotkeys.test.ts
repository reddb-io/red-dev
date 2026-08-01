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
import { WINDOWS_HOTKEYS } from "./hotkeys.ts";

const claimed = WINDOWS_HOTKEYS.filter((h) => h.combo !== null).map((h) => h.combo);

describe("the keys taken from the machine", () => {
  test("are exactly the two that were agreed", () => {
    expect(claimed).toEqual(["CTRL+ALT+T", "CTRL+ALT+SHIFT+T"]);
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

describe("the elevated shortcut", () => {
  const elevated = WINDOWS_HOTKEYS.find((h) => h.label.includes("Administrator"));

  test("still exists, because losing the key is not losing the entry", () => {
    expect(elevated).toBeDefined();
  });

  test("has no key at all", () => {
    expect(elevated?.combo).toBeNull();
  });

  test("says why, where someone looking for the key will read it", () => {
    expect(elevated?.note).toContain("Ctrl+Shift+T");
  });
});
