/**
 * What makes a Redwall current: the daemon's own host hook, not a timer.
 *
 * `redwall.ts` composes one image and writes it down. Nothing in it
 * decides when that happens, and until now the answer was a two-minute
 * timer — a systemd unit on Linux and WSL, a scheduled task on Windows.
 * A timer is the wrong shape for this: the Worker count only moves when
 * a Worker is born or dies, so on an idle machine every tick was a
 * process spawned to learn that nothing had changed, and on a busy one
 * the desktop was wrong for up to two minutes at a time.
 *
 * RedSkills ADR 0140 published the contract that replaces it. This module
 * is red-dev's whole side of that contract: it declares the hook, it
 * withdraws it, it takes the old timer away, and it decides — when the
 * daemon fires red-dev — whether this particular event is one red-dev
 * asked for.
 *
 * ## The mechanism, and the grounds
 *
 * ADR 0140 leaves a consumer two ways to hear about a change, and this
 * slice takes **the registered host hook**. Not the lane watcher, and
 * never both — two mechanisms repainting one image is worse than either,
 * because the second one is the copy nobody remembers exists.
 *
 * The grounds are the WSL boundary, which is decision 6 of that ADR:
 * *the lane is watchable only from the side that writes it*. File-change
 * notification does not cross into native Windows, so a Windows-side
 * Redwall watching a distro's `redskilled.log.toonl` would receive
 * nothing, forever, with no error. red-dev spans that boundary on every
 * WSL machine it sets up. A hook inverts the direction: the daemon does
 * the firing, on the side that writes the lane, and a WSL-side red-dev
 * reaches the Windows desktop through interop the same way it already
 * resolves an address and repaints a wallpaper. Nothing has to watch
 * across the boundary because nothing has to watch at all.
 *
 * The second ground is cost. A lane watcher is a process red-dev would
 * have to keep alive — which means a supervisor, which is the timer's
 * problem again with a longer-lived process at the end of it. The hook
 * costs nothing while the machine is idle, because an idle machine
 * births nothing.
 *
 * ## Where the declaration lives, and why not the registration
 *
 * ADR 0140 Amendment 1 scopes a hook to the project that registered it,
 * and Amendment 2 adds the ownership case this consumer actually is:
 * machine policy under `plugins.dev.redskilled.hooks.<kind>` in the
 * operator's `~/.red/config.yaml`, fired as an admitted, budgeted,
 * refusable Worker owned by the synthetic project
 * `redskilled/host-events`.
 *
 * red-dev takes that one, because a project registration is a lease. It
 * carries a five-minute TTL and is kept alive by a live MCP session
 * renewing at its half-life — and red-dev has no session. It is a
 * provisioning command somebody types, or a converge that runs and
 * exits. A registration made by `red-dev install` would lapse five
 * minutes later and the desktop would go back to showing whatever it
 * showed then, which is precisely the frozen wallpaper this whole
 * feature exists to prevent. Machine policy is re-read on every daemon
 * start and survives restart, which is the lifetime a desktop has.
 *
 * The three properties Amendment 1 demands of a hook are all still
 * present: an owner, a budget, and a refusal path. It is the *lease*
 * that red-dev cannot hold, not the accountability.
 *
 * ## What red-dev declares, and what it deliberately does not read
 *
 * Three kinds — `worker-birth`, `worker-death`, `worker-budget-kill` —
 * each keyed to one launch template, and each template is the same argv:
 * `red-dev redwall`. No `{{…}}` placeholder appears in it. The daemon
 * refuses a placeholder it does not recognise rather than starting, and
 * a Redwall needs none of the four facts a birth supplies: it draws the
 * machine, not the Worker.
 *
 * The daemon hands the hook the full `host-state` document on stdin.
 * red-dev does not draw from it. ADR 0140 decision 4 says a consumer
 * that wants the whole picture asks `host-state` *after* the event, and
 * that is what `redwall.ts` already does — so the record is read here
 * for exactly one purpose, which is to say out loud when it is a version
 * this build does not understand. An unreadable payload never withholds
 * a repaint; it only explains why the daemon may be drawn as
 * unavailable.
 *
 * ## Doing nothing, successfully
 *
 * A server has no screen, so there is nothing to keep current. That is
 * the only skip left. The old timer also skipped a WSL distro without
 * `systemd=true`, because there was no user manager to hold a unit — the
 * hook needs no supervisor of its own, so those machines get a live
 * Redwall for the first time.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import {
  runBounded,
  type BoundedCommandOptions,
  type BoundedCommandResult,
} from "./bounded-command.ts";
import { parseHostState } from "./host-state.ts";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import { resolveRedwall } from "./preferences.ts";

/**
 * The public host event kinds red-dev declares, and the whole of them.
 *
 * ADR 0140 decision 3 publishes exactly these three and keeps the rest
 * of the lane internal. Declaring the whole vocabulary is not an option
 * a consumer has: the daemon refuses an unknown kind at read time, and
 * the kinds it does not publish are free to change under anybody.
 */
export const REDWALL_HOOK_KINDS = ["worker-birth", "worker-death", "worker-budget-kill"] as const;

export type RedwallHookKind = (typeof REDWALL_HOOK_KINDS)[number];

/** The variable the daemon sets on the Worker it births for a host event. */
export const HOST_EVENT_ENV = "REDSKILLED_HOST_EVENT";

/** The operator's machine policy, relative to a home directory. */
export const HOST_CONFIG_RELATIVE = ".red/config.yaml";

/**
 * The two comment lines that fence red-dev's block.
 *
 * A managed region rather than a parse-and-rewrite of the whole file.
 * `~/.red/config.yaml` is the operator's: it carries their host ceilings
 * and their GitHub App, and on the machines that have one it is heavily
 * commented. Round-tripping YAML through a parser would return a
 * semantically identical document with every comment and every choice of
 * layout gone, which is a rude way to add four lines. So red-dev edits
 * only between its own markers and copies every other byte.
 */
const MARK_OPEN = "# red-dev:redwall-hook — managed; rewritten on converge, removed on uninstall";
const MARK_CLOSE = "# red-dev:redwall-hook end";

/** The units the two-minute timer used to install. Removed, never written. */
const LEGACY_SERVICE = "red-dev-redwall.service";
const LEGACY_TIMER = "red-dev-redwall.timer";
const LEGACY_TASK = "red-dev-redwall";
const LEGACY_TASK_WRAPPER = "red-dev-redwall.vbs";

/** Why nothing was declared, when nothing was. */
export type RedwallHookSkip =
  /** No desktop here, so nothing would ever display the result. */
  | "headless"
  /** A target red-dev draws no Redwall for. */
  | "unsupported";

/**
 * The topology ADR 0140 decision 6 says cannot be served, when this is
 * one.
 *
 * Exactly one value, because there is exactly one such topology and it
 * is red-dev's own: a native-Windows Redwall drawing Workers that live
 * inside WSL distros. `redwallState` merges every running distro's
 * `host-state` into the Windows image on purpose, so the count on that
 * desktop is mostly produced by daemons on the other side of a boundary
 * that carries no change notification and whose hooks exec inside the
 * distro. The Windows-side declaration still covers a Windows-side
 * daemon; the distros are the half that cannot reach here.
 */
export type RedwallHookBoundary = "wsl-unwatchable";

export type RedwallHookAction =
  /** The declaration was written or repaired. */
  | "declared"
  /** It was already exactly this, down to the bytes of the block. */
  | "unchanged"
  /** The preference is off and a declaration was here, so it went. */
  | "withdrawn"
  /** Nothing to declare and nothing to remove. */
  | "absent"
  /** Something else owns the key, so red-dev kept its hands off. */
  | "refused";

export interface RedwallHookOutcome {
  readonly action: RedwallHookAction;
  /** Null when this machine could hold a declaration at all. */
  readonly skipped: RedwallHookSkip | null;
  /** Non-null when this machine spans a boundary the contract cannot cross. */
  readonly boundary: RedwallHookBoundary | null;
  /** The policy file this run read and possibly wrote. */
  readonly path: string | null;
  /** Paths this run took away — the old schedule, and the file when it emptied. */
  readonly removed: string[];
  /** Why `refused`, in the words a person would need. */
  readonly refusal: string | null;
}

/**
 * The seams a test replaces.
 *
 * Every default here reaches the operator's own machine — their
 * `~/.red/config.yaml`, `systemctl --user`, `schtasks` — so a suite that
 * let them run would rewrite the policy of whoever typed `bun test`.
 */
export interface RedwallHookSeams {
  /** How host commands run. Defaults to the bounded runner. */
  readonly run?: (
    argv: string[],
    options?: BoundedCommandOptions,
  ) => Promise<BoundedCommandResult>;
  /** The operator's machine policy. Defaults to ~/.red/config.yaml. */
  readonly configPath?: string;
  /** Where the retired user units live. Defaults to ~/.config/systemd/user. */
  readonly unitDir?: string;
  /** The binary the hook invokes. Defaults to where red-dev installs itself. */
  readonly binary?: string;
  /** The retired Windows wrapper. Defaults to beside the binary. */
  readonly wrapper?: string;
  /** The hidden-window host on Windows. Defaults to installing the shared runner. */
  readonly runner?: () => Promise<string | null>;
  /** Whether the preference is on. Defaults to the recorded preference. */
  readonly enabled?: () => Promise<boolean>;
}

function home(): string {
  return (process.env["HOME"] ?? process.env["USERPROFILE"] ?? homedir()).replace(/\\/g, "/");
}

/**
 * The one file the daemon reads machine policy from.
 *
 * Rooted at the home of whoever runs the daemon, never at a checkout —
 * which on WSL is the distro's home, because that is where the distro's
 * daemon lives and the lane it writes.
 */
export function redskilledHostConfigPath(): string {
  return `${home()}/${HOST_CONFIG_RELATIVE}`;
}

/** Where the retired timer's units were left. */
export function legacyUnitDir(): string {
  return `${home()}/.config/systemd/user`;
}

/**
 * The binary the declaration has to name.
 *
 * The daemon execs this with none of red-dev's environment, so "red-dev"
 * on its own is not an answer: the directory red-dev installs itself
 * into is on the PATH red-dev builds for an interactive shell, and a
 * daemon does not read it. So it is absolute — and *which* absolute
 * path is the whole question.
 *
 * ## Why not the bootstrap directory
 *
 * It used to be `~/.local/bin/red-dev`, which is where boot.sh writes.
 * ADR 0008 then put red-dev under mise, and boot's copy stopped being
 * updated by anything: `mise upgrade red-dev` moves mise's, and nothing
 * moves the other. A machine that had run both ended up with a systemd
 * unit and a daemon hook pinned to whichever version boot.sh happened
 * to leave behind.
 *
 * Measured on the maintainer's workstation, hours after red-dev learned
 * to update itself: the shell resolved 1.0.101, the ten-minute timer's
 * `ExecStart` named 1.0.100, and so the self-updater — shipped in
 * 1.0.101 — was never once executed. It could not have been. The only
 * process that runs on a schedule was pinned, by this function, to a
 * copy from before it existed.
 *
 * ## `latest`, not a version
 *
 * mise keeps a `latest` selector beside its installs and moves it on
 * every upgrade, so a path through it is correct today and stays
 * correct. A versioned path would be this same bug with a shorter
 * fuse. `miseToolBin` prefers `latest` already.
 *
 * Order: `RED_DEV_BIN_DIR` when the operator set one — their machine,
 * their answer — then mise's copy, then boot's, which is all a machine
 * that has never seen mise has.
 */
export async function redwallBinary(p: Platform): Promise<string> {
  const override = process.env["RED_DEV_BIN_DIR"];
  if (override) {
    return p.os === "windows" ? `${override}\\red-dev.exe` : `${override}/red-dev`;
  }

  const { miseToolBin } = await import("./mise-config.ts");
  const managed = miseToolBin("red-dev");
  if (managed !== null) return managed;

  if (p.os === "windows") {
    // Lazily, so a Linux target never loads the module that knows about
    // LOCALAPPDATA in order to write a YAML block.
    const { windowsBinDir } = await import("./providers.ts");
    return `${windowsBinDir()}\\red-dev.exe`;
  }
  return `${home()}/.local/bin/red-dev`;
}

/**
 * Whether this machine can hold a declaration at all. PURE.
 *
 * A server is "headless" here for the reason `generateRedwall` skips one:
 * nothing on it will ever display the image, so a hook that regenerates
 * one on every birth is a process factory with no reader. Note what is
 * *not* here: the old timer also skipped a WSL distro with no systemd,
 * because a user unit needs a user manager. A hook needs nothing of the
 * sort — the daemon is the supervisor — so those machines are served now.
 */
export function redwallHookSkip(p: Platform): RedwallHookSkip | null {
  if (p.env === "server") return "headless";
  if (p.os !== "linux" && p.os !== "windows") return "unsupported";
  return null;
}

/**
 * Whether this machine is the topology decision 6 refuses to serve. PURE.
 *
 * Structural rather than probed. A native-Windows red-dev always merges
 * every running distro's `host-state` into its Redwall — see
 * `redwallState` — so the boundary is crossed by construction on that
 * target, and a machine with no distro loses nothing by being told about
 * a limit it never reaches.
 */
export function redwallHookBoundary(p: Platform): RedwallHookBoundary | null {
  return p.os === "windows" ? "wsl-unwatchable" : null;
}

/**
 * The argv the daemon is asked to run. PURE.
 *
 * Two words on every target that can take them. On Windows it goes
 * through `wscript.exe` and the shared hidden runner instead, for the
 * reason `windows-hidden.ts` exists: red-dev.exe is a console program,
 * and a console program started by a process that has no console of its
 * own gets a fresh one allocated — a black rectangle on the desktop,
 * now once per Worker rather than once every two minutes. A machine that
 * cannot produce the runner falls back to the plain argv, because a
 * Redwall that repaints with a flash beats one that never repaints.
 */
export function redwallHookArgv(
  p: Platform,
  binary: string,
  runner: string | null,
): string[] {
  if (p.os === "windows" && runner !== null) {
    // The runner takes one argument, and that argument is a command
    // line: quoted, because a profile path can contain a space and
    // unquoted C:\Users\First Last\... starts C:\Users\First.
    return ["wscript.exe", "//B", "//Nologo", runner, `"${binary}" redwall`];
  }
  return [binary, "redwall"];
}

/**
 * The exact lines red-dev owns inside the policy file. PURE.
 *
 * Exported because it is the contract with the daemon, and the only way
 * to assert what red-dev asks it to do without a daemon to ask.
 */
export function redwallHookBlock(argv: readonly string[], indent: number): string[] {
  const pad = " ".repeat(indent);
  // Flow style, and JSON-quoted. A double-quoted YAML scalar takes the
  // same escapes JSON does, which is what makes a Windows path with its
  // backslashes survive being written by `JSON.stringify` and read by a
  // YAML parser.
  const argvLine = `argv: [${argv.map((word) => JSON.stringify(word)).join(", ")}]`;
  return [
    `${pad}${MARK_OPEN}`,
    `${pad}hooks:`,
    ...REDWALL_HOOK_KINDS.flatMap((kind) => [`${pad}  ${kind}:`, `${pad}    ${argvLine}`]),
    `${pad}${MARK_CLOSE}`,
  ];
}

export interface RedwallHookEdit {
  readonly document: string;
  readonly action: "declared" | "unchanged" | "refused";
  readonly refusal: string | null;
}

/** The YAML path red-dev's block hangs from, outermost first. */
const HOOK_PATH = ["plugins", "dev", "redskilled"] as const;

function split(document: string): string[] {
  if (document === "") return [];
  return document.replace(/\n$/, "").split("\n");
}

function join(lines: readonly string[]): string {
  return lines.every((line) => line.trim() === "") ? "" : `${lines.join("\n")}\n`;
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

interface YamlKey {
  readonly indent: number;
  readonly key: string;
  readonly inline: string;
}

/** One block-mapping key line, or null for anything else. PURE. */
function keyAt(line: string): YamlKey | null {
  const match = /^( *)([A-Za-z0-9_.\-]+):(.*)$/.exec(line);
  if (match === null) return null;
  return { indent: match[1]!.length, key: match[2]!, inline: match[3]! };
}

/** The half-open line range holding the children of the key at `index`. PURE. */
function childRange(lines: readonly string[], index: number): [number, number] {
  const parent = keyAt(lines[index]!)!.indent;
  let end = index + 1;
  for (let at = index + 1; at < lines.length; at++) {
    const line = lines[at]!;
    if (isBlankOrComment(line)) continue;
    if (indentOf(line) <= parent) return [index + 1, end];
    end = at + 1;
  }
  return [index + 1, end];
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The indent this mapping's children sit at. PURE.
 *
 * Taken from the children that are already there rather than assumed,
 * because a file indented four spaces is as valid as one indented two
 * and a block that disagreed with its siblings would be a block a person
 * reads as broken.
 */
function childIndent(lines: readonly string[], range: readonly [number, number], parent: number): number {
  let found: number | null = null;
  for (let at = range[0]; at < range[1]; at++) {
    const line = lines[at]!;
    if (isBlankOrComment(line)) continue;
    const indent = indentOf(line);
    if (indent > parent && (found === null || indent < found)) found = indent;
  }
  return found ?? parent + 2;
}

/** The line index of `key` at exactly `indent` inside `range`, or null. PURE. */
function findChild(
  lines: readonly string[],
  range: readonly [number, number],
  key: string,
  indent: number,
): number | null {
  for (let at = range[0]; at < range[1]; at++) {
    const found = keyAt(lines[at]!);
    if (found !== null && found.indent === indent && found.key === key) return at;
  }
  return null;
}

interface Walk {
  /** How many of HOOK_PATH were found. */
  readonly depth: number;
  /** The children of the deepest key found, or the whole document. */
  readonly range: [number, number];
  /** The indent that key sits at; -2 for the document itself. */
  readonly indent: number;
  /** The line index of the deepest key found, or null at the document. */
  readonly at: number | null;
  /** Set when a key on the path carries an inline value nothing can merge into. */
  readonly blocked: string | null;
}

/** Follow `plugins → dev → redskilled` as far as the document goes. PURE. */
function walkHookPath(lines: readonly string[]): Walk {
  let range: [number, number] = [0, lines.length];
  let indent = -2;
  let at: number | null = null;
  for (let depth = 0; depth < HOOK_PATH.length; depth++) {
    const level = childIndent(lines, range, indent);
    const found = findChild(lines, range, HOOK_PATH[depth]!, level);
    if (found === null) return { depth, range, indent, at, blocked: null };
    if (keyAt(lines[found]!)!.inline.trim() !== "") {
      return {
        depth,
        range,
        indent,
        at,
        blocked: HOOK_PATH.slice(0, depth + 1).join("."),
      };
    }
    at = found;
    range = childRange(lines, found);
    indent = level;
  }
  return { depth: HOOK_PATH.length, range, indent, at, blocked: null };
}

/** The inclusive line range red-dev's markers fence, or null. PURE. */
function managedRegion(
  lines: readonly string[],
): { start: number; end: number; indent: number } | null {
  const start = lines.findIndex((line) => line.trim() === MARK_OPEN);
  if (start === -1) return null;
  for (let at = start + 1; at < lines.length; at++) {
    if (lines[at]!.trim() === MARK_CLOSE) {
      return { start, end: at, indent: indentOf(lines[start]!) };
    }
  }
  // An opening marker with no close is a file somebody edited by hand
  // mid-block. Treated as the whole of the rest, which is the reading
  // that leaves no orphaned half behind.
  return { start, end: lines.length - 1, indent: indentOf(lines[start]!) };
}

/**
 * Put red-dev's hook block into an operator's policy document. PURE.
 *
 * Every byte outside the markers is copied. Missing ancestors are
 * created; an existing `hooks:` that red-dev did not write is refused
 * rather than replaced, because the operator declaring their own sink
 * for the same three kinds is a decision and not a conflict to resolve
 * in their favour by force.
 */
export function declareRedwallHook(document: string, argv: readonly string[]): RedwallHookEdit {
  const lines = split(document);

  const region = managedRegion(lines);
  if (region !== null) {
    const block = redwallHookBlock(argv, region.indent);
    const current = lines.slice(region.start, region.end + 1);
    if (current.length === block.length && current.every((line, at) => line === block[at])) {
      return { document, action: "unchanged", refusal: null };
    }
    return {
      document: join([...lines.slice(0, region.start), ...block, ...lines.slice(region.end + 1)]),
      action: "declared",
      refusal: null,
    };
  }

  const walk = walkHookPath(lines);
  if (walk.blocked !== null) {
    return {
      document,
      action: "refused",
      refusal: `${walk.blocked} carries a value of its own, so red-dev cannot add its hook under it`,
    };
  }

  const level = childIndent(lines, walk.range, walk.indent);
  if (walk.depth === HOOK_PATH.length) {
    if (findChild(lines, walk.range, "hooks", level) !== null) {
      return {
        document,
        action: "refused",
        refusal: "plugins.dev.redskilled.hooks is declared by hand, so red-dev left it alone",
      };
    }
    const block = redwallHookBlock(argv, level);
    return {
      document: join([...lines.slice(0, walk.range[0]), ...block, ...lines.slice(walk.range[0])]),
      action: "declared",
      refusal: null,
    };
  }

  // The ancestors that are missing, plus the block beneath them.
  const chain = HOOK_PATH.slice(walk.depth).map(
    (key, step) => `${" ".repeat(level + step * 2)}${key}:`,
  );
  const block = redwallHookBlock(argv, level + chain.length * 2);
  // Appended at the end when nothing on the path exists at all, so a
  // file that opens with the operator's own header does not acquire a
  // red-dev key above it. Inserted at the head of a parent's children
  // otherwise, which is the only place a child may go.
  const insert = walk.depth === 0 ? lines.length : walk.range[0];
  return {
    document: join([...lines.slice(0, insert), ...chain, ...block, ...lines.slice(insert)]),
    action: "declared",
    refusal: null,
  };
}

/**
 * Take red-dev's block back out, and the chain it created with it. PURE.
 *
 * The ancestors are pruned only when nothing else is left under them:
 * an operator who set a worker ceiling under the same `redskilled:` key
 * keeps their key, and a file red-dev created entirely for this becomes
 * empty, which is how the caller knows to remove it.
 */
export function withdrawRedwallHook(document: string): { document: string; removed: boolean } {
  const lines = split(document);
  const region = managedRegion(lines);
  if (region === null) return { document, removed: false };

  let next = [...lines.slice(0, region.start), ...lines.slice(region.end + 1)];
  // Deepest first: pruning `redskilled` is what can leave `dev` empty.
  for (let depth = HOOK_PATH.length; depth > 0; depth--) {
    const walk = walkHookPath(next);
    if (walk.depth !== depth || walk.at === null) continue;
    const range = childRange(next, walk.at);
    if (next.slice(range[0], range[1]).some((line) => !isBlankOrComment(line))) break;
    next = [...next.slice(0, walk.at), ...next.slice(range[1])];
  }
  return { document: join(next), removed: true };
}

/** What the record on stdin turned out to be. */
export type RedwallHookPayload =
  /** A host-state document of the version this build reads. */
  | "understood"
  /** A document, but not one this build can read. Repainted anyway. */
  | "unrecognised"
  /** Nothing arrived, which is the ordinary case behind the hidden runner. */
  | "absent";

/**
 * Classify the record without ever depending on it. PURE.
 *
 * ADR 0140 decision 4: a consumer that wants the whole picture asks
 * `host-state` after the event. `redwall.ts` does exactly that, so this
 * answer changes nothing about what gets drawn — it is here so that a
 * daemon speaking a version this build does not read is a line somebody
 * can act on rather than a Redwall that quietly says the daemon is gone.
 */
export function classifyHookPayload(text: string | null | undefined): RedwallHookPayload {
  if (text == null || text.trim() === "") return "absent";
  return parseHostState(text) === null ? "unrecognised" : "understood";
}

/** Why this invocation of `red-dev redwall` did or did not repaint. */
export type RedwallHookReason =
  /** No host event named: a person, or `red-dev theme`. Always repaints. */
  | "direct"
  /** One of the three kinds red-dev declared. */
  | "declared-kind"
  /** A kind red-dev never asked for. Repaints nothing. */
  | "foreign-kind";

/** Which of the three this invocation is. PURE. */
export function redwallHookReason(env: NodeJS.ProcessEnv = process.env): RedwallHookReason {
  const kind = env[HOST_EVENT_ENV]?.trim();
  if (kind === undefined || kind === "") return "direct";
  return (REDWALL_HOOK_KINDS as readonly string[]).includes(kind) ? "declared-kind" : "foreign-kind";
}

export interface RedwallHookRun<T> {
  readonly reason: RedwallHookReason;
  /** The kind the daemon named, or null when nothing did. */
  readonly kind: string | null;
  readonly payload: RedwallHookPayload;
  /** Exactly once per declared event, and never for anything else. */
  readonly regenerated: boolean;
  /** What the regeneration answered, or null when none ran. */
  readonly result: T | null;
}

export interface RedwallHookRunSeams {
  readonly env?: NodeJS.ProcessEnv;
  readonly payload?: () => Promise<string | null>;
}

/**
 * Run one repaint for one event, or decline it.
 *
 * The whole of the "exactly once" claim lives here, and it is small on
 * purpose: one event is one process, one process reaches this once, and
 * this calls `regenerate` once. There is no queue to coalesce and no
 * second mechanism to agree with.
 *
 * A kind red-dev did not declare cannot normally arrive — the daemon
 * fires only what the policy names — but "cannot normally arrive" is not
 * a thing to leave unchecked in a file an operator edits by hand, and a
 * repaint on every `worker-metrics` sample would be a 4K compose on a
 * cadence nobody chose.
 */
export async function runRedwallHook<T>(
  regenerate: () => Promise<T>,
  seams: RedwallHookRunSeams = {},
): Promise<RedwallHookRun<T>> {
  const env = seams.env ?? process.env;
  const named = env[HOST_EVENT_ENV]?.trim();
  const kind = named === undefined || named === "" ? null : named;
  const reason = redwallHookReason(env);
  if (reason === "foreign-kind") {
    return { reason, kind, payload: "absent", regenerated: false, result: null };
  }

  // Only when the daemon fired us. Stdin belongs to whoever is at the
  // terminal otherwise, and reading it would hang `red-dev redwall`
  // typed by hand.
  const payload = reason === "declared-kind"
    ? classifyHookPayload(await (seams.payload ?? readHookPayload)())
    : "absent";
  return { reason, kind, payload, regenerated: true, result: await regenerate() };
}

/**
 * The record the daemon wrote, bounded.
 *
 * Bounded because the payload is worth a diagnostic and nothing more: a
 * writer that opened the pipe and went quiet must cost a repaint a
 * couple of seconds, never the repaint itself.
 */
async function readHookPayload(): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timed = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 2_000);
    });
    return await Promise.race([Bun.stdin.text(), timed]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function runner(
  seams: RedwallHookSeams,
): (argv: string[], options?: BoundedCommandOptions) => Promise<BoundedCommandResult> {
  return seams.run ?? runBounded;
}

/**
 * Bring this machine's declaration in line with the preference.
 *
 * Never throws for a machine that cannot hold one, and never for a
 * preference that is off: both are ordinary answers, and a converge step
 * that failed because somebody had not enabled an optional wallpaper
 * feature would turn an entirely healthy machine red.
 */
export async function applyRedwallHook(
  p: Platform,
  seams: RedwallHookSeams = {},
): Promise<RedwallHookOutcome> {
  const skip = redwallHookSkip(p);
  if (skip !== null) {
    reportSkip(p, skip);
    return absent(skip, []);
  }

  // Before anything else, and whatever the preference says. The timer
  // and the hook repaint the same image, and a machine upgrading into
  // this version has the timer already enabled — leaving it would mean
  // two mechanisms racing on one desktop, which is the thing the ADR
  // and this slice both refuse.
  const removed = await removeLegacyRedwallSchedule(p, seams);

  const path = seams.configPath ?? redskilledHostConfigPath();
  const document = existsSync(path) ? await Bun.file(path).text().catch(() => "") : "";
  const wanted = await (seams.enabled ?? (() => resolveRedwall(p)))();

  if (!wanted) {
    const edit = withdrawRedwallHook(document);
    if (!edit.removed) return absent(null, removed);
    removed.push(...(await writePolicy(path, edit.document)));
    log.ok("redwall hook: withdrawn — the preference is off");
    return { action: "withdrawn", skipped: null, boundary: null, path, removed, refusal: null };
  }

  const binary = seams.binary ?? (await redwallBinary(p));
  const hidden = p.os === "windows"
    ? await (seams.runner ?? (() => hiddenRunnerPath(p)))()
    : null;
  const edit = declareRedwallHook(document, redwallHookArgv(p, binary, hidden));
  if (edit.action === "refused") {
    log.warn(`redwall hook: ${edit.refusal}`);
    log.plain("       remove that block to have red-dev keep the Redwall current");
    return {
      action: "refused",
      skipped: null,
      boundary: null,
      path,
      removed,
      refusal: edit.refusal,
    };
  }

  if (edit.action === "declared") {
    mkdirSync(parentOf(path), { recursive: true });
    await Bun.write(path, edit.document);
    // Said out loud, because it is not true yet: Amendment 2 has the
    // daemon read machine policy at start, so a daemon already running
    // is holding the declaration it booted with.
    log.ok("redwall hook: declared — it takes effect when redskilled next starts");
  }

  const boundary = redwallHookBoundary(p);
  if (boundary !== null) reportBoundary();
  return { action: edit.action, skipped: null, boundary, path, removed, refusal: null };
}

/**
 * Take the declaration away, whatever the preference says.
 *
 * Uninstall's half. Separate from the branch inside `applyRedwallHook`
 * only in that it never consults the preference: a machine being
 * uninstalled keeps its answer to "did you want a Redwall" so that
 * reinstalling restores it, and a declaration left behind would then
 * have the daemon exec a path with no binary at it on every birth.
 */
export async function removeRedwallHook(
  p: Platform,
  seams: RedwallHookSeams = {},
): Promise<RedwallHookOutcome> {
  const skip = redwallHookSkip(p);
  // Silently, unlike the converge path: an uninstall that could not have
  // declared a hook has nothing to report about one.
  if (skip !== null) return absent(skip, []);

  const removed = await removeLegacyRedwallSchedule(p, seams);
  const path = seams.configPath ?? redskilledHostConfigPath();
  const document = existsSync(path) ? await Bun.file(path).text().catch(() => "") : "";
  const edit = withdrawRedwallHook(document);
  if (!edit.removed) return absent(null, removed);

  removed.push(...(await writePolicy(path, edit.document)));
  return { action: "withdrawn", skipped: null, boundary: null, path, removed, refusal: null };
}

/**
 * Write the policy back, or take the file away when nothing is left in
 * it.
 *
 * A file red-dev created for one block and then emptied is a file
 * nothing on the machine would explain. An operator's own file never
 * empties, because their keys are still in it.
 */
async function writePolicy(path: string, document: string): Promise<string[]> {
  if (document.trim() === "") {
    rmSync(path, { force: true });
    return [path];
  }
  await Bun.write(path, document);
  return [];
}

/**
 * Remove the two-minute schedule this hook replaces.
 *
 * Both halves are keyed on a file that is free to look for, because the
 * version that installed either wrote both: a systemd machine has the
 * units on disk, and a Windows machine has the wrapper beside the
 * binary. That keeps this from spawning `systemctl` or `schtasks` on
 * every converge of every machine, forever, to learn that a retired
 * feature is still retired.
 *
 * On WSL only the distro's own units are taken. A native Windows task
 * belongs to the native Windows red-dev and is removed by its converge —
 * reaching across to delete a scheduled task this side does not own is
 * how one install breaks another.
 */
export async function removeLegacyRedwallSchedule(
  p: Platform,
  seams: RedwallHookSeams = {},
): Promise<string[]> {
  return p.os === "windows"
    ? await removeLegacyTask(p, seams)
    : await removeLegacyUnits(seams);
}

async function removeLegacyUnits(seams: RedwallHookSeams): Promise<string[]> {
  const dir = seams.unitDir ?? legacyUnitDir();
  const present = [`${dir}/${LEGACY_TIMER}`, `${dir}/${LEGACY_SERVICE}`].filter((path) =>
    existsSync(path)
  );
  if (present.length === 0) return [];

  const run = runner(seams);
  // Before the files go: disabling a unit whose file has already been
  // deleted leaves the symlink in `timers.target.wants` behind, and
  // systemd then complains about it on every reload for good.
  await run(["systemctl", "--user", "disable", "--now", LEGACY_TIMER], { timeoutMs: 15_000 });
  for (const path of present) rmSync(path, { force: true });
  await run(["systemctl", "--user", "daemon-reload"], { timeoutMs: 10_000 });
  log.ok("redwall: the two-minute timer is gone — the daemon's hook repaints now");
  return present;
}

async function removeLegacyTask(p: Platform, seams: RedwallHookSeams): Promise<string[]> {
  const wrapper = seams.wrapper ?? legacyWrapperPath(seams.binary ?? (await redwallBinary(p)));
  if (!existsSync(wrapper)) return [];

  const run = runner(seams);
  const removed: string[] = [];
  const existing = await run(["schtasks", "/Query", "/TN", LEGACY_TASK], { timeoutMs: 15_000 });
  if (existing.exitCode === 0) {
    await run(["schtasks", "/Delete", "/TN", LEGACY_TASK, "/F"], { timeoutMs: 15_000 });
    removed.push(LEGACY_TASK);
  }
  // After the task, not before: a wrapper deleted while a task still
  // names it is a task that fails every two minutes until somebody looks.
  rmSync(wrapper, { force: true });
  removed.push(wrapper);
  log.ok("redwall: the two-minute task is gone — the daemon's hook repaints now");
  return removed;
}

/** Where the retired Windows wrapper sat: beside the binary it named. PURE. */
export function legacyWrapperPath(binary: string): string {
  const separator = binary.includes("\\") ? "\\" : "/";
  return `${parentOf(binary)}${separator}${LEGACY_TASK_WRAPPER}`;
}

/**
 * The directory part of a path spelled either way. PURE.
 *
 * Not `node:path`'s: that one is posix or win32 according to the machine
 * running it, and this module reasons about Windows paths from a test
 * suite that runs on Linux.
 */
function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut === -1 ? "." : path.slice(0, cut);
}

/**
 * The hidden runner, installed if it is not there. Exported because the
 * RedSkills watch crosses the same boundary for the same reason: a
 * console program launched from a process with no console of its own
 * draws a black rectangle on the desktop.
 */
export async function hiddenRunnerPath(p: Platform): Promise<string | null> {
  try {
    const { imageRoot } = await import("./wallpaper.ts");
    const { installHiddenRunner } = await import("./windows-hidden.ts");
    return await installHiddenRunner(await imageRoot(p), p);
  } catch {
    return null;
  }
}

function absent(skip: RedwallHookSkip | null, removed: string[]): RedwallHookOutcome {
  return { action: "absent", skipped: skip, boundary: null, path: null, removed, refusal: null };
}

function reportSkip(p: Platform, skip: RedwallHookSkip): void {
  if (skip === "headless") {
    log.skip("redwall hook: no desktop on this machine");
    return;
  }
  log.skip(`redwall hook: red-dev draws no Redwall on ${p.os}`);
}

/**
 * Say the one thing the contract cannot do, rather than let it be found
 * as silence.
 *
 * ADR 0140 decision 6 in the operator's own words: a Redwall drawn on
 * native Windows counts Workers that live inside WSL distros, and no
 * mechanism carries a distro's events out to here — not the lane, whose
 * change notification does not cross, and not the distro daemon's hook,
 * which execs inside the distro. The remedy is the one red-dev already
 * ships: the distro's own red-dev repaints this desktop through interop.
 */
function reportBoundary(): void {
  log.warn(
    "redwall hook: a WSL daemon's Worker events cannot reach a native-Windows Redwall " +
      "(RedSkills ADR 0140 decision 6), so this declaration covers a Windows-side daemon only",
  );
  log.plain(
    "       run `red-dev install core` inside the distro: its daemon fires the hook there, " +
      "and that red-dev repaints this desktop through interop",
  );
}
