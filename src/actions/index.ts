/**
 * The registry: every semantic action red-dev knows, in one list.
 *
 * Every area is imported here from the first commit, empty ones
 * included. The alternative — adding an import when an area first grows
 * an action — is how two slices end up editing the same three lines of
 * the same file, and how an area quietly never gets aggregated at all.
 *
 * This module is the only thing consumers import. Where an action lives
 * is an authoring convenience; that it is in `ACTIONS` is the contract.
 */

import { AGENT_ACTIONS } from "./agents.ts";
import { APP_ACTIONS } from "./apps.ts";
import { CAPTURE_ACTIONS } from "./capture.ts";
import { PANEL_ACTIONS } from "./panels.ts";
import { TERMINAL_ACTIONS } from "./terminal.ts";
import { TERMINAL_SURFACE_ACTIONS } from "./terminal-surfaces.ts";
import type { SemanticAction } from "./types.ts";

export type { Chord, SemanticAction } from "./types.ts";
export { chordText, parseChord } from "./types.ts";
// The gestures written inside terminals and agent hosts. A separate
// list, not a separate registry: they answer the same question and ADR
// 0006 governs only the half of it that claims a host chord.
export type { InputBinding, InputLayers } from "./input.ts";
export {
  escapedSequence,
  IMAGE_PASTE_INPUT,
  INPUT_BINDINGS,
  inputBindingById,
  NEWLINE_INPUT,
} from "./input.ts";
export type { ActionProblem } from "./validate.ts";
export { validateActions } from "./validate.ts";
export { GNOME_RESERVED, WINDOWS_RESERVED } from "./reserved.ts";

export const ACTIONS: readonly SemanticAction[] = [
  ...TERMINAL_ACTIONS,
  ...TERMINAL_SURFACE_ACTIONS,
  ...PANEL_ACTIONS,
  ...APP_ACTIONS,
  ...CAPTURE_ACTIONS,
  ...AGENT_ACTIONS,
];

/**
 * By id, because ids are what other modules store.
 *
 * Undefined rather than a throw: a caller that has lost its action needs
 * to decide what that means — the Windows adapter drops the shortcut
 * rather than writing one with no key, which would clear the binding on
 * every machine that already had it.
 */
export function actionById(id: string): SemanticAction | undefined {
  return ACTIONS.find((a) => a.id === id);
}
