/**
 * ADR 0006, executable.
 *
 * The ADR says every semantic action has one chord, that the chord is
 * the same on every target, that it comes from the `Ctrl+Alt` family,
 * that red-dev never claims `Super`/`Win`, and that "every new chord is
 * checked against both hosts' reserved lists before it ships, and the
 * schema is where that check lives". This is that check.
 *
 * It returns problems instead of throwing, and it collects all of them
 * instead of stopping at the first. Someone adding six actions wants the
 * six answers in one run; and a registry that threw while loading would
 * take the whole program down over a typo in a key name.
 */

import { GNOME_RESERVED, WINDOWS_RESERVED } from "./reserved.ts";
import type { SemanticAction } from "./types.ts";
import { chordText, parseChord } from "./types.ts";

export interface ActionProblem {
  /** The action the problem belongs to. */
  id: string;
  /** One sentence, phrased for whoever just added the action. */
  problem: string;
}

/**
 * Area first, lowercase, dotted: `terminal.new`, `panel.network`.
 *
 * Stability is the reason for a shape at all — an id is what other
 * things store — and a shape is what makes "stable" checkable rather
 * than merely intended.
 */
const STABLE_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/;

export function validateActions(actions: readonly SemanticAction[]): ActionProblem[] {
  const problems: ActionProblem[] = [];
  const ids = new Set<string>();
  const chords = new Map<string, string>();

  for (const action of actions) {
    const { id } = action;

    if (!STABLE_ID.test(id)) {
      problems.push({ id, problem: `id ${JSON.stringify(id)} is not a lowercase dotted name` });
    }
    if (ids.has(id)) problems.push({ id, problem: `id ${JSON.stringify(id)} is used twice` });
    ids.add(id);

    if (action.label.trim() === "") problems.push({ id, problem: "has no label" });
    if (action.platforms.length === 0) problems.push({ id, problem: "applies to no platform" });

    // One chord, and one that can be read. Empty text, two keys, a
    // modifier on its own — none of those is a chord an adapter could
    // register, and each has to be named here rather than discovered by
    // an adapter shrugging at runtime.
    const chord = parseChord(action.chord);
    if (!chord) {
      problems.push({ id, problem: `chord ${JSON.stringify(action.chord)} is not one readable chord` });
      continue;
    }

    const text = chordText(chord);
    if (chord.win) {
      problems.push({ id, problem: `chord ${text} claims Super/Win, which ADR 0006 leaves to the host` });
    } else if (!chord.ctrl || !chord.alt) {
      problems.push({ id, problem: `chord ${text} is outside the Ctrl+Alt family` });
    }

    // Both hosts, always, whichever platforms the action names. A chord
    // is the same on every target by decision, so a collision anywhere
    // is a collision — an action that applies to Windows alone still
    // cannot take a key GNOME holds, because tomorrow it applies to
    // both and nobody re-runs this thought.
    if (GNOME_RESERVED.has(text)) problems.push({ id, problem: `chord ${text} is reserved by GNOME` });
    if (WINDOWS_RESERVED.has(text)) problems.push({ id, problem: `chord ${text} is reserved by Windows` });

    const owner = chords.get(text);
    if (owner !== undefined) problems.push({ id, problem: `chord ${text} already belongs to ${owner}` });
    else chords.set(text, id);
  }

  return problems;
}
