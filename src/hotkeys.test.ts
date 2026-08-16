/**
 * Which keys red-dev is allowed to take from the machine.
 *
 * A global hotkey beats the focused application, so claiming one takes
 * it away everywhere. Ctrl+Shift+T was claimed for the elevated
 * PowerShell and should not have been: it is reopen-closed-tab in every
 * browser, in VS Code and in Windows Terminal itself, and installing
 * red-dev quietly removed that from the whole machine.
 *
 * Every combo is anchored on Alt, which nothing else in a terminal
 * workflow wants.
 *
 * The adapter carries every action that applies to Windows. It was
 * migrated with two, and the seven the chord decision added read in
 * `red-dev keys` as chords a person could press to no effect — which is
 * the failure the tests below are written against, in both directions:
 * the claimed set has to be complete, and the one action deliberately
 * left out of it has to stay recognisable as never-claimed rather than
 * as a shortcut that broke.
 */

import { describe, expect, test } from "bun:test";
import { ACTIONS, actionById, chordText, parseChord } from "./actions/index.ts";
import { resolveScript, START_MENU_ACTIONS, WINDOWS_HOTKEYS } from "./hotkeys.ts";

const claimed = WINDOWS_HOTKEYS.filter((h) => h.combo !== null).map((h) => h.combo);

describe("the keys taken from the machine", () => {
  test("are exactly the ones the registry gives this target", () => {
    expect(claimed).toEqual([
      "CTRL+ALT+T",
      "CTRL+ALT+SHIFT+T",
      "CTRL+ALT+SHIFT+M",
      "CTRL+ALT+SHIFT+K",
      "CTRL+ALT+SHIFT+E",
      "CTRL+ALT+SHIFT+N",
      "CTRL+ALT+SHIFT+A",
      "CTRL+ALT+SHIFT+P",
      "CTRL+ALT+SHIFT+G",
    ]);
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
  test("are nine, and no more", () => {
    // Every global binding is taken from the whole machine, so the list
    // growing is a decision rather than a detail. Nine is what the
    // 2026-08-15 chord decision named minus herdr, which has no Windows
    // build to bind a key to.
    expect(WINDOWS_HOTKEYS).toHaveLength(9);
  });

  test("all of them carry a key", () => {
    // The elevated one spent a version as a Start Menu entry with no
    // binding. It has Ctrl+Alt+Shift+T now.
    expect(WINDOWS_HOTKEYS.every((h) => h.combo !== null)).toBe(true);
  });
});

describe("the adapter carries every action that applies to Windows", () => {
  /** What the registry says belongs on this target. */
  const applicable = ACTIONS.filter((a) => a.platforms.includes("windows")).map((a) => a.id);

  test("so nothing applicable is left without a Start Menu entry", () => {
    // The criterion in one line, and derived from the registry rather
    // than from a list repeated here: an action added to `src/actions/`
    // with `windows` among its platforms fails this until somebody
    // decides, out loud, what its shortcut opens.
    expect([...START_MENU_ACTIONS].sort()).toEqual([...applicable].sort());
  });

  test("and the one action deliberately left out is one that does not apply here", () => {
    // The boundary this widening must not blur. herdr has no stable
    // Windows build, so `agent.multiplex` never claimed `windows` — and
    // the adapter writing it a key anyway would put a chord in the Start
    // Menu that opens nothing on a native Windows host.
    expect(START_MENU_ACTIONS).not.toContain("agent.multiplex");
    expect(actionById("agent.multiplex")?.platforms).not.toContain("windows");
  });
});

describe("the keys come from the action registry", () => {
  // The migration this pins: the combos used to be literals in
  // hotkeys.ts and are now read from the registry. Behaviour is
  // unchanged, which is exactly the thing worth pinning — the values
  // above are what shipped, and they have to survive the move.
  test("each Start Menu entry names the action it registers", () => {
    expect(WINDOWS_HOTKEYS.map((h) => h.id)).toEqual([
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

  test("and carries that action's chord, spelled the way Windows is given it", () => {
    expect(actionById("terminal.new")?.chord).toBe("Ctrl+Alt+T");
    expect(actionById("terminal.elevated")?.chord).toBe("Ctrl+Alt+Shift+T");
    const by = (id: string) => WINDOWS_HOTKEYS.find((h) => h.id === id)?.combo;
    expect(by("terminal.new")).toBe("CTRL+ALT+T");
    expect(by("terminal.elevated")).toBe("CTRL+ALT+SHIFT+T");
  });

  test("every entry does, and none of them keeps a second copy of the chord", () => {
    // The generalisation of the test above, now that there are nine:
    // whatever the registry says is what the .lnk gets, folded to the
    // one spelling Windows is given. A hard-coded combo anywhere in this
    // adapter fails here the moment the registry changes underneath it.
    for (const hotkey of WINDOWS_HOTKEYS) {
      const chord = actionById(hotkey.id)?.chord;
      expect(chord).toBeDefined();
      expect(hotkey.combo).toBe(chordText(parseChord(chord as string) as never));
    }
  });

  test("the .lnk names stay Windows' own, because machines already have them", () => {
    // The registry calls the elevated one "Elevated shell"; renaming the
    // shortcut would leave the old .lnk — and its key — behind.
    expect(actionById("terminal.elevated")?.label).toBe("Elevated shell");
    expect(WINDOWS_HOTKEYS.find((h) => h.id === "terminal.elevated")?.label)
      .toBe("PowerShell (Administrator)");
  });

  test("and every name nobody's machine carries yet is the registry's own", () => {
    // The other half of the rule above. A Windows name is worth keeping
    // when Windows already has one; inventing a second name for a .lnk
    // this adapter is the first to write would just be a third spelling
    // of the same act for the keys viewer to disagree with.
    const windowsOwns = new Set(["terminal.new", "terminal.elevated"]);
    for (const hotkey of WINDOWS_HOTKEYS) {
      if (windowsOwns.has(hotkey.id)) continue;
      expect(hotkey.label).toBe(actionById(hotkey.id)?.label as string);
    }
  });

  test("and the written script carries those chords, not its own copy", () => {
    const script = resolveScript(null);
    expect(script).toContain("New-Hot 'Terminal' 'CTRL+ALT+T'");
    expect(script).toContain("New-Hot 'PowerShell (Administrator)' 'CTRL+ALT+SHIFT+T'");
    // The post-write probe asks about the terminal chord: MOD_CONTROL |
    // MOD_ALT is 3, and 0x54 is T.
    expect(script).toContain("RegisterHotKey([IntPtr]::Zero, 9004, 3, 0x54)");
  });
});

describe("the shortcut written for each surface red-dev draws itself", () => {
  const script = resolveScript(null);

  test("names the .lnk, its hotkey and the subcommand it opens", () => {
    // The whole line per shortcut, hotkey field included, because that
    // field is the only part of a .lnk anybody presses: a shortcut
    // written with the right target and the wrong HotKey is a Start Menu
    // entry nobody will ever find, and one written with the right HotKey
    // and the wrong subcommand opens the neighbouring surface.
    for (const [label, combo, argv] of [
      ["red-dev menu", "CTRL+ALT+SHIFT+M", "menu"],
      ["Keys viewer", "CTRL+ALT+SHIFT+K", "keys"],
      ["Emoji picker", "CTRL+ALT+SHIFT+E", "emoji"],
      ["Network panel", "CTRL+ALT+SHIFT+N", "panel network"],
      ["Audio panel", "CTRL+ALT+SHIFT+A", "panel audio"],
      ["Power panel", "CTRL+ALT+SHIFT+P", "panel power"],
      ["Default agent", "CTRL+ALT+SHIFT+G", "agents run"],
    ]) {
      expect(script).toContain(
        `New-Hot '${label}' '${combo}' $surface ($surfaceArgs + '${argv}') $false`,
      );
    }
  });

  test("and none of them is written as the elevated one", () => {
    // Byte 21 is the elevation flag, and the fifth argument is what sets
    // it. Exactly one shortcut asks for consent; a copy-paste that
    // spread `$true` across the surfaces would put a UAC prompt in front
    // of the emoji picker.
    const elevated = script.split("\n").filter((l) => l.includes("New-Hot") && l.includes("$true"));
    expect(elevated).toHaveLength(1);
    expect(elevated[0]).toContain("PowerShell (Administrator)");
  });

  test("through one binary, resolved on the Windows side like everything else", () => {
    // Under WSL this process is Linux: it cannot stat %LOCALAPPDATA%,
    // which is the mistake that once failed the whole step with "APPDATA
    // is not set". PowerShell answers where red-dev lives, honouring the
    // same RED_DEV_BIN_DIR both installers read.
    expect(script).toContain("$env:RED_DEV_BIN_DIR");
    expect(script).toContain("Join-Path $env:LOCALAPPDATA 'red-dev\\bin'");
    expect(script).toContain("Get-Command 'red-dev.exe'");
  });

  test("and is skipped, out loud, when there is no red-dev.exe to name", () => {
    // A .lnk with an empty target is a key that fails silently on a
    // machine somebody was told it works on.
    expect(script).toContain("if ($surface) {");
    expect(script).toContain("(skipped) no red-dev.exe on this host");
  });

  test("reached through the distro when the host has no red-dev of its own", () => {
    // Only from inside WSL, where there is a distro to name. On a native
    // Windows host `wsl.exe -- red-dev` would be a guess at a distro
    // nobody chose, so the fallback is not written at all.
    expect(resolveScript("Ubuntu-24.04")).toContain(
      "$surfaceArgs = '-d Ubuntu-24.04 -- red-dev '",
    );
    expect(script).not.toContain("-- red-dev ");
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
