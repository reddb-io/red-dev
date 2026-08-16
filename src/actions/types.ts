/**
 * What a semantic action is, before any platform has seen it.
 *
 * The registry is data first: a list of the things red-dev can do, each
 * one identified by a name that never changes, described in a sentence a
 * person can read, and carrying exactly one chord. Everything that
 * consumes it — the keys viewer, the GNOME adapter, the Start Menu
 * shortcuts on Windows — reads this shape; nothing writes its own copy
 * of "which key opens the terminal" ever again.
 *
 * A chord lives here as text, in the spelling a person would say it:
 * `Ctrl+Alt+T`. Keeping it as text rather than as a parsed record is
 * what lets a malformed chord reach validation and be reported, instead
 * of throwing while a module is still loading — and it is the only form
 * that reads the same in the source, in the viewer and in the README.
 * `parseChord` is the one place that knows how to read it.
 *
 * ADR 0006 is the law this shape exists to make executable: one chord
 * per action, identical on every target, drawn from the `Ctrl+Alt`
 * family, never from `Super`/`Win`.
 */

import type { Env } from "../platform.ts";

export interface SemanticAction {
  /**
   * The stable id: lowercase, dotted, area first — `terminal.new`.
   *
   * It is the name other things store, so it outlives labels, chords and
   * whichever module the action currently lives in. Renaming one is a
   * breaking change, which is why the shape is checked rather than
   * merely suggested.
   */
  id: string;
  /** What a person sees in the keys viewer and in the menu. */
  label: string;
  /**
   * Where the action means anything at all.
   *
   * Not where it happens to be registered today: `terminal.new` applies
   * to every environment that has a display, including WSL, where the
   * key is registered on the Windows host on the WSL install's behalf.
   * An adapter that cannot honour an action reports it unbound (ADR
   * 0006); it does not get to delete it from the list.
   */
  platforms: readonly Env[];
  /** True when running it changes the machine rather than showing it. */
  mutates: boolean;
  /** True when it needs sudo or UAC to do its job. */
  privileged: boolean;
  /** The single chord, in readable spelling: `Ctrl+Alt+Shift+T`. */
  chord: string;
}

/** A chord after `parseChord` has read it. */
export interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** `Super` on GNOME, `Win` on Windows. ADR 0006 forbids claiming one. */
  win: boolean;
  /** The single non-modifier key, canonically spelled: `T`, `LEFT`, `F1`. */
  key: string;
}

/**
 * The names a non-modifier key may carry, and the spellings that mean
 * the same key.
 *
 * Two spellings of one key is how a reserved-list check quietly stops
 * working: `Ctrl+Alt+Del` is not in a list that pins `CTRL+ALT+DELETE`,
 * and nothing says so. Everything is folded to one spelling here, and
 * comparison happens only after folding.
 */
const KEY_ALIASES: Record<string, string> = {
  DEL: "DELETE",
  ESCAPE: "ESC",
  RETURN: "ENTER",
  PGUP: "PAGEUP",
  PGDN: "PAGEDOWN",
  PRINTSCREEN: "PRINT",
  PRTSC: "PRINT",
};

const NAMED_KEYS = new Set([
  "LEFT",
  "RIGHT",
  "UP",
  "DOWN",
  "DELETE",
  "TAB",
  "ESC",
  "ENTER",
  "SPACE",
  "BACKSPACE",
  "HOME",
  "END",
  "PAGEUP",
  "PAGEDOWN",
  "INSERT",
  "PRINT",
]);

function readKey(token: string): string | null {
  const name = KEY_ALIASES[token] ?? token;
  if (/^[A-Z0-9]$/.test(name)) return name;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(name)) return name;
  return NAMED_KEYS.has(name) ? name : null;
}

/**
 * Read a chord, or say it cannot be read.
 *
 * Null rather than a throw, and null rather than a partial chord: the
 * caller is validation, whose job is to name every problem in one pass
 * rather than to stop at the first. "Exactly one chord" is enforced
 * here too — two keys, or none, is not a chord this returns.
 */
export function parseChord(text: string): Chord | null {
  const parts = text.toUpperCase().split("+").map((s) => s.trim());
  if (parts.some((p) => p === "")) return null;

  const chord: Chord = { ctrl: false, alt: false, shift: false, win: false, key: "" };
  for (const part of parts) {
    if (part === "CTRL" || part === "CONTROL") chord.ctrl = true;
    else if (part === "ALT") chord.alt = true;
    else if (part === "SHIFT") chord.shift = true;
    else if (part === "WIN" || part === "SUPER" || part === "META") chord.win = true;
    else {
      const key = readKey(part);
      // A second key is not a second chord to choose between; it is a
      // line nobody can bind. Rejected rather than silently keeping one.
      if (!key || chord.key !== "") return null;
      chord.key = key;
    }
  }
  return chord.key === "" ? null : chord;
}

/**
 * One spelling of a chord, for comparing and for Windows.
 *
 * Uppercase and in modifier order — `CTRL+ALT+SHIFT+T` — which is both
 * how the reserved lists are pinned and, not by coincidence, the exact
 * spelling the Start Menu shortcuts have always been written with.
 */
export function chordText(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("CTRL");
  if (chord.alt) parts.push("ALT");
  if (chord.shift) parts.push("SHIFT");
  if (chord.win) parts.push("WIN");
  parts.push(chord.key);
  return parts.join("+");
}
