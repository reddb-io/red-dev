/**
 * `red-dev keys` — the registry, as something a person can search, read
 * and press Enter on.
 *
 * The chords are decided once, in `src/actions/`, and registered by
 * whichever adapter owns this target. Neither of those helps the person
 * who knows red-dev binds *something* for the thing they want and cannot
 * remember what. That is what this is: every semantic action, its chord,
 * and whether this machine actually binds it — searchable, and a
 * launcher, because a viewer that can only show you a chord you have
 * forgotten leaves you to type it correctly on the first try.
 *
 * Two rules shape the list, both from ADR 0006.
 *
 * Nothing is hidden. An action with no chord on this target is listed
 * *as unbound, with the reason*, because a viewer that quietly drops
 * what it cannot bind is how "the same experience on every target"
 * becomes untrue without anybody noticing. The reasons are two different
 * kinds of news and are kept apart: `unsupported` is the machine saying
 * "not here" — the action does not apply to this target, or red-dev has
 * no adapter for it yet — and `broken` is the machine saying "here, and
 * it should work, and it does not". The first is a fact to live with;
 * the second is a bug someone has to fix, and merging them into one grey
 * "unavailable" would bury it.
 *
 * Firing does not depend on binding. The Enter key runs the action even
 * where nothing registers its chord, which is the case on GNOME today —
 * an unbound action reachable from the viewer is the remedy the ADR
 * promises, and refusing to run it would leave the target with neither
 * the chord nor the fallback.
 */

import { ACTIONS, actionById, validateActions } from "./actions/index.ts";
import type { SemanticAction } from "./actions/index.ts";
import { START_MENU_ACTIONS, WINDOWS_HOTKEYS } from "./hotkeys.ts";
import type { Platform } from "./platform.ts";

/**
 * What this target does with an action's chord.
 *
 * Three answers rather than a boolean, because "not bound" is two
 * different sentences — see the header. `bound` means an adapter on this
 * target registers this chord.
 */
export type BindingState = "bound" | "unsupported" | "broken";

export interface KeyEntry {
  id: string;
  label: string;
  /**
   * The chord in the registry's own spelling — `Ctrl+Alt+Shift+T`.
   *
   * Not the folded `CTRL+ALT+SHIFT+T` a comparison uses: that spelling
   * exists so two chords can be told apart, and this one exists so a
   * person reads the same thing in the viewer, in the source and in the
   * README.
   */
  chord: string;
  state: BindingState;
  /** Empty when bound; one sentence, in plain words, when not. */
  reason: string;
}

/**
 * What an adapter has to say about one action.
 *
 * Three answers, because an adapter that does not register a chord is
 * saying one of two very different things. `unclaimed` is "I have never
 * carried this action" — a feature whose adapter half has not landed,
 * which is news to live with. `missing` is "I carry it and no chord came
 * back", which is the registry having lost something underneath a working
 * adapter, and is a bug. A boolean would report either one as the other.
 */
type Registration = "bound" | "missing" | "unclaimed";

/**
 * The thing that turns a chord into a registration on this target.
 *
 * One today: the Windows Start Menu `.lnk`, in src/hotkeys.ts. GNOME's
 * is not written yet, and its absence is reported rather than hidden —
 * that absence is precisely what someone reading the viewer on Ubuntu
 * needs to be told.
 */
interface Adapter {
  /** Named the way the reason sentence needs to read. */
  name: string;
  registers(id: string): Registration;
}

function adapterFor(p: Platform): Adapter | null {
  if (p.env === "windows" || p.env === "wsl") {
    return {
      name: "Windows Start Menu",
      registers: (id) => {
        if (!START_MENU_ACTIONS.includes(id)) return "unclaimed";
        return WINDOWS_HOTKEYS.some((h) => h.id === id && h.combo !== null) ? "bound" : "missing";
      },
    };
  }
  return null;
}

/**
 * Every action, in registry order, judged against this machine.
 *
 * Registry order rather than bound-first: the list is a map of what
 * red-dev can do, and a map that reorders itself per machine is one
 * nobody memorises. The actions are a parameter so a test can hold a
 * broken one without the registry having to carry it.
 */
export function keyEntries(
  p: Platform,
  actions: readonly SemanticAction[] = ACTIONS,
): KeyEntry[] {
  // The validator's own sentences, so the viewer and `validateActions`
  // never describe the same fault two different ways. First one per
  // action: they are all about the same chord, and a list of five
  // problems in a status line is a list nobody reads.
  const faults = new Map<string, string>();
  for (const problem of validateActions(actions)) {
    if (!faults.has(problem.id)) faults.set(problem.id, problem.problem);
  }

  const adapter = adapterFor(p);

  return actions.map((action): KeyEntry => {
    const head = { id: action.id, label: action.label, chord: action.chord };

    const fault = faults.get(action.id);
    // Broken first, and deliberately before the platform check: an
    // unreadable chord is wrong on every target, and reporting it as
    // "not supported here" on the three targets it does not apply to
    // would hide it on three machines out of four.
    if (fault) return { ...head, state: "broken", reason: fault };

    if (!action.platforms.includes(p.env)) {
      return {
        ...head,
        state: "unsupported",
        reason: `does not apply to ${p.env} — it applies to ${action.platforms.join(", ")}`,
      };
    }

    if (!adapter) {
      return {
        ...head,
        state: "unsupported",
        reason: `red-dev has no bindings adapter for ${p.env} yet, so nothing registers the chord here`,
      };
    }

    const registration = adapter.registers(action.id);
    if (registration === "missing") {
      return {
        ...head,
        state: "broken",
        reason: `the ${adapter.name} adapter carries it and no chord came back, though this target should`,
      };
    }

    if (registration === "unclaimed") {
      // The sibling of the no-adapter sentence above, and deliberately
      // worded like it: an adapter exists here, it simply has not grown
      // a shortcut for this action. Reported as the fact it is rather
      // than as a fault, because calling it broken would send whoever
      // reads it looking for a shortcut that was never written.
      return {
        ...head,
        state: "unsupported",
        reason: `the ${adapter.name} adapter has no shortcut for it yet, so nothing registers the chord here`,
      };
    }

    return { ...head, state: "bound", reason: "" };
  });
}

/**
 * The list, narrowed by what has been typed.
 *
 * Every word has to match somewhere, in any order and anywhere in the
 * row: `alt t` finds the terminal, and so does `term`. Case is folded
 * because nobody types `Ctrl+Alt+Shift+T` into a search box, and the
 * state is part of the haystack so `broken` is a query that answers the
 * question the word asks.
 */
export function searchKeys(
  entries: readonly KeyEntry[],
  query: string,
): KeyEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...entries];
  return entries.filter((entry) => {
    const hay = `${entry.chord} ${entry.label} ${entry.id} ${entry.state}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

export interface KeyColumns {
  chord: number;
  label: number;
  id: number;
}

/** Wide enough for the widest of each, so the columns line up. */
export function keyColumns(entries: readonly KeyEntry[]): KeyColumns {
  const widest = (pick: (e: KeyEntry) => string): number =>
    entries.reduce((max, e) => Math.max(max, pick(e).length), 0);
  return {
    chord: widest((e) => e.chord),
    label: widest((e) => e.label),
    id: widest((e) => e.id),
  };
}

/**
 * One row: the chord, what it does, the id, and whether it is bound.
 *
 * The id is on the row rather than behind a keypress because it is the
 * name everything else stores — a bug report that says `terminal.new`
 * is answerable and one that says "the terminal one" is not.
 */
export function keyRow(entry: KeyEntry, cols: KeyColumns): string {
  return [
    entry.chord.padEnd(cols.chord),
    entry.label.padEnd(cols.label),
    entry.id.padEnd(cols.id),
    entry.state === "bound" ? "bound" : "unbound",
  ].join("  ");
}

/**
 * The whole list as text, for a terminal that cannot draw a viewer.
 *
 * The reason rides on the row here, because there is no panel to put it
 * in and an unbound line with no reason is the thing this command exists
 * not to print.
 */
export function keyLines(entries: readonly KeyEntry[]): string[] {
  const cols = keyColumns(entries);
  return entries.map((entry) => {
    const row = keyRow(entry, cols);
    return entry.state === "bound" ? row : `${row} — ${entry.reason}`;
  });
}

/**
 * What Enter runs, decided before anything is started.
 *
 * The same shape as `LaunchDecision` in src/agent-launch.ts and for the
 * same reason: deciding and doing are separate so the deciding half can
 * be read by a test, and so a refusal arrives as a sentence for the
 * status line rather than as a process that failed somewhere off screen.
 */
export type FirePlan =
  | { ok: true; id: string; argv: string[]; note: string }
  | { ok: false; id: string; detail: string };

/**
 * The terminals a Linux desktop might have, best first.
 *
 * `x-terminal-emulator` is Debian's alternatives symlink — whatever the
 * person actually chose — which is why it outranks naming GNOME's.
 */
const LINUX_TERMINALS = ["alacritty", "x-terminal-emulator", "gnome-terminal", "xterm"] as const;

/**
 * How each of them is told to run a command instead of a shell.
 *
 * Not one flag for all four. `gnome-terminal`'s `-e` takes a single
 * string and has been deprecated for years; everything after `--` is the
 * argv it runs, which is the form that survives an argument with a space
 * in it. Getting this wrong opens a terminal with a shell in it and no
 * sign that the command was dropped.
 */
const TERMINAL_EXEC: Record<string, string> = {
  alacritty: "-e",
  "x-terminal-emulator": "-e",
  "gnome-terminal": "--",
  xterm: "-e",
};

/** Windows is the host that registers chords, from either side of WSL. */
function onWindowsHost(p: Platform): boolean {
  return p.env === "windows" || p.env === "wsl";
}

/**
 * One of red-dev's own surfaces, in a terminal of its own.
 *
 * The menu, the keys viewer, the emoji picker, every Panel and the
 * Default agent are the same act with a different subcommand behind it,
 * and all of them need a terminal that is not this one: the viewer is
 * already drawing here, and running any of them in place would put two
 * full-screen surfaces on the same frame. One helper rather than a
 * block per action, because six copies of it is how the seventh arrives
 * with the gnome-terminal flag wrong — the failure the Panels' shared
 * case was already written to avoid.
 *
 * `tail` is the red-dev command line, and it doubles as the remedy
 * printed on a machine with no terminal emulator: somebody working over
 * SSH can run it where they already are, and being told so is more use
 * than a window that could not be opened.
 */
function ownSurface(
  id: string,
  p: Platform,
  locate: (cmd: string) => string | null,
  tail: readonly string[],
  description: string,
): FirePlan {
  if (onWindowsHost(p)) {
    // `start` with the empty title slot, exactly as terminal.new uses
    // it and for the same reason: this process is a console process, and
    // spawning from it would hand the new surface the console red-dev is
    // drawing in. red-dev.exe is on the PATH both installers write.
    return {
      ok: true,
      id,
      argv: ["cmd.exe", "/c", "start", "", "red-dev.exe", ...tail],
      note: `${description} in a new window`,
    };
  }
  const found = LINUX_TERMINALS.find((cmd) => locate(cmd) !== null);
  if (!found) {
    return {
      ok: false,
      id,
      detail: `no terminal emulator on PATH — run \`red-dev ${tail.join(" ")}\` here instead`,
    };
  }
  return {
    ok: true,
    id,
    argv: [found, TERMINAL_EXEC[found] ?? "-e", "red-dev", ...tail],
    note: `${description} in ${found}`,
  };
}

export function firePlan(
  id: string,
  p: Platform,
  locate: (cmd: string) => string | null,
): FirePlan {
  const action = actionById(id);
  if (!action) return { ok: false, id, detail: `no action called ${id}` };

  switch (id) {
    case "terminal.new": {
      if (onWindowsHost(p)) {
        // Through `start`, not straight at the executable. This process
        // is a console process on both sides of the WSL boundary, and
        // spawning a terminal from it hands the new terminal the console
        // red-dev is drawing in. `start` is the shell asking Windows for
        // a window instead, and the empty argument after it is the title
        // slot — without it `start` reads the program name as a title
        // and opens an empty console.
        //
        // The targets are the ones the Start Menu shortcut already
        // resolves to (src/hotkeys.ts): Alacritty when it is installed,
        // otherwise WSL in the home directory.
        const alacritty = locate("alacritty.exe") !== null;
        const exe = alacritty ? "alacritty.exe" : "wsl.exe";
        const argv = alacritty
          ? ["cmd.exe", "/c", "start", "", exe]
          : ["cmd.exe", "/c", "start", "", exe, "--cd", "~"];
        return { ok: true, id, argv, note: `${exe} in a new window` };
      }
      const found = LINUX_TERMINALS.find((cmd) => locate(cmd) !== null);
      if (!found) {
        return {
          ok: false,
          id,
          detail: `no terminal emulator on PATH — looked for ${LINUX_TERMINALS.join(", ")}`,
        };
      }
      return { ok: true, id, argv: [found], note: found };
    }

    case "terminal.elevated": {
      if (!onWindowsHost(p)) {
        // Refused rather than approximated. `pkexec bash` in a window is
        // not the act this action names, and inventing a local substitute
        // is the exact thing ADR 0006 tells an adapter not to do.
        return {
          ok: false,
          id,
          detail:
            "an elevated shell is the Windows act red-dev binds; on Linux, sudo in the terminal you already have does it",
        };
      }
      // Start-Process -Verb RunAs is what raises the consent prompt; the
      // .lnk does the same through byte 21 of the shortcut format.
      return {
        ok: true,
        id,
        argv: ["powershell.exe", "-NoProfile", "-Command", "Start-Process powershell -Verb RunAs"],
        note: "PowerShell, once the consent prompt is answered",
      };
    }

    case "menu.open":
      return ownSurface(id, p, locate, ["menu"], "the red-dev menu");

    case "keys.viewer":
      // The viewer opening the viewer is not a loop worth refusing: the
      // chord exists so it can be pressed anywhere, and firing the row
      // from inside the viewer is the least likely way anybody reaches
      // it. What it must not do is draw a second one on this frame,
      // which is exactly what the shared path prevents.
      return ownSurface(id, p, locate, ["keys"], "the keys viewer");

    case "emoji.pick":
      return ownSurface(id, p, locate, ["emoji"], "the emoji picker");

    case "panel.network":
    case "panel.audio":
    case "panel.power": {
      // The subsystem is taken off the id rather than written out per
      // Panel: every Panel is opened exactly the same way, and a copy
      // each is how the next one arrives spelled differently.
      const name = id.slice("panel.".length);
      return ownSurface(id, p, locate, ["panel", name], `the ${name} panel`);
    }

    case "agent.launch":
      // `red-dev agents run`, never a host's own executable. That
      // command is the single place that reads the recorded Default
      // agent — `resolveLaunch` in src/agent-launch.ts — and the single
      // place the bypass guard stands, so a plan that named `claude`
      // here would walk around both: it would be right on most machines
      // and silently wrong on the ones where somebody chose, and it
      // would put red-dev in the business of assembling a host's command
      // line from a surface that never reads the ADR.
      return ownSurface(id, p, locate, ["agents", "run"], "the Default agent");

    case "agent.multiplex": {
      if (p.env === "windows") {
        // Refused rather than approximated, the same way terminal.new's
        // elevated sibling is refused on Linux. The action is still on
        // the list here — ADR 0006 does not let a target delete what it
        // cannot honour — and this is the sentence that says why.
        return {
          ok: false,
          id,
          detail:
            "herdr has no stable Windows build — it runs inside WSL, which is where this chord starts it",
        };
      }
      // Absence is answered before anything else is looked at, so a
      // machine without herdr says so rather than reporting whichever
      // other thing is also missing. That ordering is the acceptance
      // criterion: "reported absent where it is not installed" is worth
      // nothing if the sentence that comes back is about terminals.
      if (locate("herdr") === null) {
        return {
          ok: false,
          id,
          detail:
            "herdr is not installed here — it multiplexes several agents into one terminal, and lives at herdr.dev",
        };
      }
      if (onWindowsHost(p)) {
        // `env` is `wsl` by elimination: this red-dev is inside the
        // distro, so the herdr just found on PATH is the one wsl.exe
        // will start, and the window it needs belongs to the host.
        return {
          ok: true,
          id,
          argv: ["cmd.exe", "/c", "start", "", "wsl.exe", "--", "herdr"],
          note: "herdr in a new window",
        };
      }
      const found = LINUX_TERMINALS.find((cmd) => locate(cmd) !== null);
      if (!found) {
        return { ok: false, id, detail: "no terminal emulator on PATH — run `herdr` here instead" };
      }
      return {
        ok: true,
        id,
        argv: [found, TERMINAL_EXEC[found] ?? "-e", "herdr"],
        note: `herdr in ${found}`,
      };
    }

    default:
      // An action in the registry that nothing can run yet. Named, not
      // shrugged at: the registry is filled by slices that arrive one at
      // a time, and "nothing happened" is the worst way to learn that
      // this one has not landed.
      return { ok: false, id, detail: `${action.label} has nothing to run from here yet` };
  }
}

/** Started, or the reason it was not — either way, one line. */
export interface FireOutcome {
  fired: boolean;
  detail: string;
}

export type Spawn = (argv: string[]) => Promise<number> | number;

/**
 * Start what the highlighted entry names.
 *
 * `spawn` and `locate` are injected for the reason resolveLaunch injects
 * its own: PATH and process creation are not answerable in a test, and
 * the thing worth pinning is that choosing an entry starts *that*
 * action's command rather than its neighbour's.
 */
export async function fireEntry(
  entry: KeyEntry,
  p: Platform,
  spawn: Spawn,
  locate: (cmd: string) => string | null = (cmd) => Bun.which(cmd),
): Promise<FireOutcome> {
  const plan = firePlan(entry.id, p, locate);
  if (!plan.ok) return { fired: false, detail: plan.detail };
  try {
    await spawn(plan.argv);
  } catch (err) {
    return { fired: false, detail: `${entry.label}: ${(err as Error).message}` };
  }
  return { fired: true, detail: `${entry.label} — ${plan.note}` };
}

/**
 * Start it and let go.
 *
 * The three streams are ignored and the child is unref'd because what
 * this starts is a window of its own: inheriting the streams would put
 * a second program inside the frame red-dev is drawing, and keeping a
 * reference would hold the viewer open until the terminal someone just
 * opened is closed again.
 */
export function detach(argv: string[]): number {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  child.unref();
  return 0;
}

/** Where the search box and the cursor are, and nothing else. */
export interface ViewerState {
  query: string;
  /** Into the filtered list, never into the whole one. */
  index: number;
}

export const VIEWER_START: ViewerState = { query: "", index: 0 };

/**
 * The keys the viewer reads, structurally.
 *
 * tuiuiu's `Key` carries all of these, so the component hands its own
 * object straight in; declaring only what is used keeps this module free
 * of the renderer, which is what lets the whole interaction be tested
 * without one.
 */
export interface ViewerKey {
  upArrow: boolean;
  downArrow: boolean;
  return: boolean;
  escape: boolean;
  backspace: boolean;
  delete: boolean;
  ctrl: boolean;
}

export interface ViewerStep {
  state: ViewerState;
  /** The entry Enter chose, when it chose one. */
  fire?: KeyEntry;
  /** The viewer is finished. */
  quit?: boolean;
}

/**
 * One keystroke, as a decision rather than as a side effect.
 *
 * Every printable character is search, which is what makes this a
 * searchable viewer rather than a list with a filter hidden behind a
 * key: `j` and `k` cannot navigate here, because they are also the two
 * letters in the middle of nothing anybody is trying to type. The arrows
 * move.
 *
 * Escape clears the query before it closes the viewer. Someone with a
 * search that found nothing is one keystroke from the whole list, and
 * one more from leaving — rather than out of the program because their
 * typo had no matches.
 */
export function viewerStep(
  entries: readonly KeyEntry[],
  state: ViewerState,
  input: string,
  key: ViewerKey,
): ViewerStep {
  const visible = searchKeys(entries, state.query);
  const clamp = (i: number): number => Math.max(0, Math.min(visible.length - 1, i));

  // Ctrl+C leaves, whatever is on screen. Every other Ctrl chord is
  // swallowed rather than typed into the search box.
  if (key.ctrl) return input === "c" ? { state, quit: true } : { state };

  if (key.return) {
    const chosen = visible[clamp(state.index)];
    return chosen ? { state, fire: chosen } : { state };
  }

  if (key.escape) {
    return state.query === "" ? { state, quit: true } : { state: VIEWER_START };
  }

  if (key.upArrow) return { state: { ...state, index: clamp(state.index - 1) } };
  if (key.downArrow) return { state: { ...state, index: clamp(state.index + 1) } };

  if (key.backspace || key.delete) {
    return state.query === ""
      ? { state }
      : { state: { query: state.query.slice(0, -1), index: 0 } };
  }

  // Back to the top on every edit: the row under the cursor before the
  // keystroke is rarely the row under it after, and leaving the index
  // where it was highlights whatever happens to be in that position.
  if (input.length === 1 && input >= " " && input !== "\u007f") {
    return { state: { query: state.query + input, index: 0 } };
  }

  return { state };
}
