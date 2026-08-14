/**
 * The runtime directory the shell is told about before it exists.
 *
 * wsl.exe exports XDG_RUNTIME_DIR=/run/user/<uid> and starts the shell
 * while systemd is still booting, so on a cold boot the first prompt
 * arrives before user@<uid>.service has made the directory. zellij exits
 * 101 on it, and ble.sh falls back to /tmp/blesh/<uid> — which
 * systemd-tmpfiles then empties at boot, leaving an attached ble.sh
 * writing to a directory that is gone for the rest of the session.
 *
 * These run rc.sh for real rather than matching strings in it. What is
 * under test is a fallback chain that has to leave the variable naming a
 * directory that exists on every path, including the one where it gives
 * up — and a grep cannot tell those paths apart.
 *
 * RED_ROOT and HOME point at an empty temp directory, so the sourcing
 * loop finds no parts and env.sh and local.sh do not exist, leaving this
 * block as the only thing under test. HOME is also where the fallback
 * lands, which is what makes it observable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/red-dev-xdg-`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Source rc.sh with a controlled environment and report XDG_RUNTIME_DIR. */
function xdgAfterRc(env: Record<string, string>): string {
  const out = execFileSync(
    "bash",
    ["-c", '. config/bash/rc.sh >/dev/null 2>&1; printf "%s" "${XDG_RUNTIME_DIR:-}"'],
    {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", HOME: dir, RED_ROOT: dir, ...env },
    },
  );
  return out.trim();
}

describe("XDG_RUNTIME_DIR", () => {
  test("a directory we own is left exactly as it arrived", () => {
    // The normal case, and the one the whole block must stay out of:
    // a working systemd user session is the thing we would rather have.
    expect(xdgAfterRc({ RED_ENV: "wsl", XDG_RUNTIME_DIR: dir })).toBe(dir);
  });

  test("an unset variable is left unset", () => {
    // Unset is a defined state that every program handles with its own
    // fallback. Inventing a value here would take that choice away.
    expect(xdgAfterRc({ RED_ENV: "wsl" })).toBe("");
  });

  test("a path that does not exist is replaced by one that does", () => {
    // The WSL cold-boot failure. `/run/user/<uid>` never appears in the
    // window this shell lives in, so the shell stops waiting for it.
    const got = xdgAfterRc({ RED_ENV: "wsl", XDG_RUNTIME_DIR: `${dir}/absent` });
    expect(got).toBe(`${dir}/.local/state/red-dev/run`);
    expect(existsSync(got)).toBe(true);
    expect(statSync(got).mode & 0o777).toBe(0o700);
  });

  test("a path that exists but is not a directory is no better than an absent one", () => {
    // ble.sh's own wording for this — "XDG_RUNTIME_DIR is not a
    // directory" — is the line that opens the flood in the report. -d
    // rather than -e is what separates the two.
    writeFileSync(`${dir}/notadir`, "");
    const got = xdgAfterRc({ RED_ENV: "wsl", XDG_RUNTIME_DIR: `${dir}/notadir` });
    expect(got).toBe(`${dir}/.local/state/red-dev/run`);
    expect(existsSync(got)).toBe(true);
  });
});
