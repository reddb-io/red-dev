/**
 * Opening a shell — the two acts red-dev already binds.
 *
 * These are not new. They have existed as literals inside the Windows
 * hotkeys module since the Start Menu shortcuts were written, and the
 * README has printed them in a table for as long. Moving them here
 * changes nothing about what the keys do; it makes the module that
 * writes the shortcuts a consumer of the list rather than a second
 * source of it, which is the whole point of the registry.
 *
 * The labels are neutral on purpose. `PowerShell (Administrator)` is the
 * name of a Start Menu entry on one host, not the name of the act; the
 * Windows adapter keeps that name, this list keeps the meaning.
 */

import type { SemanticAction } from "./types.ts";

/**
 * Everywhere with a display, WSL included.
 *
 * WSL is listed because a person working inside WSL presses the key and
 * expects a terminal — the registration happens on the Windows host on
 * that install's behalf, which is a fact about the adapter, not about
 * where the action applies. `server` is absent for the opposite reason:
 * there is nothing there to press a key on.
 */
const WITH_A_DISPLAY = ["desktop", "wsl", "windows"] as const;

export const TERMINAL_ACTIONS: readonly SemanticAction[] = [
  {
    id: "terminal.new",
    label: "Terminal",
    platforms: WITH_A_DISPLAY,
    mutates: false,
    privileged: false,
    chord: "Ctrl+Alt+T",
  },
  {
    id: "terminal.elevated",
    label: "Elevated shell",
    platforms: WITH_A_DISPLAY,
    mutates: false,
    // The shell it opens can do anything; opening it is the privileged
    // part, and it is where the consent prompt happens.
    privileged: true,
    chord: "Ctrl+Alt+Shift+T",
  },
];
