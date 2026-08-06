/**
 * XDG_RUNTIME_DIR triage.
 *
 * The case that motivated this is the third one: WSL exports the variable
 * and systemd-logind never creates the directory, because `wsl.exe` opens
 * no PAM session. A set-but-absent path is the failure, not an absent
 * variable — programs that see the variable stop falling back to /tmp and
 * try to mkdir under root-owned /run/user instead.
 */

import { describe, expect, test } from "bun:test";
import { runtimeDirState } from "./wsl.ts";

describe("runtimeDirState", () => {
  test("an unset variable is nobody's problem", () => {
    expect(runtimeDirState(undefined, null, 1000)).toBe("unset");
    expect(runtimeDirState("", null, 1000)).toBe("unset");
  });

  test("set and owned by us is the working case", () => {
    expect(runtimeDirState("/run/user/1000", 1000, 1000)).toBe("usable");
  });

  test("set but absent is the WSL failure", () => {
    expect(runtimeDirState("/run/user/1000", null, 1000)).toBe("unusable");
  });

  test("set but owned by another uid is no better than absent", () => {
    expect(runtimeDirState("/run/user/1000", 0, 1000)).toBe("unusable");
  });

  test("root running as root still reads its own dir as usable", () => {
    expect(runtimeDirState("/run/user/0", 0, 0)).toBe("usable");
  });
});
