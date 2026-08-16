/**
 * Panels — a red-dev terminal surface over one host subsystem: network
 * and DNS first, then audio, power and bluetooth.
 *
 * Born empty; the Panels slice fills it. Worth knowing before it does:
 * a Panel that needs rights asks inline, at the moment the operator
 * changes something, so the action that *opens* a Panel is never
 * privileged — `privileged` on these entries describes opening, not
 * everything the Panel can go on to do.
 */

import type { SemanticAction } from "./types.ts";

export const PANEL_ACTIONS: readonly SemanticAction[] = [];
