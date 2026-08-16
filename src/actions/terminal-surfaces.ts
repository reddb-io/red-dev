/**
 * The surfaces red-dev draws in a terminal of its own — the menu, the
 * keys viewer, the emoji picker.
 *
 * Born empty, and that was the point. The registry is a directory with a
 * module per area from its first commit so that the slices which build
 * these surfaces add a line to their own file, rather than six slices
 * queueing behind one another over the same list. An empty area is a
 * declaration of where its actions will go; this is the first one
 * arriving.
 *
 * All three are the same act with a different subcommand behind it —
 * red-dev drawing one of its own full-screen surfaces — which is why
 * `firePlan` opens them through one shared path rather than three.
 * Listed in the order the header names them, so the module reads the
 * way its own first sentence does.
 */

import type { SemanticAction } from "./types.ts";

/**
 * Everywhere with a display, WSL included — the same set the terminal
 * actions and the Panels claim, and for the same reason: this list is
 * about a chord, and a chord needs somewhere to be pressed.
 *
 * `server` is absent from the list and not from the product. `red-dev
 * emoji` is a command and it answers over SSH exactly as it does here —
 * it draws the table, searches it, and says that this machine has no
 * clipboard to put the answer on, which is a more useful thing to be
 * told than nothing.
 */
const WITH_A_DISPLAY = ["desktop", "wsl", "windows"] as const;

export const TERMINAL_SURFACE_ACTIONS: readonly SemanticAction[] = [
  {
    id: "menu.open",
    label: "red-dev menu",
    platforms: WITH_A_DISPLAY,
    // The menu is a way in, not a change: everything it can go on to do
    // — converge, install, set a Default agent — asks for itself at the
    // moment it is chosen. The same reading the Panels are given.
    mutates: false,
    privileged: false,
    // M for menu. Free in the family on both hosts: GNOME's Ctrl+Alt
    // spends the arrows on workspaces and takes L, Tab, Esc, Delete and
    // the virtual terminals, and Windows takes Delete, Tab and the
    // display drivers' arrows. Neither claims M.
    chord: "Ctrl+Alt+Shift+M",
  },
  {
    id: "keys.viewer",
    label: "Keys viewer",
    platforms: WITH_A_DISPLAY,
    // It reads the registry and this machine's bindings. Enter inside it
    // starts things, and each of those answers for itself.
    mutates: false,
    privileged: false,
    // K for keys, and free in the family on both hosts. Worth saying
    // plainly: this is the one chord whose whole job is to rescue the
    // others — ADR 0006 calls the viewer the remedy for a chord nobody
    // can remember, and a remedy reachable only by remembering where
    // `red-dev keys` lives is half a remedy.
    chord: "Ctrl+Alt+Shift+K",
  },
  {
    id: "emoji.pick",
    label: "Emoji picker",
    platforms: WITH_A_DISPLAY,
    // Opening it reads a table compiled into the binary. Pressing Enter
    // writes the clipboard, which belongs to the signed-in session and
    // needs nothing from the machine — the same reason the Panels are
    // both false.
    mutates: false,
    privileged: false,
    // E for emoji. Free in the family on both hosts: GNOME spends its
    // Ctrl+Alt on the workspaces, L, Tab, Esc, Delete and the virtual
    // terminals, and Windows on Delete, Tab and the display drivers'
    // arrows. Neither claims E — and the host pickers people may know,
    // GNOME's Ctrl+. and Windows' Win+. , are left exactly where they
    // are, because ADR 0006 keeps red-dev out of the Super family and
    // taking Ctrl+. would fight GTK for a key it uses inside text
    // fields.
    chord: "Ctrl+Alt+Shift+E",
  },
];
