/**
 * The scripts red-dev asks Windows to run, checked without a Windows.
 *
 * Every claim here is about bytes and about argument shapes, because
 * that is all this side controls: what happens after wscript takes the
 * file is the host's business, and a suite that could observe it would
 * be a suite that had put a window on somebody's screen to find out.
 *
 * The runner is not run. Its default reaches a real `wscript.exe` and a
 * real desktop, so the two functions that spawn are exercised only
 * through the seams their callers already have — see
 * `redwall-apply.test.ts` for the tick that must spawn nothing at all.
 */

import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { Platform } from "./platform.ts";
import {
  hiddenPowershell,
  hiddenRunnerVbs,
  HIDDEN_RUNNER,
  installHiddenRunner,
  powershellCommand,
  windowsPathFor,
} from "./windows-hidden.ts";

const windows: Platform = {
  os: "windows",
  distro: null,
  version: "11",
  codename: null,
  env: "windows",
  arch: "x64",
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
};

describe("the runner script", () => {
  test("starts its child hidden and waits for the exit code", async () => {
    const body = hiddenRunnerVbs();

    // 0 is the window style, and it is the whole reason this file
    // exists. True is what makes the exit code the child's rather than
    // wscript's opinion of having started one.
    expect(body).toContain("shell.Run(command, 0, True)");
    expect(body).toContain("WScript.Quit");
    expect(body).toContain("Managed by red-dev");
    // CRLF: a Windows script file somebody may open in Notepad.
    expect(body.includes("\r\n")).toBe(true);
    expect(body.split("\n").every((line) => line === "" || line.endsWith("\r"))).toBe(true);
  });

  test("refuses to run nothing rather than running whatever it finds", async () => {
    expect(hiddenRunnerVbs()).toContain("If WScript.Arguments.Count = 0 Then WScript.Quit 2");
  });

  test("sends the child's stderr nowhere when it is capturing", async () => {
    // PowerShell writes progress records to stderr as CLIXML. Merged
    // into the capture, a caller parsing JSON is handed a document with
    // an XML tail and no way to tell which half was the answer.
    expect(hiddenRunnerVbs()).toContain("2>nul");
  });
});

describe("the command line", () => {
  test("carries the script as base64, so no parser can misread it", async () => {
    const script = `Add-Type -TypeDefinition 'using System; [DllImport("user32.dll")]';`;
    const command = powershellCommand(script);

    // The reason for the encoding: the script has both kinds of quote,
    // and it is parsed by WSL's interop layer, by WScript.Arguments and
    // possibly by cmd.exe before the child ever sees it.
    expect(command).not.toContain('"');
    expect(command).not.toContain("'");
    expect(command).toStartWith("powershell.exe -NoProfile -NonInteractive -EncodedCommand ");

    const encoded = command.split(" ").at(-1)!;
    // UTF-16LE, which is the only encoding -EncodedCommand accepts.
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(script);
  });

  test("recognises the one argv shape red-dev asks Windows for", async () => {
    const script = "(Get-ItemProperty 'HKCU:\\Control Panel\\Desktop').WallPaper";
    const command = hiddenPowershell(["powershell.exe", "-NoProfile", "-Command", script]);

    expect(command).toBe(powershellCommand(script));
    // Reached by an absolute path across the WSL boundary, which is the
    // spelling the machine actually uses.
    expect(
      hiddenPowershell([
        "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
        "-NoProfile",
        "-Command",
        script,
      ]),
    ).toBe(powershellCommand(script));
  });

  test("says null for anything else rather than assembling a guess", async () => {
    // The caller falls back to its own spawn, which flashes a window and
    // works. Assembling a command line out of arguments whose quoting
    // nobody checked is the failure that would be silent.
    expect(hiddenPowershell(["ip", "-json", "addr"])).toBeNull();
    expect(hiddenPowershell(["powershell.exe", "-File", "c:\\x.ps1"])).toBeNull();
    expect(hiddenPowershell([])).toBeNull();
  });
});

describe("installing the runner", () => {
  test("writes it once and leaves the bytes alone after that", async () => {
    const dir = mkdtempSync(`${tmpdir()}/red-dev-hidden-`);

    const path = await installHiddenRunner(dir, windows);
    expect(existsSync(`${dir}/${HIDDEN_RUNNER}`)).toBe(true);
    const stamped = statSync(`${dir}/${HIDDEN_RUNNER}`).mtimeMs;

    await installHiddenRunner(dir, windows);

    // Every repaint passes through here, so a rewrite would move this
    // file's timestamp every two minutes and leave nobody able to tell a
    // real change from the clock.
    expect(statSync(`${dir}/${HIDDEN_RUNNER}`).mtimeMs).toBe(stamped);
    expect(path).toBe(`${dir.replace(/\//g, "\\")}\\${HIDDEN_RUNNER}`);
  });

  test("repairs a runner somebody edited", async () => {
    const dir = mkdtempSync(`${tmpdir()}/red-dev-hidden-`);
    writeFileSync(`${dir}/${HIDDEN_RUNNER}`, "WScript.Echo \"hello\"\r\n");

    await installHiddenRunner(dir, windows);

    expect(await Bun.file(`${dir}/${HIDDEN_RUNNER}`).text()).toBe(hiddenRunnerVbs());
  });
});

describe("naming a path the way Windows names it", () => {
  test("is a separator swap anywhere but WSL", async () => {
    // No process: a native Windows target already holds the path in the
    // only spelling there is, and asking a translator would be asking
    // about a boundary that is not there.
    expect(await windowsPathFor("C:/Users/me/red-dev/x.png", windows)).toBe(
      "C:\\Users\\me\\red-dev\\x.png",
    );
  });
});
