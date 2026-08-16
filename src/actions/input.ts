/**
 * The gestures red-dev writes into terminals and agent hosts — the
 * Shift+Enter newline and the Alt+V image paste.
 *
 * These are not semantic actions and ADR 0006 does not reach them. A
 * semantic action is something red-dev *does*, registered with the host
 * and drawn from the `Ctrl+Alt` family; these two are keystrokes that
 * have to survive a terminal emulator and arrive intact at whatever is
 * reading the prompt on the other side. Different law, so a different
 * list — kept in the same directory because "what does red-dev bind"
 * should have one answer, and the keys viewer will read both.
 *
 * The chain is the whole difficulty. A terminal sends 0x0D for Enter and
 * 0x0D for Shift+Enter — the modifier is discarded at the emulator — so
 * every program downstream sees identical bytes and can never tell them
 * apart, no matter what it binds. The emulator has to be told to send
 * something else, and every layer downstream has to expect exactly that
 * something: two emulators sending different sequences would need two
 * bindings in every consumer, and the last consumer would be missed.
 *
 * Which is why this file exists. The sequence lived as a literal in
 * alacritty.ts, in wsl.ts, in inputrc.conf and in zellij's config.kdl,
 * agreeing by luck and by whoever remembered to edit all four. Here it
 * is written once and the modules that generate those configs read it;
 * the two static config files are held to it by the cross-layer test,
 * which is the only enforcement a file red-dev copies verbatim can have.
 *
 * Every sequence is spelled \u001b, never as a raw control byte. A
 * literal 0x1b in a source file survives an editor, a diff and a review,
 * and then dies in a copy-paste.
 */

/** How one layer of the chain spells a gesture it has to bind. */
export interface InputLayers {
  /**
   * Alacritty's keyboard table, which names a key and its modifiers and
   * then sends `chars`. Written to config/alacritty/keys.toml.
   */
  alacritty: { key: string; mods: string };
  /**
   * Windows Terminal's `keys`, paired with a `sendInput` command in
   * settings.json. The other emulator, saying the same thing.
   */
  windowsTerminal: string;
  /**
   * Claude Code's Chat-context binding, when it needs one. Absent where
   * the sequence already arrives as something Claude Code binds itself —
   * Alt+V sends the Ctrl+V byte, which it has always understood.
   */
  claude?: { key: string; action: string };
  /**
   * RedCode's `keybinds` entry: the field, and the value it takes
   * verbatim. Two shapes, because OpenCode's schema uses two — a
   * comma-separated key list for the newline, an object for the paste.
   */
  redcode?: { field: string; value: string | { key: string; preventDefault: boolean } };
}

export interface InputBinding {
  /** The stable id, area first: `input.newline`. */
  id: string;
  /** What a person sees in the keys viewer. */
  label: string;
  /** The gesture as a person says it: `Shift+Enter`. */
  gesture: string;
  /**
   * The bytes an emulator sends in place of the gesture, so that the
   * modifier survives the terminal and reaches the program.
   */
  sequence: string;
  /**
   * Other encodings of the same gesture a consumer must also accept.
   *
   * Not a second choice for an emulator to make — the emulators red-dev
   * configures send `sequence` and nothing else. These are the spellings
   * an emulator red-dev did not configure produces, which the readline
   * half binds alongside the first so the gesture still works there.
   */
  alternates: readonly string[];
  /** How each layer of the chain spells it. */
  layers: InputLayers;
}

/**
 * Shift+Enter, as ESC[13;2u.
 *
 * The kitty keyboard protocol's encoding: 13 is Enter's code point, 2 is
 * 1 plus the shift bit. Alacritty, kitty, foot, WezTerm, Ghostty and
 * iTerm2 all speak it, and so do the frameworks the agents are built on
 * — Ink 6.7+, crossterm, Bubble Tea 2.
 *
 * Deliberately not a literal newline, which is the answer most guides
 * give. 0x0A is Ctrl+J and readline has Ctrl+J as accept-line, so in
 * bash a newline would submit the line — the exact behaviour being
 * avoided.
 *
 * The alternate is xterm's older modifyOtherKeys spelling of the same
 * key, which is what mintty sends, and mintty is Git Bash — one of the
 * five targets.
 */
export const NEWLINE_INPUT = {
  id: "input.newline",
  label: "Newline in a prompt",
  gesture: "Shift+Enter",
  sequence: "\u001b[13;2u",
  alternates: ["\u001b[27;2;13~"],
  layers: {
    alacritty: { key: "Return", mods: "Shift" },
    windowsTerminal: "shift+enter",
    claude: { key: "shift+enter", action: "chat:newline" },
    redcode: { field: "input_newline", value: "shift+return,ctrl+return,alt+return,ctrl+j" },
  },
} as const satisfies InputBinding;

/**
 * Alt+V, as the raw Ctrl+V byte.
 *
 * 0x16 is what Ctrl+V produces, and it is what Claude Code and Codex
 * consume to attach an image from the system clipboard. Ctrl+V itself is
 * therefore left unbound in the emulators — a Paste action there would
 * swallow the key before either agent saw it — and Ctrl+Shift+V stays
 * the terminal text-paste convention. Alt+V is the alias that makes the
 * gesture reachable without giving up either of those, and it matches
 * Claude Code's documented Windows image shortcut.
 *
 * Claude Code needs no entry: it receives 0x16 and already knows it.
 * RedCode is told the same thing in its own words, `ctrl+v`, because
 * that is the key the byte arrives as.
 */
export const IMAGE_PASTE_INPUT = {
  id: "input.paste",
  label: "Paste an image into a prompt",
  gesture: "Alt+V",
  sequence: "\u0016",
  alternates: [],
  layers: {
    alacritty: { key: "V", mods: "Alt" },
    windowsTerminal: "alt+v",
    redcode: { field: "input_paste", value: { key: "ctrl+v", preventDefault: false } },
  },
} as const satisfies InputBinding;

/**
 * The list, in the order a generated file writes them.
 *
 * Order carries more weight here than it does for the semantic actions:
 * RedCode's tui.json is written by iterating this, so reordering the
 * list would rewrite a file on every machine for no reason.
 */
export const INPUT_BINDINGS: readonly InputBinding[] = [NEWLINE_INPUT, IMAGE_PASTE_INPUT];

/** By id, for the same reason `actionById` exists: ids are what get stored. */
export function inputBindingById(id: string): InputBinding | undefined {
  return INPUT_BINDINGS.find((b) => b.id === id);
}

/**
 * A sequence written so a config file that cannot hold a control byte
 * can still carry it: the escape becomes the four printable characters
 * Alacritty's TOML parser turns back into a 0x1b.
 *
 * Windows Terminal needs no equivalent — JSON.stringify emits the real
 * byte — which is exactly the sort of per-layer difference that makes an
 * escaped copy per module a thing that drifts.
 */
export function escapedSequence(sequence: string): string {
  return [...sequence]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code >= 0x20 && code !== 0x7f) return char;
      return `\\u${code.toString(16).padStart(4, "0")}`;
    })
    .join("");
}
