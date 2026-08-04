/**
 * Claude Code keybindings convergence.
 *
 * Claude Code reads ~/.claude/keybindings.json for per-context bindings.
 * The file format is an object with a "bindings" array; each entry carries
 * a "context" string and a "bindings" map of key to action.
 *
 * The one binding every machine wants: Shift+Enter inserts a newline in
 * Chat rather than submitting the message. Without it, every multi-line
 * prompt has to be built somewhere else and pasted in.
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
const KEY = "shift+enter";
const ACTION = "chat:newline";

function defaultPath(): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  return `${home.replace(/\\/g, "/")}/.claude/keybindings.json`;
}

export type BindingOutcome = "wrote" | "already-set" | "conflict" | "malformed";

type BindingEntry = { context?: string; bindings?: Record<string, string> } & Record<
  string,
  unknown
>;
type KeybindingFile = { bindings?: BindingEntry[] } & Record<string, unknown>;

/**
 * Ensure ~/.claude/keybindings.json maps Shift+Enter to chat:newline in Chat.
 *
 * Accepts an explicit path for tests; omit to use the real Claude config dir.
 */
export async function convergeClaudeKeybinding(path?: string): Promise<BindingOutcome> {
  const target = path ?? defaultPath();

  if (!existsSync(target)) {
    await Bun.write(
      target,
      JSON.stringify(
        { bindings: [{ context: CONTEXT, bindings: { [KEY]: ACTION } }] },
        null,
        2,
      ) + "\n",
    );
    return "wrote";
  }

  let raw: string;
  try {
    raw = await Bun.file(target).text();
  } catch {
    log.warn(`claude keybindings: cannot read ${target} — leaving it alone`);
    return "malformed";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn(`claude keybindings: ${target} is not valid JSON — leaving it alone`);
    return "malformed";
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    log.warn(`claude keybindings: ${target} has an unexpected root type — leaving it alone`);
    return "malformed";
  }

  const obj = parsed as KeybindingFile;
  const bindings = obj.bindings;

  if (!Array.isArray(bindings)) {
    await Bun.write(
      target,
      JSON.stringify(
        { ...obj, bindings: [{ context: CONTEXT, bindings: { [KEY]: ACTION } }] },
        null,
        2,
      ) + "\n",
    );
    return "wrote";
  }

  const chatEntry = bindings.find(
    (b): b is BindingEntry => typeof b === "object" && b !== null && b.context === CONTEXT,
  );

  if (!chatEntry) {
    await Bun.write(
      target,
      JSON.stringify(
        { ...obj, bindings: [...bindings, { context: CONTEXT, bindings: { [KEY]: ACTION } }] },
        null,
        2,
      ) + "\n",
    );
    return "wrote";
  }

  const existing = chatEntry.bindings?.[KEY];
  if (existing === ACTION) return "already-set";

  if (existing !== undefined) {
    log.warn(
      `claude keybindings: ${KEY} is already bound to "${existing}" — leaving it alone`,
    );
    return "conflict";
  }

  await Bun.write(
    target,
    JSON.stringify(
      {
        ...obj,
        bindings: bindings.map((b) =>
          b === chatEntry
            ? { ...b, bindings: { ...(b.bindings ?? {}), [KEY]: ACTION } }
            : b,
        ),
      },
      null,
      2,
    ) + "\n",
  );
  return "wrote";
}

/**
 * Convergence entry-point called from the builtin dispatcher.
 *
 * Skipped silently when Claude Code is not installed: the keybinding has
 * nowhere to go without the CLI.
 */
export async function convergeClaudeKeybindings(): Promise<void> {
  if (!Bun.which("claude")) {
    log.skip("claude keybindings: claude not installed");
    return;
  }

  const outcome = await convergeClaudeKeybinding();
  switch (outcome) {
    case "wrote":
      log.ok(`claude keybindings: ${KEY} → ${ACTION}`);
      break;
    case "already-set":
      log.skip(`claude keybindings: ${KEY} already maps to ${ACTION}`);
      break;
    case "conflict":
    case "malformed":
      // Warning already emitted inside convergeClaudeKeybinding.
      break;
  }
}
