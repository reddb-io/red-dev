import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Claude Code's own updater installs a second copy under
 * ~/.local/share/claude that the mise shim shadows, so it is switched
 * off exactly where mise owns claude and nowhere else.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/red-dev-autoupdater-`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function autoUpdaterAfterRc(): string {
  return execFileSync(
    "bash",
    ["-c", '. config/bash/rc.sh >/dev/null 2>&1; printf "%s" "${DISABLE_AUTOUPDATER:-}"'],
    {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", HOME: dir, RED_ROOT: dir, RED_ENV: "desktop", TERM: "xterm" },
    },
  );
}

describe("DISABLE_AUTOUPDATER", () => {
  test("is set where mise owns claude", () => {
    mkdirSync(`${dir}/.local/share/mise/installs/claude`, { recursive: true });
    expect(autoUpdaterAfterRc()).toBe("1");
  });

  test("is left alone where claude is not mise's", () => {
    expect(autoUpdaterAfterRc()).toBe("");
  });
});
