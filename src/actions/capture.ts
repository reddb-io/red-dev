/**
 * Taking a picture of the screen, and whatever else red-dev learns to
 * capture from it.
 *
 * Born empty; the slice that builds capture fills it. The area exists
 * from the start because a capture chord is the kind of thing that
 * otherwise gets hard-coded wherever the screenshot tool is invoked,
 * which is the failure the registry was created to end.
 */

import type { SemanticAction } from "./types.ts";

export const CAPTURE_ACTIONS: readonly SemanticAction[] = [];
