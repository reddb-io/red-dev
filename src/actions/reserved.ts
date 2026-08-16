/**
 * The chords the hosts have already taken, pinned.
 *
 * ADR 0006 sends every red-dev chord into the `Ctrl+Alt` family, and
 * that family is finite and partly spoken for on both hosts. The ADR
 * says the check "lives in the schema"; this is the half of it that is
 * evidence rather than rule — two lists of keys that GNOME and Windows
 * claim, written down here so a new action collides in a test rather
 * than on somebody's machine.
 *
 * Pinned deliberately, not detected. A collision has to be visible while
 * a chord is being chosen, which is months before the code ever runs on
 * the host in question, and probing a live GNOME would say nothing at
 * all about the Windows laptop the same chord has to work on.
 *
 * Only the `Ctrl+Alt` family is listed. Both hosts reserve far more than
 * this — most of the Super/Win space, which is exactly why ADR 0006
 * refuses to enter it — but a list of keys red-dev may never reach for
 * is a list nothing consults; these are the ones a chord could plausibly
 * be chosen from tomorrow.
 *
 * `Ctrl+Alt+T` is not here, on either side, and its absence is the
 * decision. GNOME does ship it as launch-terminal — that is the same act
 * red-dev's `terminal.new` performs, and adopting the key people already
 * press is the opposite of colliding with it.
 *
 * Spelled canonically — uppercase, modifiers in `chordText` order — so
 * membership is a plain set lookup after a chord has been parsed.
 */

/**
 * GNOME, from its own Keyboard Shortcuts panel on Ubuntu.
 *
 * Workspaces take the arrows and moving a window takes them with Shift;
 * `Ctrl+Alt+Del` is the log-out dialog on Ubuntu; `Ctrl+Alt+L` locks the
 * screen; `Ctrl+Alt+Tab` switches system controls; and `Ctrl+Alt+F1..F12`
 * belong to the virtual terminals underneath the session, which no
 * desktop setting can take back.
 */
export const GNOME_RESERVED: ReadonlySet<string> = new Set([
  "CTRL+ALT+LEFT",
  "CTRL+ALT+RIGHT",
  "CTRL+ALT+UP",
  "CTRL+ALT+DOWN",
  "CTRL+ALT+SHIFT+LEFT",
  "CTRL+ALT+SHIFT+RIGHT",
  "CTRL+ALT+SHIFT+UP",
  "CTRL+ALT+SHIFT+DOWN",
  "CTRL+ALT+DELETE",
  "CTRL+ALT+L",
  "CTRL+ALT+TAB",
  "CTRL+ALT+ESC",
  ...Array.from({ length: 12 }, (_, i) => `CTRL+ALT+F${i + 1}`),
]);

/**
 * Windows.
 *
 * `Ctrl+Alt+Del` is the secure attention sequence: no application may
 * register it, and nothing an installer does can change that.
 * `Ctrl+Alt+Tab` is the sticky task switcher. The arrows are not
 * Windows' own — they are the Intel and AMD display drivers' screen
 * rotation, shipped on a large share of the laptops this project runs
 * on, and a chord that rotates the screen on those machines is a
 * collision whatever the ownership.
 */
export const WINDOWS_RESERVED: ReadonlySet<string> = new Set([
  "CTRL+ALT+DELETE",
  "CTRL+ALT+TAB",
  "CTRL+ALT+LEFT",
  "CTRL+ALT+RIGHT",
  "CTRL+ALT+UP",
  "CTRL+ALT+DOWN",
]);
