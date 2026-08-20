/**
 * Put a failed run on the clipboard, because the console will not.
 *
 * The classic Windows Console Host copies by selecting with the mouse
 * and pressing Enter; Ctrl+C there is an interrupt, not a copy. And
 * red-dev makes that worse on purpose: `windows-console-mode.ts`
 * disables QuickEdit for the length of a fullscreen view, because a
 * mouse drag in that console *pauses the attached process* and turns a
 * running install into one that looks hung. Correct, and it leaves
 * somebody staring at an error they cannot select.
 *
 * So the run copies it for them. Nobody needs to select anything: the
 * failures and the log path are already on the clipboard when the frame
 * comes down, ready to paste into an issue, a chat, or a message to
 * whoever maintains this.
 *
 * ## Only a failure, and only what a person would have selected
 *
 * A successful run copies nothing — silently taking someone's clipboard
 * is a theft, and the moment it is worth it is exactly the moment they
 * were about to do it by hand. The text is plain: no colour, no box
 * drawing, no glyphs that arrive as question marks in a bug report.
 *
 * The route is `clipboardArgvFor`, the terminal layer's own, which
 * zellij's `copy_command` is also built from — the WSL bridge in
 * particular took three attempts to get right and this is not the
 * surface that gets to reinvent it.
 */

import { failureFacts, verdictFacts, type CompletionVerdict } from "./completion.ts";
import { clipboardArgvFor } from "./dotfiles.ts";
import type { Platform } from "./platform.ts";

/** What a person would have selected, as plain text. PURE. */
export function failureReport(verdict: CompletionVerdict, version: string): string {
  const lines = [`red-dev ${version} — ${verdict.headline}`, ...verdictFacts(verdict)];

  if (verdict.failures.length > 0) {
    lines.push("", "Errors");
    for (const failure of failureFacts(verdict)) lines.push(`- ${failure}`);
  }
  if (verdict.deferrals.length > 0) {
    lines.push("", "Waiting");
    for (const deferral of verdict.deferrals) {
      lines.push(`- ${deferral.tool}: ${deferral.detail ?? "no deferral detail was reported"}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Whether this run is one worth copying. PURE. */
export function worthCopying(verdict: CompletionVerdict): boolean {
  return verdict.failures.length > 0;
}

export type ClipboardWrite = (argv: readonly string[], text: string) => Promise<number>;

/**
 * The default write: bounded, and never able to hang a finished run.
 *
 * Every route ends in a program that can wedge — `clip.exe` when WSL
 * interop is stuck, `wl-copy` with no compositor — and this runs after
 * the work is done, where a hang would be the last thing anyone saw.
 */
async function writeClipboard(argv: readonly string[], text: string): Promise<number> {
  const { runBounded } = await import("./bounded-command.ts");
  const result = await runBounded([...argv], { stdin: text, timeoutMs: 2_000 });
  return result.timedOut ? 1 : (result.exitCode ?? 1);
}

/** Copied, or the reason it was not. Never thrown: this is a courtesy. */
export async function copyFailures(
  p: Platform,
  verdict: CompletionVerdict,
  version: string,
  write: ClipboardWrite = writeClipboard,
): Promise<string | null> {
  if (!worthCopying(verdict)) return null;

  const argv = clipboardArgvFor(p);
  if (!argv) return null;

  try {
    const code = await write(argv, failureReport(verdict, version));
    return code === 0 ? "the errors above are on your clipboard" : null;
  } catch {
    // A clipboard that refused is not a failed run. The report is on
    // screen and in the log either way.
    return null;
  }
}
