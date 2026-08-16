/**
 * `red-dev emoji` — the bundled table, as something a person can search
 * and press Enter on.
 *
 * There is no emoji picker on three of the five targets this project
 * supports. GNOME has one behind Ctrl+. in GTK applications and nowhere
 * else; Windows has Win+. , which ADR 0006 leaves to the host and which
 * does not exist inside WSL at all; a headless server has neither. So
 * the picker is red-dev's, drawn in a terminal, and it is the same
 * picker in all five places — which is the only reason it is worth
 * shipping a table rather than pointing at the host's.
 *
 * ## Deciding, then doing
 *
 * The same split `firePlan` and `PanelPlan` make, and for the same
 * reason. `copyPlan` says which program would be run and with what on
 * its stdin; `copyEmoji` runs it. A refusal — a server with no clipboard
 * — arrives as a sentence for the status line rather than as a process
 * that failed somewhere off screen, and the choice of route is readable
 * by a test on all five targets from whichever one the test runs on.
 *
 * ## And the route is not this module's invention
 *
 * `clipboardArgvFor` is the terminal layer's own, the one zellij's
 * `copy_command` is built from. That is deliberate to the point of being
 * the design: the WSL route in particular took three attempts to get
 * right — `clip.exe` alone mangled UTF-8 through the OEM code page, then
 * a PowerShell bridge decoded correctly and exceeded zellij's one-second
 * deadline, and only `iconv` to BOM-less UTF-16LE is both. A picker whose
 * whole job is putting a supplementary-plane character on the Windows
 * clipboard is exactly the surface that would have reinvented that bug,
 * so it does not get to choose.
 */

import { clipboardArgvFor } from "./dotfiles.ts";
import { EMOJI, type Emoji } from "./emoji-table.ts";
import type { Platform } from "./platform.ts";

export type { Emoji } from "./emoji-table.ts";
export { EMOJI, EMOJI_GROUPS } from "./emoji-table.ts";

/**
 * Which of the three bridges this machine copies through.
 *
 * Named rather than inferred from the argv, because the name is what a
 * person reads in the status line and what a test asserts on. "wl-copy
 * succeeded" is a sentence; `["wl-copy"]` is an implementation detail
 * that happens to be one word long today.
 */
export type ClipboardTarget = "wayland" | "wsl" | "windows";

export interface ClipboardRoute {
  target: ClipboardTarget;
  /**
   * The program and its arguments, taking the text on stdin.
   *
   * `argv.join(" ")` is the `copy_command` zellij is given on the same
   * machine — not a similar one, the same one.
   */
  argv: readonly string[];
  /** One line naming the bridge, for the status line. */
  note: string;
}

/**
 * How each route is described once it has worked.
 *
 * The WSL line names the encoding on purpose. Someone who copies an
 * emoji under WSL and pastes a `?` into Teams needs to know which of the
 * two sides to look at, and "through iconv to UTF-16LE" points at the
 * one that has been wrong before.
 */
const NOTES: Record<ClipboardTarget, string> = {
  wayland: "wl-copy",
  wsl: "the Windows clipboard, through iconv to BOM-less UTF-16LE",
  windows: "the Windows clipboard, through PowerShell",
};

/**
 * The route for this machine, or nothing where there is no clipboard.
 *
 * The target is read off the platform rather than off the argv so that
 * the two cannot disagree: `clipboardArgvFor` decides *what runs*, this
 * decides *what it is called*, and both answer the same question in the
 * same order.
 */
export function clipboardRoute(p: Platform): ClipboardRoute | null {
  const argv = clipboardArgvFor(p);
  if (!argv) return null;
  const target: ClipboardTarget =
    p.env === "wsl" ? "wsl" : p.os === "windows" ? "windows" : "wayland";
  return { target, argv, note: NOTES[target] };
}

export type CopyPlan =
  | { ok: true; char: string; argv: readonly string[]; note: string }
  | { ok: false; char: string; detail: string };

/**
 * What copying this emoji would run, decided before anything runs.
 *
 * The refusal carries the character itself. A person on a server asked
 * for an emoji and the honest answer is "this machine has no clipboard,
 * and here it is anyway" — which they can select with the mouse. An
 * empty "unavailable" would be the picker refusing to do the one part it
 * can still do.
 */
export function copyPlan(p: Platform, emoji: Emoji): CopyPlan {
  const route = clipboardRoute(p);
  if (!route) {
    return {
      ok: false,
      char: emoji.char,
      detail: `no clipboard on ${p.env} — ${emoji.char} is ${emoji.name}, copy it by hand`,
    };
  }
  return { ok: true, char: emoji.char, argv: route.argv, note: `${emoji.char} → ${route.note}` };
}

/** Copied, or the reason it was not — either way, one line. */
export interface CopyOutcome {
  copied: boolean;
  detail: string;
}

/**
 * The seam a test replaces: hand this text to that program's stdin, and
 * say how it ended.
 */
export type ClipboardWrite = (argv: readonly string[], text: string) => Promise<number>;

/**
 * The real one, bounded.
 *
 * Through `runBounded` rather than a bare spawn because every route ends
 * in a program that can hang: `clip.exe` when WSL interop is wedged,
 * PowerShell while it starts, `wl-copy` when it is holding a selection
 * for a compositor that has gone away. A picker that stopped responding
 * to the keyboard because a copy never returned would be a worse failure
 * than the copy failing.
 *
 * Three seconds rather than zellij's one: zellij's deadline is zellij's,
 * imposed on a command it kills mid-selection, and a person who pressed
 * Enter can afford to wait a moment longer than a mouse drag can.
 */
export async function writeClipboard(argv: readonly string[], text: string): Promise<number> {
  const { runBounded } = await import("./bounded-command.ts");
  const result = await runBounded([...argv], { stdin: text, timeoutMs: 3_000 });
  // A timeout has no exit code and must not read as success. `?? 1` would
  // be a lie in the other direction only if the program had exited well,
  // which is precisely the case that carries a code.
  return result.timedOut ? 1 : (result.exitCode ?? 1);
}

/**
 * Put the chosen emoji on this machine's clipboard.
 *
 * `write` is injected for the reason `fireEntry` injects its spawn: the
 * clipboard is not answerable in a test, and the thing worth pinning is
 * that choosing a row hands *that* character to *this target's* bridge.
 */
export async function copyEmoji(
  p: Platform,
  emoji: Emoji,
  write: ClipboardWrite = writeClipboard,
): Promise<CopyOutcome> {
  const plan = copyPlan(p, emoji);
  if (!plan.ok) return { copied: false, detail: plan.detail };
  try {
    const code = await write(plan.argv, plan.char);
    if (code !== 0) {
      return { copied: false, detail: `${plan.argv[0]} exited ${code} — nothing was copied` };
    }
  } catch (err) {
    return { copied: false, detail: `${emoji.name}: ${(err as Error).message}` };
  }
  return { copied: true, detail: `copied ${plan.note}` };
}

// ----------------------------------------------------------- searching

/**
 * How well one row answers a query, lower being better.
 *
 * A plain filter is not enough here and the difference is visible on the
 * first keystroke. Typing `fire` into a filtered list of 300 rows puts
 * 🔥 somewhere among "firefox", "fireworks" and every row whose group or
 * keywords mention it, in table order — so the emoji the word *is* sits
 * below three that merely mention it, and the person keeps typing a word
 * that was already right.
 *
 * Four ranks, and the boundaries are the ones a person would draw: the
 * name *is* the query, the name *starts with* it, a keyword *is* it,
 * anything else that matches at all.
 */
function rank(emoji: Emoji, query: string): number {
  if (emoji.name === query) return 0;
  if (emoji.name.startsWith(query)) return 1;
  if (emoji.keywords.includes(query)) return 2;
  return 3;
}

/**
 * The table, narrowed by what has been typed and then ordered.
 *
 * Every word has to match somewhere, in any order and anywhere in the
 * row — the same rule `searchKeys` uses, so the two surfaces of this
 * product behave the same way under the same fingers. The group is part
 * of the haystack, which is what makes `food` and `symbols` queries that
 * work; the ranking above is what stops that from burying the row a
 * one-word query actually named.
 *
 * The sort is stable and the tiebreak is table order, so a query with no
 * ranking signal at all returns the groups in the order the table
 * declares them rather than in whatever order the engine felt like.
 */
export function searchEmoji(query: string, table: readonly Emoji[] = EMOJI): Emoji[] {
  const folded = query.trim().toLowerCase();
  const words = folded.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...table];

  const matches = table.filter((emoji) => {
    const hay = `${emoji.name} ${emoji.keywords.join(" ")} ${emoji.group}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });

  return matches
    .map((emoji, i) => ({ emoji, i, rank: rank(emoji, folded) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((entry) => entry.emoji);
}

/** Wide enough for the widest of each, so the columns line up. */
export interface EmojiColumns {
  name: number;
  group: number;
}

export function emojiColumns(table: readonly Emoji[]): EmojiColumns {
  const widest = (pick: (e: Emoji) => string): number =>
    table.reduce((max, e) => Math.max(max, pick(e).length), 0);
  return { name: widest((e) => e.name), group: widest((e) => e.group) };
}

/**
 * One row: the character, its name, its group, and the words that find
 * it.
 *
 * The keywords are on the row rather than hidden because they are the
 * half of the search nobody can guess. Someone who typed `deploy` and got
 * 🚀 learns why; someone who typed it and got nothing needs to see which
 * words exist before they can add the one that does not.
 *
 * The character is not padded. Terminals disagree about how wide an
 * emoji is — two cells usually, one for the older symbols, and the ZWJ
 * sequences are anyone's guess — so a column computed from string length
 * would misalign on the rows it was meant to align. The name column
 * starts after a fixed gap and the ragged left edge is the honest cost.
 */
export function emojiRow(emoji: Emoji, cols: EmojiColumns): string {
  const words = emoji.keywords.length === 0 ? "" : `  ${emoji.keywords.join(", ")}`;
  return `${emoji.char}  ${emoji.name.padEnd(cols.name)}  ${emoji.group.padEnd(cols.group)}${words}`;
}

/** The whole table as text, for a terminal that cannot draw a picker. */
export function emojiLines(table: readonly Emoji[] = EMOJI): string[] {
  const cols = emojiColumns(table);
  return table.map((emoji) => emojiRow(emoji, cols));
}

// ---------------------------------------------------------- the keyboard

/** Where the search box and the cursor are, and nothing else. */
export interface PickerState {
  query: string;
  /** Into the filtered list, never into the whole table. */
  index: number;
}

export const PICKER_START: PickerState = { query: "", index: 0 };

/**
 * The keys the picker reads, structurally — the same declaration
 * `keys.ts` and `panel.ts` both make, and for the same reason: tuiuiu's
 * `Key` carries all of these, so the component hands its own object
 * straight in, and naming only what is used keeps this module free of
 * the renderer.
 */
export interface PickerKey {
  upArrow: boolean;
  downArrow: boolean;
  return: boolean;
  escape: boolean;
  backspace: boolean;
  delete: boolean;
  ctrl: boolean;
}

export interface PickerStep {
  state: PickerState;
  /** The emoji Enter chose, when it chose one. */
  copy?: Emoji;
  /** The picker is finished. */
  quit?: boolean;
}

/**
 * One keystroke, as a decision rather than as a side effect.
 *
 * Deliberately the same interaction as the keys viewer, down to escape
 * clearing the query before it closes: two surfaces of one product that
 * are both "type to filter, arrows to move, enter to act" must not
 * disagree about what escape does, and the only way to be sure of that
 * is to write the same rules twice and pin both.
 *
 * The picker does not close after a copy. Somebody assembling a commit
 * message wants three of these, and a picker that exited on the first
 * would make them press the chord again — so the copy is reported in the
 * status line and the list stays where it is, cursor included.
 */
export function pickerStep(
  state: PickerState,
  input: string,
  key: PickerKey,
  table: readonly Emoji[] = EMOJI,
): PickerStep {
  const visible = searchEmoji(state.query, table);
  const clamp = (i: number): number => Math.max(0, Math.min(visible.length - 1, i));

  // Ctrl+C leaves, whatever is on screen. Every other Ctrl chord is
  // swallowed rather than typed into the search box.
  if (key.ctrl) return input === "c" ? { state, quit: true } : { state };

  if (key.return) {
    const chosen = visible[clamp(state.index)];
    return chosen ? { state, copy: chosen } : { state };
  }

  if (key.escape) {
    return state.query === "" ? { state, quit: true } : { state: PICKER_START };
  }

  if (key.upArrow) return { state: { ...state, index: clamp(state.index - 1) } };
  if (key.downArrow) return { state: { ...state, index: clamp(state.index + 1) } };

  if (key.backspace || key.delete) {
    return state.query === ""
      ? { state }
      : { state: { query: state.query.slice(0, -1), index: 0 } };
  }

  // Back to the top on every edit: the row under the cursor before the
  // keystroke is rarely the row under it after.
  if (input.length === 1 && input >= " " && input !== "\u007f") {
    return { state: { query: state.query + input, index: 0 } };
  }

  return { state };
}
