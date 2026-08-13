/** Codex TUI status-line convergence, preserving the rest of config.toml. */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./log.ts";

export const CODEX_STATUS_LINE = [
  "project-name",
  "current-dir",
  "git-branch",
  "model-with-reasoning",
  "context-remaining",
  "five-hour-limit",
  "weekly-limit",
] as const;

const STATUS_LINE = `status_line = [${CODEX_STATUS_LINE.map((item) => `"${item}"`).join(", ")}]`;

export type CodexStatuslineResult = "written" | "unchanged";

/** The user-level config Codex reads on every supported host. */
export function codexConfigPath(): string | null {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"];
  return home ? `${home.replace(/\\/g, "/")}/.codex/config.toml` : null;
}

/**
 * Set only tui.status_line in an arbitrary TOML document. PURE.
 *
 * Both Codex-supported spellings are understood: a root dotted key and a
 * `[tui]` table. Everything else, including comments and unknown future keys,
 * is retained byte-for-byte apart from the one managed assignment.
 */
export function withCodexStatusline(source: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const terminalNewline = source.endsWith("\n");
  const lines = source === "" ? [] : source.replace(/\r?\n$/, "").split(/\r?\n/);

  const dotted = lines.findIndex((line) => /^\s*tui\.status_line\s*=/.test(line));
  if (dotted >= 0) {
    replaceAssignment(lines, dotted, `tui.${STATUS_LINE}`);
    return lines.join(newline) + (terminalNewline ? newline : "");
  }

  const tui = lines.findIndex((line) => /^\s*\[tui\]\s*(?:#.*)?$/.test(line));
  if (tui >= 0) {
    let end = lines.length;
    for (let index = tui + 1; index < lines.length; index += 1) {
      if (/^\s*\[/.test(lines[index]!)) {
        end = index;
        break;
      }
    }
    const assignment = lines.findIndex(
      (line, index) => index > tui && index < end && /^\s*status_line\s*=/.test(line),
    );
    if (assignment >= 0) replaceAssignment(lines, assignment, STATUS_LINE);
    else lines.splice(end, 0, STATUS_LINE);
    return lines.join(newline) + (terminalNewline ? newline : "");
  }

  if (lines.length > 0 && lines.at(-1)?.trim() !== "") lines.push("");
  lines.push("[tui]", STATUS_LINE);
  return lines.join(newline) + newline;
}

/** Replace a scalar or a possibly multi-line array assignment as one unit. */
function replaceAssignment(lines: string[], at: number, replacement: string): void {
  const value = lines[at]!.slice(lines[at]!.indexOf("=") + 1);
  let balance = brackets(value);
  let end = at;
  while (balance > 0 && end + 1 < lines.length) {
    end += 1;
    balance += brackets(lines[end]!);
  }
  lines.splice(at, end - at + 1, replacement);
}

function brackets(value: string): number {
  return [...value].reduce((total, char) => total + (char === "[" ? 1 : char === "]" ? -1 : 0), 0);
}

/** Merge the managed line into one Codex config, atomically and idempotently. */
export async function convergeCodexStatusline(path: string): Promise<CodexStatuslineResult> {
  const before = existsSync(path) ? await Bun.file(path).text() : "";
  const after = withCodexStatusline(before);
  if (after === before) return "unchanged";

  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.red-dev-${process.pid}`;
  writeFileSync(temporary, after, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  return "written";
}

/** Converge when Codex is installed; otherwise this managed item has no target. */
export async function configureCodexStatusline(): Promise<void> {
  if (!Bun.which("codex")) {
    log.skip("Codex statusline: Codex CLI not installed");
    return;
  }
  const path = codexConfigPath();
  if (path === null) {
    log.skip("Codex statusline: no user home available");
    return;
  }
  const result = await convergeCodexStatusline(path);
  if (result === "unchanged") log.skip("Codex statusline already configured");
  else log.ok("Codex statusline configured");
}
