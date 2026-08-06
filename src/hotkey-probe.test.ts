/**
 * Writing the .lnk is half the job.
 *
 * The file keeps its HotKey property forever; the registration belongs
 * to Explorer, happens at runtime, and is first come first served. An
 * application that starts earlier and claims Ctrl+Alt+T takes it,
 * Explorer's claim fails, and the shortcut goes dead with no error
 * anywhere — converge keeps reporting it written, because it is.
 *
 * This was found the hard way: Ctrl+Alt+T stopped opening the terminal
 * on a machine whose shortcut, target and hotkey property were all
 * correct.
 */

import { describe, expect, test } from "bun:test";
import { hotkeyArgs, hotkeyVerdict, WINDOWS_HOTKEYS } from "./hotkeys.ts";

describe("hotkeyArgs", () => {
  test("encodes the combos this project actually claims", () => {
    // MOD_ALT 1 | MOD_CONTROL 2 = 3, 'T' = 0x54.
    expect(hotkeyArgs("CTRL+ALT+T")).toEqual({ mods: 3, vk: 0x54 });
    // ...plus MOD_SHIFT 4 = 7.
    expect(hotkeyArgs("CTRL+ALT+SHIFT+T")).toEqual({ mods: 7, vk: 0x54 });
  });

  test("every claimed combo can be probed", () => {
    // A combo the encoder cannot express is a key the check silently
    // skips, which is the same blind spot this file exists to close.
    for (const h of WINDOWS_HOTKEYS) {
      if (h.combo) expect(hotkeyArgs(h.combo)).not.toBeNull();
    }
  });

  test("a combo with no modifier is rejected", () => {
    // RegisterHotKey accepts it, and taking a bare letter system-wide
    // would break typing it everywhere else.
    expect(hotkeyArgs("T")).toBeNull();
  });

  test("a combo with no key is rejected", () => {
    expect(hotkeyArgs("CTRL+ALT")).toBeNull();
  });

  test("something it does not understand is rejected, not guessed", () => {
    expect(hotkeyArgs("CTRL+ALT+F13")).toBeNull();
  });
});

describe("hotkeyVerdict", () => {
  test("free is the unambiguous failure", () => {
    // Our shortcut declares the key and nothing holds it, so nothing
    // happens when it is pressed.
    expect(hotkeyVerdict(true, "free")).toBe("drift");
  });

  test("held is reported ok, because Windows never says who holds it", () => {
    // A working shortcut and a stolen one are indistinguishable through
    // this API. Calling held "drift" would cry wolf on every healthy
    // machine; the ambiguity is stated in the detail line instead.
    expect(hotkeyVerdict(true, "held")).toBe("ok");
  });

  test("a probe that could not run is not evidence of a fault", () => {
    expect(hotkeyVerdict(true, "unknown")).toBe("ok");
  });

  test("a missing shortcut is drift whatever the key says", () => {
    // Somebody else holding Ctrl+Alt+T does not mean we installed ours.
    expect(hotkeyVerdict(false, "held")).toBe("drift");
    expect(hotkeyVerdict(false, "free")).toBe("drift");
  });
});
