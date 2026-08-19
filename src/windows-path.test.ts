/**
 * The order of two PATH entries, which is the whole fix.
 *
 * A machine where `%LOCALAPPDATA%\red-dev\bin` wins is a machine where
 * `mise upgrade red-dev` updates a copy nothing executes — and where
 * the migration that retires that copy can never fire, because it skips
 * the binary of the running process and that copy is always the one
 * running.
 */

import { describe, expect, test } from "bun:test";

import {
  parseWindowsPathFacts,
  pathWithShimsFirst,
  READ_SCRIPT,
  writeUserPathScript,
} from "./windows-path.ts";

const SHIMS = "C:\\Users\\me\\AppData\\Local\\mise\\shims";
const BOOT = "C:\\Users\\me\\AppData\\Local\\red-dev\\bin";

describe("ordering mise's shims against the bootstrap copy", () => {
  test("moves the shims ahead when they trail the bootstrap directory", () => {
    const before = `C:\\Windows;${BOOT};C:\\other;${SHIMS}`;
    expect(pathWithShimsFirst(before, SHIMS, BOOT)).toBe(
      `C:\\Windows;${SHIMS};${BOOT};C:\\other`,
    );
  });

  test("adds them when they are absent entirely — the machine that found this", () => {
    // Nothing mise installed was reachable by name on that machine:
    // not red-dev, not cosign, not anything.
    const before = `C:\\Windows;${BOOT};C:\\mise\\bin`;
    expect(pathWithShimsFirst(before, SHIMS, BOOT)).toBe(
      `C:\\Windows;${SHIMS};${BOOT};C:\\mise\\bin`,
    );
  });

  test("says nothing to do when they already resolve first", () => {
    expect(pathWithShimsFirst(`${SHIMS};${BOOT}`, SHIMS, BOOT)).toBeNull();
    expect(pathWithShimsFirst(`C:\\Windows;${SHIMS};C:\\x;${BOOT}`, SHIMS, BOOT)).toBeNull();
  });

  test("appends when there is no bootstrap directory to be ahead of", () => {
    expect(pathWithShimsFirst("C:\\Windows", SHIMS, BOOT)).toBe(`C:\\Windows;${SHIMS}`);
    expect(pathWithShimsFirst(`C:\\Windows;${SHIMS}`, SHIMS, BOOT)).toBeNull();
  });

  test("keeps every other entry in the order the person put it", () => {
    const before = `A;B;${BOOT};C;${SHIMS};D`;
    expect(pathWithShimsFirst(before, SHIMS, BOOT)).toBe(`A;B;${SHIMS};${BOOT};C;D`);
  });

  test("matches an entry with a trailing slash or a different case", () => {
    const before = `${BOOT}\\;${SHIMS.toUpperCase()}`;
    expect(pathWithShimsFirst(before, SHIMS, BOOT)).toBe(`${SHIMS};${BOOT}\\`);
  });

  test("quotes the value it writes back, so a path with an apostrophe cannot end the string", () => {
    expect(writeUserPathScript("C:\\it's;D:\\x")).toContain("'C:\\it''s;D:\\x'");
  });
});

describe("the facts that come back from the Windows side", () => {
  // Four values, each delimited, with the terminator READ_SCRIPT emits.
  const out = (parts: string[]) => `${parts.join("\n---\n")}\n---\n`;

  test("derives both directories from %LOCALAPPDATA% the way boot.ps1 and mise do", () => {
    const facts = parseWindowsPathFacts(
      out([`C:\\Windows;${BOOT}`, "C:\\Users\\me\\AppData\\Local", "", ""]),
    );
    expect(facts).toEqual({
      userPath: `C:\\Windows;${BOOT}`,
      shims: "C:\\Users\\me\\AppData\\Local\\mise\\shims",
      bootBin: "C:\\Users\\me\\AppData\\Local\\red-dev\\bin",
    });
  });

  test("honours the operator's overrides, which are set on the Windows side", () => {
    const facts = parseWindowsPathFacts(
      out(["C:\\Windows", "C:\\Users\\me\\AppData\\Local", "D:\\mise", "E:\\tools\\red-dev"]),
    );
    expect(facts?.shims).toBe("D:\\mise\\shims");
    expect(facts?.bootBin).toBe("E:\\tools\\red-dev");
  });

  test("survives CRLF, which is what PowerShell actually prints", () => {
    const facts = parseWindowsPathFacts(
      `C:\\Windows\r\n---\r\nC:\\Users\\me\\AppData\\Local\r\n---\r\n\r\n---\r\n\r\n---\r\n`,
    );
    expect(facts?.shims).toBe("C:\\Users\\me\\AppData\\Local\\mise\\shims");
  });

  test("answers null when Windows told us nothing, so nothing is written", () => {
    expect(parseWindowsPathFacts("")).toBeNull();
    expect(parseWindowsPathFacts(out(["C:\\Windows", "", "", ""]))).toBeNull();
  });
});

describe("which machines this runs on", () => {
  test("Windows and WSL both, because it is one Windows PATH either way", async () => {
    // The distro's converge fixes the host's PATH through interop, the
    // same crossing shared-root.ts makes. A plain Linux machine has
    // path.sh and is skipped.
    const source = await Bun.file(new URL("./windows-path.ts", import.meta.url)).text();
    expect(source).toContain('p.os !== "windows" && p.env !== "wsl"');
    expect(source).toContain('await import("./wsl.ts")');
  });
});

describe("an unset variable on the Windows side", () => {
  test("is a line, not a missing section — the bug that wrote ---\\shims to a real PATH", () => {
    // PowerShell prints nothing at all for a bare `$env:X` that is
    // unset, so the sections collapsed and the separator itself was
    // read as the mise data directory. Every value is quoted now.
    expect(READ_SCRIPT).toContain('"$env:MISE_DATA_DIR"');
    expect(READ_SCRIPT).toContain('"$env:RED_DEV_BIN_DIR"');
    expect(READ_SCRIPT).toContain('"$env:LOCALAPPDATA"');
  });

  test("and a collapsed reading is refused rather than written", () => {
    // Exactly what the machine produced: four values, two of them
    // unset, printed as three sections.
    const collapsed = "C:\\Windows\n---\nC:\\Users\\me\\AppData\\Local\n---\n---\n";
    expect(parseWindowsPathFacts(collapsed)).toBeNull();
  });

  test("a well-formed reading with both overrides unset still works", () => {
    const proper = "C:\\Windows\n---\nC:\\Users\\me\\AppData\\Local\n---\n\n---\n\n---\n";
    expect(parseWindowsPathFacts(proper)?.shims).toBe(
      "C:\\Users\\me\\AppData\\Local\\mise\\shims",
    );
  });
});
