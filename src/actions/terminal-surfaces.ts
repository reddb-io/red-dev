/**
 * The surfaces red-dev draws in a terminal of its own — the menu, the
 * keys viewer, the emoji picker.
 *
 * Born empty, and that is the point. The registry is a directory with a
 * module per area from its first commit so that the slices which build
 * these surfaces add a line to their own file, rather than six slices
 * queueing behind one another over the same list. An empty area is a
 * declaration of where its actions will go.
 */

import type { SemanticAction } from "./types.ts";

export const TERMINAL_SURFACE_ACTIONS: readonly SemanticAction[] = [];
