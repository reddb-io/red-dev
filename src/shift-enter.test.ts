/**
 * Shift+Enter, across the layers it takes to make one keystroke work.
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
 *   2. the multiplexer passes it through              zellij
 *   3. readline binds it to insert a newline           inputrc.conf
 *   4. the agents decode it                            claude, redcode
 *
 * ESC[13;2u is the kitty keyboard protocol's Shift+Enter. One sequence
 * is the point: two emulators sending different things would need two
 * bindings in every consumer, and the fourth consumer would be missed.
 *
 * What changed when the registry arrived is what this file is allowed to
 * assert. It used to check that six places contained the same string,
 * which is a test that six modules agree — passing right up until a
 * seventh was added, and saying nothing about which of the six was
 * right. Now every layer is checked against src/actions/input.ts, and
 * the modules are checked for having stopped spelling it themselves. One
 * of those is a contract; the other was a coincidence with a test around
 * it.
 *
 * These are still assertions against generated config because the real
 * test needs a keyboard. The readline half WAS verified by hand, with a
 * pty: `echo A`, Shift+Enter, `echo B` produced a two-line buffer that
 * ran both. That cannot run in CI, so what is pinned here is the thing
 * that would silently drift — the sequence itself, in every place that
 * has to know it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { escapedSequence, IMAGE_PASTE_INPUT, NEWLINE_INPUT } from "./actions/index.ts";
import { keysToml } from "./alacritty.ts";
import { convergeClaudeKeybinding } from "./claude-keybindings.ts";
import { convergeOpenCodeInput } from "./terminal-surfaces.ts";
import { mergeWindowsTerminalAgentActions } from "./wsl.ts";

/** ESC [ 1 3 ; 2 u — Enter's code point, and 1 + the shift bit. */
const CSI_U = NEWLINE_INPUT.sequence;
/** xterm's older spelling of the same key, which mintty (Git Bash) sends. */
const MODIFY_OTHER = NEWLINE_INPUT.alternates[0] ?? "";
/** The escape itself, taken from the registry rather than typed again. */
const ESC = CSI_U.slice(0, 1);

const root = `${import.meta.dir}/..`;
const inputrc = readFileSync(`${root}/config/bash/inputrc.conf`, "utf8");
const zellij = readFileSync(`${root}/config/zellij/config.kdl`, "utf8");

/**
 * The modules that used to hold a copy of the sequence.
 *
 * Read as text on purpose: the point of the last describe is that these
 * files no longer contain the literal at all, which is a fact about the
 * source and cannot be asked of the values they export.
 */
const MODULES = [
  ["alacritty.ts", readFileSync(`${root}/src/alacritty.ts`, "utf8")],
  ["wsl.ts", readFileSync(`${root}/src/wsl.ts`, "utf8")],
  ["claude-keybindings.ts", readFileSync(`${root}/src/claude-keybindings.ts`, "utf8")],
  ["terminal-surfaces.ts", readFileSync(`${root}/src/terminal-surfaces.ts`, "utf8")],
] as const;

/** A sequence as readline writes an escape: `\e`. */
function readlineSpelling(sequence: string): string {
  return sequence.split(ESC).join("\\e");
}

/** A sequence as zellij's `Write` takes it — one decimal per byte. */
function decimalBytes(sequence: string): string {
  return [...sequence].map((c) => c.codePointAt(0)).join(" ");
}

const scratchRoots: string[] = [];

function scratch(name: string): string {
  const dir = mkdtempSync(`${tmpdir()}/red-dev-shift-enter-`);
  scratchRoots.push(dir);
  return `${dir}/${name}`;
}

afterAll(() => {
  for (const dir of scratchRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the emulators send what the registry says", () => {
  test("alacritty binds Shift+Enter rather than leaving it as Enter", () => {
    const keys = keysToml();
    const { key, mods } = NEWLINE_INPUT.layers.alacritty;
    expect(keys).toContain(`key = '${key}'\nmods = '${mods}'\nchars = "${escapedSequence(CSI_U)}"`);
  });

  test("and sends the image gesture as the registry's byte too", () => {
    const keys = keysToml();
    const { key, mods } = IMAGE_PASTE_INPUT.layers.alacritty;
    const chars = escapedSequence(IMAGE_PASTE_INPUT.sequence);
    expect(keys).toContain(`key = '${key}'\nmods = '${mods}'\nchars = "${chars}"`);
  });

  test("windows terminal sends the same sequence, not a different one", () => {
    // Two emulators disagreeing would need two readline bindings and two
    // of everything downstream, and the fourth consumer would be missed.
    // They agree because there is one place to disagree with.
    const { actions } = mergeWindowsTerminalAgentActions([]);
    expect(actions).toContainEqual({
      command: { action: "sendInput", input: CSI_U },
      keys: NEWLINE_INPUT.layers.windowsTerminal,
    });
    expect(actions).toContainEqual({
      command: { action: "sendInput", input: IMAGE_PASTE_INPUT.sequence },
      keys: IMAGE_PASTE_INPUT.layers.windowsTerminal,
    });
  });

  test("neither sends a bare newline", () => {
    // 0x0A is Ctrl+J and readline has Ctrl+J as accept-line, so a
    // literal newline would submit in bash — the exact behaviour being
    // avoided. This is the mistake most guides on this recommend.
    expect(CSI_U).not.toContain("\n");
    expect(keysToml()).not.toMatch(/mods = 'Shift'\nchars = "\\n"/);
  });
});

describe("zellij hands it to the pane unchanged", () => {
  test("writes the registry's bytes, one decimal each", () => {
    // zellij parses the key and then downgrades it to a plain Enter for
    // any pane app that never enabled the kitty protocol — Claude Code
    // among them. A user keybind wins before that downgrade, so these
    // bytes are the same sequence in the one spelling zellij accepts.
    expect(zellij).toContain(`bind "Shift Enter" { Write ${decimalBytes(CSI_U)}; }`);
  });
});

describe("readline turns the sequence into a newline", () => {
  test("binds the kitty spelling", () => {
    expect(inputrc).toContain(`"${readlineSpelling(CSI_U)}": "\\C-q\\C-j"`);
  });

  test("and the xterm one, because Git Bash is mintty", () => {
    expect(inputrc).toContain(`"${readlineSpelling(MODIFY_OTHER)}": "\\C-q\\C-j"`);
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
  test("Claude Code asks for the newline it can now receive", async () => {
    // This binding predates the emulator work and did nothing until it:
    // the config was correct and the key never arrived. Both halves are
    // one registry entry now, so neither can move without the other.
    const path = scratch("keybindings.json");
    await convergeClaudeKeybinding(path);
    const file = JSON.parse(readFileSync(path, "utf8")) as {
      bindings: { context: string; bindings: Record<string, string | null> }[];
    };
    const chat = file.bindings.find((b) => b.context === "Chat")?.bindings ?? {};
    const wanted = NEWLINE_INPUT.layers.claude;
    expect(chat[wanted.key]).toBe(wanted.action);
  });

  test("RedCode is told the same thing in its own words", async () => {
    const path = scratch("tui.json");
    await convergeOpenCodeInput(path);
    const cfg = JSON.parse(readFileSync(path, "utf8")) as { keybinds: Record<string, unknown> };
    const newline = NEWLINE_INPUT.layers.redcode;
    const paste = IMAGE_PASTE_INPUT.layers.redcode;
    expect(cfg.keybinds[newline?.field ?? ""]).toEqual(newline?.value);
    expect(cfg.keybinds[paste?.field ?? ""]).toEqual(paste?.value);
  });
});

describe("one sequence, and only one place that spells it", () => {
  test("no module holds a copy of the sequence any more", () => {
    // The assertion the old version of this file could not make. Six
    // modules agreeing is a coincidence a seventh breaks; one module
    // holding it and six reading it is a contract.
    const literals = [
      escapedSequence(CSI_U),
      escapedSequence(MODIFY_OTHER),
      escapedSequence(IMAGE_PASTE_INPUT.sequence),
    ];
    for (const [name, src] of MODULES) {
      for (const literal of literals) {
        expect(src.includes(literal), `${name} spells ${literal} itself`).toBe(false);
      }
    }
  });

  test("nor a copy of the key each layer binds", () => {
    // A module that kept the key while reading the sequence would still
    // drift — the emulator would send the right bytes for a gesture
    // nothing downstream was listening for.
    const keys = [
      NEWLINE_INPUT.layers.windowsTerminal,
      NEWLINE_INPUT.layers.claude.key,
      IMAGE_PASTE_INPUT.layers.windowsTerminal,
    ];
    for (const [name, src] of MODULES) {
      for (const key of keys) {
        expect(src.includes(`"${key}"`), `${name} spells "${key}" itself`).toBe(false);
      }
    }
  });

  test("the escape is written as an escape, never as a raw control byte", () => {
    // A literal 0x1b in a source file survives an editor, a diff and a
    // review, and then dies in a copy-paste. Including the registry:
    // being the one place that holds it is not a licence to hold it raw.
    const sources = [...MODULES, ["actions/input.ts", readFileSync(`${root}/src/actions/input.ts`, "utf8")]] as const;
    for (const [name, src] of sources) {
      expect(src.includes(ESC), `${name} has a raw ESC byte`).toBe(false);
    }
  });

  test("and the sequences are what the protocols actually define", () => {
    // Guards a transposition — 13;2 is Enter+Shift, 2;13 is not — and
    // does it in decimal so that no spelling of the escape is involved.
    expect(decimalBytes(CSI_U)).toBe("27 91 49 51 59 50 117");
    expect(decimalBytes(MODIFY_OTHER)).toBe("27 91 50 55 59 50 59 49 51 126");
    // 0x16 is the byte Ctrl+V produces, which is what the agents read as
    // "attach the image on the clipboard".
    expect(decimalBytes(IMAGE_PASTE_INPUT.sequence)).toBe("22");
  });
});
