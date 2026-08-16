/**
 * The GNOME half of the semantic action registry — the adapter that
 * makes a chord fire on Linux at all.
 *
 * Until this existed nothing registered a keybinding on a GNOME desktop:
 * `red-dev keys` reported every action `unbound` there, and the panels,
 * the emoji picker and the keys viewer were reachable only by typing
 * their command. ADR 0006 fixed one chord family across targets
 * precisely so the same key would work everywhere, and on the target
 * red-dev was born for it worked nowhere.
 *
 * GNOME has no .lnk and no RegisterHotKey. What it has is dconf: a list
 * of paths in `org.gnome.settings-daemon.plugins.media-keys
 * custom-keybindings`, and under each of those paths a relocatable
 * schema carrying a name, a command and an accelerator. Writing all
 * four is registering a shortcut; the settings daemon picks it up
 * without a logout.
 *
 * Which keys they are is not decided here. This module owns *how* a
 * chord is registered on GNOME — the dconf paths, the accelerator
 * spelling, the ownership — and reads *which* chord it is from
 * `src/actions/`, per ADR 0006. The Windows adapter in src/hotkeys.ts is
 * its sibling and reads exactly the same list.
 *
 * Three rules shape the rest.
 *
 * **Ownership is in the path.** GNOME's own Settings allocates
 * `custom0`, `custom1`, …; red-dev allocates `red-dev-<id>` instead. A
 * converge can then add, update and withdraw its own entries by name,
 * and a person's custom keybindings are not merely left alone by
 * accident — they are unreachable from here. A list rewritten by index
 * is how somebody's own shortcut gets silently replaced by ours.
 *
 * **An action that cannot be registered is reported, not dropped.** ADR
 * 0006 says an adapter never invents a local substitute: where GNOME
 * will not take the chord the action is reported unbound with the
 * reason, and no second key is chosen for it. `terminal.elevated` is
 * that case today and is declared below rather than quietly missing —
 * the same two-silence distinction the Windows adapter draws.
 *
 * **One owner per accelerator.** GNOME ships its own `Ctrl+Alt+T`
 * (launch-terminal, whatever the session's default handler is), which is
 * the same act red-dev's `terminal.new` performs on a machine where
 * red-dev installed Alacritty. Two grabs of one accelerator is not a
 * behaviour worth guessing at, so the built-in is cleared while red-dev
 * holds the key and restored — `gsettings reset`, back to GNOME's own
 * default — when it lets go.
 */

import { actionById, parseChord } from "./actions/index.ts";
import type { Chord } from "./actions/index.ts";
import type { FirePlan } from "./keys.ts";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";

/** Where GNOME keeps every custom keybinding, its own and everyone's. */
export const CUSTOM_ROOT =
  "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/";

const MEDIA_KEYS = "org.gnome.settings-daemon.plugins.media-keys";

/** The relocatable schema each path under CUSTOM_ROOT carries. */
const CUSTOM_SCHEMA = `${MEDIA_KEYS}.custom-keybinding`;

/**
 * The segment that says a path is red-dev's.
 *
 * GNOME's Settings writes `custom0`, `custom1`, … and renumbers nothing,
 * so an adapter that allocated the next free index would hand back a
 * path a person's shortcut may already own after a reorder. A name is
 * stable, it is legible in `dconf dump`, and it makes withdrawal exact.
 */
const OWNED = "red-dev-";

/** GNOME's own launch-terminal key, in the same schema. */
const LAUNCH_TERMINAL = "terminal";

/**
 * The chord GNOME ships that key with, folded for comparison.
 *
 * GNOME's fact rather than red-dev's: the registry decides which chord
 * `terminal.new` carries, and this is what the host already answers to.
 * That they are the same key is the point — ADR 0006 adopts the key
 * people already press instead of colliding with it — and it is why the
 * built-in has to be cleared while red-dev holds it.
 */
const STOCK_LAUNCH_TERMINAL = "ALT+CONTROL+t";

/** The dconf path red-dev registers an action at. */
export function ownedPath(id: string): string {
  // Dots are not a dconf path segment; `terminal.new` becomes
  // `red-dev-terminal-new`, which is still the id read aloud.
  return `${CUSTOM_ROOT}${OWNED}${id.replace(/\./g, "-")}/`;
}

/** Whether a path in GNOME's list is one red-dev wrote. */
export function isOwned(path: string): boolean {
  return path.startsWith(`${CUSTOM_ROOT}${OWNED}`);
}

/**
 * The non-modifier key, spelled as GDK names it.
 *
 * Letters are lowercase, the named keys carry GDK's own capitalisation —
 * `Page_Up`, `BackSpace`, `space` — and nothing else is guessed at. Null
 * for a key this adapter has no GNOME name for, which is a refusal to
 * report rather than an accelerator to invent.
 */
function gnomeKeyName(key: string): string | null {
  if (/^[A-Z]$/.test(key)) return key.toLowerCase();
  if (/^[0-9]$/.test(key)) return key;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  const named: Record<string, string> = {
    LEFT: "Left",
    RIGHT: "Right",
    UP: "Up",
    DOWN: "Down",
    DELETE: "Delete",
    TAB: "Tab",
    ESC: "Escape",
    ENTER: "Return",
    SPACE: "space",
    BACKSPACE: "BackSpace",
    HOME: "Home",
    END: "End",
    PAGEUP: "Page_Up",
    PAGEDOWN: "Page_Down",
    INSERT: "Insert",
    PRINT: "Print",
  };
  return named[key] ?? null;
}

/**
 * A chord in GTK's accelerator spelling — `<Control><Alt>t`.
 *
 * Modifier order is GTK's own, so what red-dev writes is what a person
 * comparing it against GNOME's Settings sees. Null when the key has no
 * GNOME name: an accelerator this adapter cannot spell is one GNOME
 * would not take, and reporting that is the whole of its answer.
 */
export function gnomeAccel(chord: Chord): string | null {
  const key = gnomeKeyName(chord.key);
  if (!key) return null;
  let mods = "";
  if (chord.shift) mods += "<Shift>";
  if (chord.ctrl) mods += "<Control>";
  if (chord.alt) mods += "<Alt>";
  // ADR 0006 keeps red-dev out of this family entirely and the registry
  // validator rejects a chord that claims it. Spelled anyway, because an
  // accelerator that silently dropped a modifier would register a
  // different key from the one it was asked for.
  if (chord.win) mods += "<Super>";
  return `${mods}${key}`;
}

/**
 * One spelling of an accelerator, for comparing two of them.
 *
 * The same idea as the `Normal()` function the Windows adapter had to
 * grow, and for a related reason: GNOME's own defaults are written with
 * `<Primary>` where red-dev writes `<Control>`, and a literal comparison
 * against `['<Primary><Alt>t']` says "no collision" about the one
 * collision this adapter exists to resolve. Order and case go too, so a
 * hand-edited `<Alt><Control>T` still compares equal.
 */
export function normalAccel(accel: string): string {
  const mods = [...accel.matchAll(/<([A-Za-z]+)>/g)]
    .map((m) => (m[1] ?? "").toUpperCase())
    .map((m) => (m === "PRIMARY" ? "CONTROL" : m))
    .sort();
  const key = accel.replace(/<[A-Za-z]+>/g, "").trim();
  return [...mods, key.length === 1 ? key.toLowerCase() : key].join("+");
}

/** One action this adapter carries, and what its chord opens. */
interface GnomeEntry {
  id: string;
  note: string;
}

/**
 * The GNOME half of the registry — every action that applies to a
 * desktop and that this adapter registers.
 *
 * Which key each one carries belongs to the registry and is read from
 * it rather than repeated here. What is decided here is that the action
 * gets a custom keybinding at all.
 *
 * `terminal.elevated` is deliberately absent and declared in REFUSED
 * below: it applies to `desktop`, and there is no elevated-shell act on
 * Linux for a chord to open. `agent.multiplex` is present — herdr runs
 * natively here, which is exactly the machine it was written for — and
 * is skipped at converge time, out loud, where herdr is not installed.
 */
const KEYBINDINGS: readonly GnomeEntry[] = [
  { id: "terminal.new", note: "the terminal red-dev installed, not the session's default handler" },
  { id: "menu.open", note: "red-dev's own menu, in a terminal of its own" },
  { id: "keys.viewer", note: "this list, searchable — the remedy ADR 0006 promises" },
  { id: "emoji.pick", note: "the picker, which writes the clipboard" },
  { id: "panel.network", note: "network and DNS" },
  { id: "panel.audio", note: "what the machine plays and hears" },
  { id: "panel.power", note: "battery, and what drains it" },
  { id: "agent.launch", note: "whichever host is the recorded Default agent" },
  { id: "agent.multiplex", note: "herdr, where it is installed" },
];

/**
 * An action that applies here and that GNOME will not be given a key
 * for, with the sentence the keys viewer prints.
 *
 * Declared rather than omitted. ADR 0006 forbids inventing a local
 * substitute, so the alternative to a chord is a reason — and a reason
 * somebody wrote down beats an action quietly missing from the list
 * above, which reads identically to one whose adapter half nobody has
 * written yet.
 */
const REFUSED: readonly { id: string; reason: string }[] = [
  {
    id: "terminal.elevated",
    reason:
      "the GNOME keybindings adapter will not bind it: an elevated shell is the Windows act red-dev binds, "
      + "and sudo in the terminal you already have does it here — so no second chord is chosen for it",
  },
];

/**
 * The actions this adapter carries an entry for, whether or not one came
 * back with an accelerator.
 *
 * Exported for the same reason START_MENU_ACTIONS is: the keys viewer
 * has to tell two silences apart. An action missing from the list is one
 * this adapter never claimed; an action in it that produced no
 * accelerator is the registry having lost something underneath a working
 * adapter, and that is a bug rather than news.
 */
export const GNOME_ACTIONS: readonly string[] = KEYBINDINGS.map((entry) => entry.id);

/** One registered shortcut, before this machine has been looked at. */
export interface GnomeBinding {
  id: string;
  /** What GNOME's Settings shows, with red-dev's name on it. */
  name: string;
  /** The dconf path red-dev owns for this action. */
  path: string;
  /** The chord in GTK's spelling — `<Control><Alt>t`. */
  accel: string;
  note: string;
}

export const GNOME_BINDINGS: GnomeBinding[] = KEYBINDINGS.flatMap((entry) => {
  const action = actionById(entry.id);
  const chord = action ? parseChord(action.chord) : null;
  const accel = chord ? gnomeAccel(chord) : null;
  // An action that left the registry, or a chord GNOME has no name for,
  // drops its shortcut rather than being written with an empty
  // accelerator — which is a listed keybinding that fires nothing and
  // reads, in Settings, as one somebody meant.
  if (!action || !accel) return [];
  return [{
    id: entry.id,
    // Prefixed, because the path is invisible in GNOME's Settings and
    // the name is the only place a person browsing their shortcuts can
    // see who put this one there.
    name: `red-dev: ${action.label}`,
    path: ownedPath(entry.id),
    accel,
    note: entry.note,
  }];
});

/** The sentence for an action this adapter declines to register. */
export function gnomeRefusal(id: string): string | null {
  return REFUSED.find((r) => r.id === id)?.reason ?? null;
}

/** One custom keybinding, as the four values dconf actually holds. */
export interface GnomeCustom {
  path: string;
  name: string;
  command: string;
  binding: string;
}

/** What this machine's dconf says right now. */
export interface GnomeState {
  /** `custom-keybindings`, in GNOME's order — a person's entries included. */
  list: readonly string[];
  /** What red-dev's own listed entries currently carry. */
  owned: readonly GnomeCustom[];
  /** GNOME's launch-terminal binding, or null where the key is absent. */
  launchTerminal: readonly string[] | null;
}

/** One gsettings invocation, and what it is for. */
export interface GnomeStep {
  /** The arguments after `gsettings`, spawned without a shell. */
  argv: string[];
  /** One line for the converge log, or empty for a step not worth one. */
  note: string;
}

/** `red-dev keys`' own decision, injected rather than imported. */
export type FireLookup = (id: string) => FirePlan;

/**
 * A command line GNOME can spawn, from an argv red-dev decided.
 *
 * GNOME hands the string to `g_shell_parse_argv`, so an argument with a
 * space in it has to arrive quoted or it becomes two arguments.
 */
export function commandLine(argv: readonly string[]): string {
  return argv
    .map((arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`))
    .join(" ");
}

/** What each registered action opens, and what this machine cannot open. */
export interface GnomeDesired {
  customs: GnomeCustom[];
  /** Registered actions with nothing here to run, and why. */
  skipped: { id: string; detail: string }[];
}

/**
 * The four values each shortcut needs, resolved against this machine.
 *
 * The command comes from `firePlan` — the same decision the keys viewer
 * makes when Enter is pressed on a row — so a chord and the viewer can
 * never open two different things. Where that decision refuses (no
 * terminal emulator, herdr not installed) the shortcut is skipped and
 * said to be skipped: a keybinding pointing at a program that is not
 * there is a key somebody was told works.
 */
export function gnomeCustoms(fire: FireLookup): GnomeDesired {
  const customs: GnomeCustom[] = [];
  const skipped: { id: string; detail: string }[] = [];
  for (const binding of GNOME_BINDINGS) {
    const plan = fire(binding.id);
    if (!plan.ok) {
      skipped.push({ id: binding.id, detail: plan.detail });
      continue;
    }
    customs.push({
      path: binding.path,
      name: binding.name,
      command: commandLine(plan.argv),
      binding: binding.accel,
    });
  }
  return { customs, skipped };
}

function setCustom(path: string, key: string, value: string): string[] {
  return ["set", `${CUSTOM_SCHEMA}:${path}`, key, value];
}

/** A GVariant array of strings, which is what `as` keys have to be given. */
export function gvariantList(values: readonly string[]): string {
  // `[]` alone is ambiguous to the parser and rejected; the type has to
  // be spelled for the empty case.
  return values.length === 0 ? "@as []" : `[${values.map((v) => `'${v}'`).join(", ")}]`;
}

function sameCustom(a: GnomeCustom, b: GnomeCustom): boolean {
  return a.name === b.name
    && a.command === b.command
    && normalAccel(a.binding) === normalAccel(b.binding);
}

/**
 * What has to be written, and nothing that does not.
 *
 * The order is the whole safety of it. A path is inert until it is in
 * the list, so the values are written first and the list second — a
 * listed path with no command is a shortcut GNOME reads while it is half
 * written. Withdrawal runs the other way for the same reason: the entry
 * leaves the list, and only then are its values reset.
 *
 * A converge that changes nothing returns nothing. That is not a
 * micro-optimisation: every step here is a write to the person's own
 * dconf, and a converge that rewrites four keys per action per run is
 * one nobody can read the diff of.
 */
export function gnomePlan(state: GnomeState, desired: readonly GnomeCustom[]): GnomeStep[] {
  const steps: GnomeStep[] = [];
  const current = new Map(state.owned.map((c) => [c.path, c]));

  for (const want of desired) {
    const have = current.get(want.path);
    if (have && sameCustom(have, want)) continue;
    steps.push(
      { argv: setCustom(want.path, "name", want.name), note: "" },
      { argv: setCustom(want.path, "command", want.command), note: "" },
      { argv: setCustom(want.path, "binding", want.binding), note: `${want.binding} → ${want.command}` },
    );
  }

  // A person's entries keep their place and their order; red-dev's
  // follow, in registry order. Rebuilding the list from red-dev's half
  // alone is how somebody loses the shortcut they wrote last week.
  const theirs = state.list.filter((path) => !isOwned(path));
  const wanted = [...theirs, ...desired.map((d) => d.path)];
  if (wanted.length !== state.list.length || wanted.some((p, i) => p !== state.list[i])) {
    steps.push({
      argv: ["set", MEDIA_KEYS, "custom-keybindings", gvariantList(wanted)],
      note: `${desired.length} red-dev keybinding(s) listed, ${theirs.length} of your own kept`,
    });
  }

  const keeping = new Set(desired.map((d) => d.path));
  for (const path of state.list) {
    if (!isOwned(path) || keeping.has(path)) continue;
    steps.push({
      argv: ["reset-recursively", `${CUSTOM_SCHEMA}:${path}`],
      note: `withdrew ${path.slice(CUSTOM_ROOT.length).replace(/\/$/, "")}`,
    });
  }

  steps.push(...launchTerminalSteps(state, desired));
  return steps;
}

/**
 * GNOME's own Ctrl+Alt+T, while red-dev holds that key.
 *
 * Cleared rather than left beside ours: it opens whatever
 * `x-terminal-emulator` resolves to, red-dev's opens the terminal
 * red-dev installed, and which of two grabs on one accelerator wins is
 * not something to find out on somebody's machine. `reset` puts GNOME's
 * default back the moment red-dev stops claiming the key, so the
 * takeover is exactly as reversible as everything else here.
 */
function launchTerminalSteps(
  state: GnomeState,
  desired: readonly GnomeCustom[],
): GnomeStep[] {
  // Null means the key is not in this GNOME's schema, which is a machine
  // to leave alone rather than a failure to report.
  if (state.launchTerminal === null) return [];

  const ours = new Set(desired.map((d) => normalAccel(d.binding)));
  // Any collision, not only the stock one: a person may have moved
  // launch-terminal onto another key, and whichever key it sits on it
  // cannot be a key red-dev is also registering.
  const held = state.launchTerminal.some((accel) => ours.has(normalAccel(accel)));
  if (held) {
    return [{
      argv: ["set", MEDIA_KEYS, LAUNCH_TERMINAL, gvariantList([])],
      note: "GNOME's own launch-terminal binding cleared, so the chord has one owner",
    }];
  }

  // Restored only where red-dev is the one letting go: an empty
  // launch-terminal binding on a machine red-dev never took it from is
  // the person's own setting, and putting GNOME's default back over it
  // would be this adapter reaching outside what it owns. The evidence
  // that it was ours is the entry still in dconf, which withdrawal is
  // removing in this same plan.
  const wasOurs = state.launchTerminal.length === 0
    && !ours.has(STOCK_LAUNCH_TERMINAL)
    && state.owned.some((c) => normalAccel(c.binding) === STOCK_LAUNCH_TERMINAL);
  if (wasOurs) {
    return [{
      argv: ["reset", MEDIA_KEYS, LAUNCH_TERMINAL],
      note: "GNOME's own launch-terminal binding restored, because red-dev no longer claims that chord",
    }];
  }
  return [];
}

/** A gsettings call, or null when it failed or the key is not there. */
export type Gsettings = (argv: string[]) => Promise<string | null>;

async function spawnGsettings(argv: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gsettings", ...argv], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 ? out : null;
  } catch {
    // No gsettings on PATH at all. The caller reads null as "this
    // machine has no GNOME to register anything with".
    return null;
  }
}

/** The strings inside a GVariant `as`, unescaped. */
export function parseGvariantList(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
    out.push((match[1] ?? "").replace(/\\(.)/g, "$1"));
  }
  return out;
}

/** The contents of a GVariant `s`, unescaped. */
export function parseGvariantString(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return trimmed;
}

/** Read what this machine holds, or null where there is no GNOME to ask. */
export async function readGnomeState(run: Gsettings): Promise<GnomeState | null> {
  const listText = await run(["get", MEDIA_KEYS, "custom-keybindings"]);
  if (listText === null) return null;

  const list = parseGvariantList(listText);
  const owned: GnomeCustom[] = [];
  for (const path of list) {
    if (!isOwned(path)) continue;
    const schema = `${CUSTOM_SCHEMA}:${path}`;
    const [name, command, binding] = await Promise.all([
      run(["get", schema, "name"]),
      run(["get", schema, "command"]),
      run(["get", schema, "binding"]),
    ]);
    owned.push({
      path,
      name: parseGvariantString(name ?? ""),
      command: parseGvariantString(command ?? ""),
      binding: parseGvariantString(binding ?? ""),
    });
  }

  const terminal = await run(["get", MEDIA_KEYS, LAUNCH_TERMINAL]);
  return {
    list,
    owned,
    launchTerminal: terminal === null ? null : parseGvariantList(terminal),
  };
}

/**
 * Register them, or say why this machine gets none.
 *
 * `run` and `fire` are injected for the reason every other decision in
 * this project is: dconf and PATH are not answerable in a test, and what
 * is worth pinning is that a converge on a machine that already matches
 * writes nothing at all.
 */
export async function installGnomeKeys(
  p: Platform,
  run: Gsettings = spawnGsettings,
  fire?: FireLookup,
): Promise<void> {
  if (p.env !== "desktop") {
    log.skip("GNOME keybindings need a desktop session");
    return;
  }

  const state = await readGnomeState(run);
  if (!state) {
    log.skip("no GNOME settings here, so nothing can register a chord");
    return;
  }

  const lookup = fire ?? await defaultFire(p);
  const { customs, skipped } = gnomeCustoms(lookup);
  const steps = gnomePlan(state, customs);

  for (const step of steps) {
    const out = await run(step.argv);
    if (out === null) {
      // Named rather than swallowed: a key GNOME refused is a key
      // nothing will press, and a converge that reported success over it
      // is how the viewer comes to promise a chord the machine does not
      // have.
      log.warn(`gsettings refused \`${step.argv.join(" ")}\``);
      continue;
    }
    if (step.note) log.plain(`       ${step.note}`);
  }

  for (const miss of skipped) log.plain(`       (skipped) ${miss.id}: ${miss.detail}`);

  if (steps.length === 0) log.ok(`${customs.length} GNOME keybinding(s), already registered`);
  else log.ok(`${customs.length} GNOME keybinding(s)`);
}

/** The keys viewer's own plan, loaded only where it is about to be used. */
async function defaultFire(p: Platform): Promise<FireLookup> {
  // Imported here rather than at the top because src/keys.ts is a
  // consumer of this module — it reads GNOME_ACTIONS to answer whether a
  // row is bound — and two modules importing each other at load time is
  // a cycle nobody should have to reason about.
  const { firePlan } = await import("./keys.ts");
  return (id) => firePlan(id, p, (cmd) => Bun.which(cmd));
}
