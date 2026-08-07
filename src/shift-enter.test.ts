/**
 * Shift+Enter, across the four layers it takes to make one keystroke work.
 *
 * The thing that makes this hard is not any one binding. It is that a
 * terminal sends 0x0D for Enter and 0x0D for Shift+Enter — the modifier
 * is discarded at the emulator — so every program downstream sees
 * identical bytes. Claude Code's keybindings.json could say
 * `shift+enter` for a year and never receive one.
 *
 * So the chain has to agree end to end:
 *
 *   1. the emulator sends a distinguishable sequence   alacritty, wsl
 *   2. readline binds that sequence to insert a newline   inputrc.conf
 *   3. the agents decode it natively                   Ink, crossterm
 *
 * ESC[13;2u is the kitty keyboard protocol's Shift+Enter. One sequence
 * is the point: two emulators sending different things would need two
 * bindings in every consumer, and the fourth consumer would be missed.
 *
 * These are string assertions against generated config because the real
 * test needs a keyboard. The readline half WAS verified by hand, with a
 * pty: `echo A`, Shift+Enter, `echo B` produced a two-line buffer that
 * ran both. That cannot run in CI, so what is pinned here is the thing
 * that would silently drift — the sequence itself, in all four places.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/** ESC [ 1 3 ; 2 u — Enter's code point, and 1 + the shift bit. */
const CSI_U = "\u001b[13;2u";
/** xterm's older spelling of the same key, which mintty (Git Bash) sends. */
const MODIFY_OTHER = "\u001b[27;2;13~";

const root = `${import.meta.dir}/..`;
const inputrc = readFileSync(`${root}/config/bash/inputrc.conf`, "utf8");
const alacritty = readFileSync(`${root}/src/alacritty.ts`, "utf8");
const wsl = readFileSync(`${root}/src/wsl.ts`, "utf8");
const claude = readFileSync(`${root}/src/claude-keybindings.ts`, "utf8");

describe("the emulators send something a program can see", () => {
  test("alacritty binds Shift+Enter rather than leaving it as Enter", () => {
    expect(alacritty).toContain("mods = 'Shift'");
    expect(alacritty).toContain("\\\\u001b[13;2u");
  });

  test("windows terminal sends the same sequence, not a different one", () => {
    // Two emulators disagreeing would need two readline bindings and two
    // of everything downstream, and the fourth consumer would be missed.
    expect(wsl).toContain("sendInput");
    expect(wsl).toContain("\\u001b[13;2u");
    expect(wsl).toContain('keys: "shift+enter"');
  });

  test("neither sends a bare newline", () => {
    // 0x0A is Ctrl+J and readline has Ctrl+J as accept-line, so a
    // literal newline would submit in bash — the exact behaviour being
    // avoided. This is the mistake most guides on this recommend.
    expect(alacritty).not.toMatch(/mods = 'Shift'[\s\S]{0,80}chars = "\\\\n"/);
  });
});

describe("readline turns the sequence into a newline", () => {
  test("binds the kitty spelling", () => {
    expect(inputrc).toContain('"\\e[13;2u": "\\C-q\\C-j"');
  });

  test("and the xterm one, because Git Bash is mintty", () => {
    expect(inputrc).toContain('"\\e[27;2;13~": "\\C-q\\C-j"');
  });

  test("through quoted-insert, not by rebinding Ctrl+J", () => {
    // Readline has no "insert a newline" command. \C-q is quoted-insert
    // and \C-j is the character it inserts, so the buffer gets a real
    // 0x0A. Rebinding \C-j itself would take accept-line away from
    // everyone who uses it as a second Enter.
    expect(inputrc).toContain("\\C-q\\C-j");
    expect(inputrc).not.toMatch(/^"\\C-j":/m);
  });
});

describe("the agents", () => {
  test("Claude Code asks for the newline it can now receive", () => {
    // This binding predates the emulator work and did nothing until it:
    // the config was correct and the key never arrived.
    expect(claude).toContain('{ key: "shift+enter", action: "chat:newline" }');
  });
});

describe("one sequence, spelled the same everywhere", () => {
  test("the escape is written as \\u001b, never as a raw control byte", () => {
    // A literal 0x1b in a source file survives an editor, a diff and a
    // review, and then dies in a copy-paste. Both writers spell it.
    for (const [name, src] of [
      ["alacritty.ts", alacritty],
      ["wsl.ts", wsl],
    ] as const) {
      expect(src.includes("\u001b"), `${name} has a raw ESC byte`).toBe(false);
    }
  });

  test("and the sequences are what the protocols actually define", () => {
    // Guards a transposition — 13;2 is Enter+Shift, 2;13 is not.
    expect(CSI_U).toBe("\u001b[13;2u");
    expect(MODIFY_OTHER).toBe("\u001b[27;2;13~");
    expect(inputrc).toContain(CSI_U.replace("\u001b", "\\e"));
    expect(inputrc).toContain(MODIFY_OTHER.replace("\u001b", "\\e"));
  });
});
