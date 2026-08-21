/**
 * Reaching Windows without putting a window on the screen.
 *
 * A Windows console program started through WSL interop from a process
 * that has no console of its own — a systemd unit, a scheduled task —
 * has a fresh console allocated for it, because the allocation is the
 * launcher's decision and not the child's. Redirecting the child's
 * streams does not prevent it. That is the black rectangle that flashes
 * on the desktop every two minutes once the Redwall is on a timer, and
 * it is the whole reason this module exists.
 *
 * `wscript.exe` is a GUI-subsystem image, and Windows allocates no
 * console for one of those whatever the launcher asks for. So every
 * crossing goes through it: wscript hosts a tiny script, the script
 * starts the real child with a window style of 0, and nothing is ever
 * drawn. The cost is one extra process per crossing and the loss of the
 * child's streams — see `hiddenCapture` for what is done about the
 * second.
 *
 * ## Why the payload is base64
 *
 * A command line handed to `runHidden` is parsed three times on its way
 * to the child: WSL's interop layer quotes it into a Windows command
 * line, `WScript.Arguments` takes it apart again, and `cmd.exe` may see
 * it a third time. The PowerShell red-dev needs to run carries both
 * kinds of quote — `[DllImport("user32.dll")]` inside a '-quoted C#
 * block — and there is no escaping that survives all three. Base64 of
 * UTF-16LE, which is what `-EncodedCommand` wants, contains no quote, no
 * space and no backslash, so none of the three parsers has anything to
 * get wrong.
 */

import { existsSync, mkdirSync } from "node:fs";
import type { Platform } from "./platform.ts";

/**
 * The managed script, named for what it does rather than for red-dev:
 * it sits beside the images in a directory that is already ours.
 */
export const HIDDEN_RUNNER = "hidden-run.vbs";

const MANAGED = "' Managed by red-dev — rewritten when its bytes change.";

/**
 * The exact bytes of the runner. PURE.
 *
 * Exported for the same reason `redwallUnits` is: it is a contract with
 * a host this test suite has no access to, and the only way to assert
 * what red-dev asks Windows to do is to assert the script that asks.
 *
 * CRLF because it is a Windows script file. wscript reads either, but a
 * managed file a person may open in Notepad should not arrive as one
 * long line.
 */
export function hiddenRunnerVbs(): string {
  return [
    MANAGED,
    "'",
    "' Argument 0 is the command line to run. Argument 1, when it is",
    "' given, is a file to capture the output into — a hidden child has",
    "' no stream this side can read, so a file is the only way back.",
    "Option Explicit",
    "Dim shell, command",
    "If WScript.Arguments.Count = 0 Then WScript.Quit 2",
    'Set shell = CreateObject("WScript.Shell")',
    "command = WScript.Arguments(0)",
    "If WScript.Arguments.Count > 1 Then",
    // stderr to nul rather than into the file: PowerShell writes its
    // progress records there as CLIXML, and a caller parsing JSON would
    // be handed a document with an XML tail.
    '  command = "cmd.exe /c " & command & " > """ & WScript.Arguments(1) & """ 2>nul"',
    "End If",
    // 0 hides the window, True waits — so the exit code below is the
    // child's and not wscript's opinion of having started one.
    "WScript.Quit shell.Run(command, 0, True)",
    "",
  ].join("\r\n");
}

/**
 * A PowerShell one-liner, spelled so that nothing between here and the
 * child can misread it. PURE.
 */
export function powershellCommand(script: string): string {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

/**
 * The one argv shape red-dev asks Windows for, re-spelled as a command
 * line this module can hide. Null for anything else. PURE.
 *
 * Null rather than a best effort, because the alternative is assembling
 * a command line out of arguments whose quoting nobody checked and
 * running it: a caller handed null falls back to its own spawn, which
 * flashes a window and works, and that is the right way round.
 */
export function hiddenPowershell(argv: string[]): string | null {
  const shell = argv[0] ?? "";
  if (!/powershell(\.exe)?$/i.test(shell)) return null;
  if (argv[argv.length - 2] !== "-Command") return null;
  return powershellCommand(argv[argv.length - 1] ?? "");
}

/**
 * A path as the Windows side spells it, or null when this side cannot
 * say.
 *
 * The WSL branch is `wslpath -w` rather than a substitution on /mnt/c,
 * for the reason `windowsLocalAppData` asks cmd.exe instead of guessing:
 * a redirected profile, a second drive or a distro mounted somewhere
 * other than /mnt all produce a path no rewrite rule would have found.
 */
export async function windowsPathFor(path: string, p: Platform): Promise<string | null> {
  if (p.env !== "wsl") return path.replace(/\//g, "\\");
  const proc = Bun.spawn(["wslpath", "-w", path], { stdout: "pipe", stderr: "ignore" });
  const winPath = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !winPath) return null;
  return winPath;
}

/** Where wscript is, from either side of the boundary. */
export function wscriptBin(): string {
  if (process.platform === "win32") return "wscript.exe";
  return Bun.which("wscript.exe") ?? "/mnt/c/Windows/System32/wscript.exe";
}

/**
 * Put the runner in `dir` and answer with the path Windows would use.
 *
 * Write-if-changed, the same idiom the systemd units keep and for a
 * milder version of the same reason: this runs on every repaint, and a
 * managed file whose timestamp moves every two minutes is a file nobody
 * can tell a real change from.
 */
export async function installHiddenRunner(dir: string, p: Platform): Promise<string | null> {
  const path = `${dir}/${HIDDEN_RUNNER}`;
  const body = hiddenRunnerVbs();
  const current = existsSync(path) ? await Bun.file(path).text().catch(() => null) : null;
  if (current !== body) {
    mkdirSync(dir, { recursive: true });
    await Bun.write(path, body);
  }
  return await windowsPathFor(path, p);
}

/**
 * Run a Windows command line with no window, and report only whether it
 * succeeded.
 *
 * Coarse on purpose. A hidden child has no streams to read, so the exit
 * code is the whole of what comes back — and for the one caller that
 * matters, a desktop repaint, "it did not take" is the entire decision
 * anyway. A caller that needs the output asks for `hiddenCapture`, which
 * pays a temporary file for it.
 */
export async function runHidden(dir: string, command: string, p: Platform): Promise<boolean> {
  const runner = await installHiddenRunner(dir, p);
  if (runner === null) return false;
  try {
    const proc = Bun.spawn([wscriptBin(), "//B", "//Nologo", runner, command], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Run a Windows command line with no window and read back what it said.
 *
 * Through a file in `dir`, because there is no stream: `dir` is already
 * a directory on the host's own disk that red-dev owns, so the capture
 * lands somewhere both sides can name. The file is removed afterwards
 * and its absence is not an error — a machine that failed to write it is
 * a machine whose command produced nothing, which is the same answer.
 */
export async function hiddenCapture(
  dir: string,
  command: string,
  p: Platform,
): Promise<{ out: string; code: number }> {
  const runner = await installHiddenRunner(dir, p);
  if (runner === null) return { out: "", code: 1 };

  const path = `${dir}/hidden-capture-${process.pid}.txt`;
  const target = await windowsPathFor(path, p);
  if (target === null) return { out: "", code: 1 };
  try {
    const proc = Bun.spawn([wscriptBin(), "//B", "//Nologo", runner, command, target], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    const code = await proc.exited;
    const out = existsSync(path) ? await Bun.file(path).text() : "";
    return { out: out.trim(), code };
  } catch {
    return { out: "", code: 1 };
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(path, { force: true });
  }
}
