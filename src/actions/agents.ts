/**
 * Reaching the agents — the default one, and the multiplexer that runs
 * several.
 *
 * Born empty; the agents slice fills it. An action here has to survive
 * being absent: the multiplexer is not installed on every machine, and
 * an adapter reports such an action unbound rather than dropping it, so
 * the keys viewer can say "not installed here" instead of going quiet.
 */

import type { SemanticAction } from "./types.ts";

export const AGENT_ACTIONS: readonly SemanticAction[] = [];
