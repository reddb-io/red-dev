/**
 * Claude Code keybindings convergence.
 *
 * Claude Code reads ~/.claude/keybindings.json for per-context bindings.
 * The file format is an object with a "bindings" array; each entry carries
 * a "context" string and a "bindings" map of key to action. A null action
 * unbinds a Claude Code default.
 *
 * Two bindings, both in the Chat context:
 *
 *   Shift+Enter -> chat:newline. Without it, every multi-line prompt has
 *   to be built somewhere else and pasted in.
 *
 *   Ctrl+G -> nothing. Claude Code binds it to chat:externalEditor by
 *   default, and config/zellij/config.kdl already spends Ctrl+G on the
 *   unlock. Two owners for one key means the key does different things
 *   depending on whether the shell happens to be inside zellij, which is
 *   exactly what the zellij table was arranged to avoid. zellij is the
 *   layer that cannot move — it has to catch the key before the pane
 *   sees it — so Claude Code yields, and chat:externalEditor stays
 *   reachable on its second default, Ctrl+X Ctrl+E.
 *
 * Three constraints shape this:
 *   - idempotent: re-running on a machine that already has it does nothing
 *   - non-destructive: unrelated top-level fields, contexts and bindings survive
 *   - conservative: malformed JSON and explicit conflicting bindings are
 *     never overwritten silently — a warning is emitted and the file is left alone
 */

import { existsSync } from "node:fs";
import { log } from "./log.ts";

const CONTEXT = "Chat";

/** A key red-dev owns in the Chat context. A null action unbinds it. */
type Managed = { key: string; action: string | null };

const MANAGED: readonly Managed[] = [
  { key: "shift+enter", action: "chat:newline" },
  { key: "ctrl+g", action: null },
];

/** How a managed binding reads in the file, for logs. */
function describe(b: Managed): string {
  return b.action === null ? `${b.key} unbound` : `${b.key} → ${b.action}`;
}

function defaultPath(): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  return `${home.replace(/\\/g, "/")}/.claude/keybindings.json`;
}

export type BindingOutcome = "wrote" | "already-set" | "conflict" | "malformed";

/** One outcome per managed key. Keys that share a file still differ here. */
export type ConvergeResult = Record<string, BindingOutcome>;

type BindingMap = Record<string, string | null>;
type BindingEntry = { context?: string; bindings?: BindingMap } & Record<string, unknown>;
type KeybindingFile = { bindings?: BindingEntry[] } & Record<string, unknown>;

/** The same verdict for every managed key — the file-level failures. */
function uniform(outcome: BindingOutcome): ConvergeResult {
  return Object.fromEntries(MANAGED.map((b) => [b.key, outcome]));
}

/** Every managed binding as Claude Code stores it. */
function managedMap(): BindingMap {
  return Object.fromEntries(MANAGED.map((b) => [b.key, b.action]));
}

function save(target: string, file: KeybindingFile): Promise<number> {
  return Bun.write(target, JSON.stringify(file, null, 2) + "\n");
}

/** What the file currently says, phrased for a warning. */
function render(action: string | null | undefined): string {
  return action === null ? "null" : `"${action}"`;
}

/**
 * Converge every binding in MANAGED into ~/.claude/keybindings.json.
 *
 * One read and at most one write, so a malformed file warns once rather
 * than once per key.
 *
 * Accepts an explicit path for tests; omit to use the real Claude config dir.
 */
export async function convergeClaudeKeybinding(path?: string): Promise<ConvergeResult> {
  const target = path ?? defaultPath();

  if (!existsSync(target)) {
    await save(target, { bindings: [{ context: CONTEXT, bindings: managedMap() }] });
    return uniform("wrote");
  }

  let raw: string;
  try {
    raw = await Bun.file(target).text();
  } catch {
    log.warn(`claude keybindings: cannot read ${target} — leaving it alone`);
    return uniform("malformed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn(`claude keybindings: ${target} is not valid JSON — leaving it alone`);
    return uniform("malformed");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    log.warn(`claude keybindings: ${target} has an unexpected root type — leaving it alone`);
    return uniform("malformed");
  }

  const obj = parsed as KeybindingFile;
  const bindings = obj.bindings;

  if (!Array.isArray(bindings)) {
    await save(target, {
      ...obj,
      bindings: [{ context: CONTEXT, bindings: managedMap() }],
    });
    return uniform("wrote");
  }

  const chatEntry = bindings.find(
    (b): b is BindingEntry => typeof b === "object" && b !== null && b.context === CONTEXT,
  );

  if (!chatEntry) {
    await save(target, {
      ...obj,
      bindings: [...bindings, { context: CONTEXT, bindings: managedMap() }],
    });
    return uniform("wrote");
  }

  // hasOwnProperty rather than a truthiness or undefined check: null is a
  // value Claude Code gives meaning to, and one this module writes.
  const current = chatEntry.bindings ?? {};
  const result: ConvergeResult = {};
  const additions: BindingMap = {};

  for (const b of MANAGED) {
    if (!Object.prototype.hasOwnProperty.call(current, b.key)) {
      additions[b.key] = b.action;
      result[b.key] = "wrote";
      continue;
    }
    if (current[b.key] === b.action) {
      result[b.key] = "already-set";
      continue;
    }
    log.warn(
      `claude keybindings: ${b.key} is already bound to ${render(current[b.key])} — leaving it alone`,
    );
    result[b.key] = "conflict";
  }

  if (Object.keys(additions).length > 0) {
    await save(target, {
      ...obj,
      bindings: bindings.map((b) =>
        b === chatEntry ? { ...b, bindings: { ...current, ...additions } } : b,
      ),
    });
  }

  return result;
}

/**
 * Convergence entry-point called from the builtin dispatcher.
 *
 * Skipped silently when Claude Code is not installed: the keybindings have
 * nowhere to go without the CLI.
 */
export async function convergeClaudeKeybindings(): Promise<void> {
  if (!Bun.which("claude")) {
    log.skip("claude keybindings: claude not installed");
    return;
  }

  const result = await convergeClaudeKeybinding();
  for (const b of MANAGED) {
    switch (result[b.key]) {
      case "wrote":
        log.ok(`claude keybindings: ${describe(b)}`);
        break;
      case "already-set":
        log.skip(`claude keybindings: ${describe(b)} already`);
        break;
      case "conflict":
      case "malformed":
        // Warning already emitted inside convergeClaudeKeybinding.
        break;
    }
  }
}
