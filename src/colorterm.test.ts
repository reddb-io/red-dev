/**
 * The capability the terminal knows about and the shell never hears.
 *
 * Alacritty, Windows Terminal and the VS Code terminal all export
 * COLORTERM=truecolor. Under WSL and Git Bash none of it arrives:
 * wsl.exe forwards only what WSLENV names, and Git Bash builds its own
 * environment rather than inheriting the launcher's. A shell attached to
 * a 24-bit terminal therefore claims nothing, and every program that
 * asks before it paints falls back to the sixteen ANSI slots.
 *
 * These run rc.sh for real rather than matching strings in it. The
 * condition is four clauses joined by && and ||, which is exactly the
 * shape that reads correct and evaluates wrong, and a grep for
 * `COLORTERM=truecolor` would pass on all of them.
 *
 * RED_ROOT and HOME point at an empty temp directory, so the sourcing
 * loop finds no parts and env.sh and local.sh do not exist — leaving
 * this block as the only thing under test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/red-dev-colorterm-`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Source rc.sh with a controlled environment and report COLORTERM. */
function colortermAfterRc(env: Record<string, string>): string {
  const out = execFileSync(
    "bash",
    ["-c", '. config/bash/rc.sh >/dev/null 2>&1; printf "%s" "${COLORTERM:-}"'],
    {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", HOME: dir, RED_ROOT: dir, ...env },
    },
  );
  return out.trim();
}

describe("COLORTERM", () => {
  test("is claimed under WSL, where wsl.exe drops the terminal's own", () => {
    expect(colortermAfterRc({ RED_ENV: "wsl", TERM: "xterm-256color" })).toBe("truecolor");
  });

  test("is claimed under Git Bash, which inherits nothing from the launcher", () => {
    expect(colortermAfterRc({ RED_ENV: "windows", TERM: "xterm-256color" })).toBe("truecolor");
  });

  test("is left alone on a Linux desktop, where the terminal sets it itself", () => {
    // Setting it here would be red-dev answering a question the terminal
    // is present to answer, and answering it the same way every time.
    expect(colortermAfterRc({ RED_ENV: "desktop", TERM: "xterm-256color" })).toBe("");
  });

  test("never overrides one that arrived", () => {
    // A terminal that did manage to say something knows better than a
    // default. `24bit` is the other spelling in the wild.
    const env = { RED_ENV: "wsl", TERM: "xterm-256color", COLORTERM: "24bit" };
    expect(colortermAfterRc(env)).toBe("24bit");
  });

  test("is not claimed on a TERM that means no colour at all", () => {
    // Claiming truecolor on a Linux console is the same lie as losing it
    // under WSL, pointing the other way.
    expect(colortermAfterRc({ RED_ENV: "wsl", TERM: "linux" })).toBe("");
    expect(colortermAfterRc({ RED_ENV: "wsl", TERM: "dumb" })).toBe("");
  });
});
