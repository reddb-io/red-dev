/**
 * Applications red-dev can open — web apps in their own window, and the
 * host panels it hands a subsystem back to where no first-party CLI
 * exists.
 *
 * Born empty, and likely to stay thin: a web app gets a chord only when
 * the person gives it one. Shipping a default chord per catalogue item
 * would spend the `Ctrl+Alt` family on taste, and the family is small.
 */

import type { SemanticAction } from "./types.ts";

export const APP_ACTIONS: readonly SemanticAction[] = [];
