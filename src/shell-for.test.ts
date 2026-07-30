/**
 * A vendor script runs under the interpreter it asked for.
 *
 * Every installer went through `sh` before this, which on Ubuntu is
 * dash. red-request's script is deliberately POSIX and says so in its
 * own header, so nobody noticed — until dit, whose installer is
 * `#!/usr/bin/env bash` and uses `[[ ]]` and `local` in the part that
 * sets up /dev/uinput permissions. dash would have died there with a
 * syntax error *after* installing the binary, leaving a program that
 * runs and cannot see a keypress.
 */

import { describe, expect, test } from "bun:test";
import { shellFor } from "./providers.ts";

describe("shellFor", () => {
  test("env bash — the form dit uses", () => {
    expect(shellFor("#!/usr/bin/env bash\nset -euo pipefail\n")).toBe("bash");
  });

  test("plain bash", () => {
    expect(shellFor("#!/bin/bash\n")).toBe("bash");
  });

  test("posix sh — the form red-request uses, and it must stay sh", () => {
    expect(shellFor("#!/bin/sh\n#\n# Red Request installer\n")).toBe("sh");
  });

  test("env sh", () => {
    expect(shellFor("#!/usr/bin/env sh\n")).toBe("sh");
  });

  test("no shebang falls back to sh", () => {
    expect(shellFor("echo hello\n")).toBe("sh");
  });

  test("a name merely ending in the letters is not bash", () => {
    // /usr/local/bin/rebash is not bash; anchoring on a path boundary is
    // what keeps this from being a guess.
    expect(shellFor("#!/usr/local/bin/notbash\n")).toBe("sh");
  });
});
