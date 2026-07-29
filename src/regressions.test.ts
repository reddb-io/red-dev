/**
 * Tests for the bugs that actually shipped.
 *
 * Each of these was found by a user running the tool, not by a test —
 * and each was invisible in every green build beforehand. They are
 * grouped here rather than scattered because what they have in common
 * is the useful part: all three failed silently, producing plausible
 * output that happened to be wrong.
 */

import { describe, expect, test } from "bun:test";
import { wingetArgv } from "./providers.ts";

describe("winget invocation", () => {
  /**
   * winget is an APPEXECLINK reparse point. A process cannot exec one,
   * not by name and not by the absolute path where.exe returns, so
   * every winget install on native Windows failed with "Executable not
   * found in $PATH" while `caps: winget=1` insisted it was there.
   * cmd.exe resolves execution aliases; nothing else here does.
   */
  test("goes through cmd.exe on native Windows", () => {
    const argv = wingetArgv(["install", "--id", "Foo.Bar"], "win32");
    expect(argv.slice(0, 3)).toEqual(["cmd.exe", "/c", "winget"]);
    expect(argv).toContain("Foo.Bar");
  });

  test("calls winget.exe directly from WSL, where interop makes it a normal binary", () => {
    const argv = wingetArgv(["install", "--id", "Foo.Bar"], "linux");
    expect(argv[0]).toMatch(/winget\.exe$/);
    expect(argv[1]).toBe("install");
  });

  test("passes arguments through unchanged on both", () => {
    const args = ["upgrade", "--all", "--silent"];
    expect(wingetArgv(args, "win32").slice(3)).toEqual(args);
    expect(wingetArgv(args, "linux").slice(1)).toEqual(args);
  });
});

/**
 * The `next` channel served the stable release to everyone who asked
 * for it, because /releases is not ordered newest-prerelease-first and
 * boot.sh took element zero.
 *
 * Testing the awk directly rather than the whole bootstrap: the shell
 * around it is a download and a chmod, and the part that was wrong is
 * the extraction.
 */
describe("boot.sh next-channel selection", () => {
  // Field order matches GitHub's: tag_name, then prerelease, then
  // assets. Getting that order wrong is what made the first attempt
  // read the previous release's flag.
  const FIXTURE = JSON.stringify([
    {
      tag_name: "v1.0.0",
      prerelease: false,
      assets: [
        { name: "red-dev-linux-x64", browser_download_url: "https://x/v1.0.0/red-dev-linux-x64" },
      ],
    },
    {
      tag_name: "v1.0.1-next.9",
      prerelease: true,
      assets: [
        { name: "checksums.txt", browser_download_url: "https://x/v1.0.1-next.9/checksums.txt" },
        {
          name: "red-dev-linux-x64",
          browser_download_url: "https://x/v1.0.1-next.9/red-dev-linux-x64",
        },
      ],
    },
    {
      tag_name: "v1.0.1-next.8",
      prerelease: true,
      assets: [
        {
          name: "red-dev-linux-x64",
          browser_download_url: "https://x/v1.0.1-next.8/red-dev-linux-x64",
        },
      ],
    },
  ]);

  const AWK = `
    /"prerelease"[[:space:]]*:[[:space:]]*true/  { pre = 1; next }
    /"prerelease"[[:space:]]*:[[:space:]]*false/ { pre = 0; next }
    pre && /"browser_download_url"/ {
      n = split($0, q, "\\"")
      if (n >= 4 && q[4] ~ ("/" asset "$")) { print q[4]; exit }
    }
  `;

  function pick(json: string, asset: string): string {
    const proc = Bun.spawnSync([
      "sh",
      "-c",
      `printf '%s' "$1" | tr '{},' '\\n' | awk -v asset="$2" '${AWK}'`,
      "sh",
      json,
      asset,
    ]);
    return new TextDecoder().decode(proc.stdout).trim();
  }

  test("picks the newest prerelease, not the first release listed", () => {
    // The stable is first in the array; taking [0] is what shipped a
    // binary three fixes behind to everyone who asked for next.
    expect(pick(FIXTURE, "red-dev-linux-x64")).toBe(
      "https://x/v1.0.1-next.9/red-dev-linux-x64",
    );
  });

  test("does not settle for another asset in the right release", () => {
    // checksums.txt precedes the binary inside the same release, so a
    // matcher that ignores the asset name returns the wrong file.
    expect(pick(FIXTURE, "red-dev-linux-x64")).not.toContain("checksums");
  });

  test("returns nothing when no prerelease carries the asset", () => {
    const onlyStable = JSON.stringify([
      {
        tag_name: "v1.0.0",
        prerelease: false,
        assets: [{ name: "red-dev-linux-x64", browser_download_url: "https://x/a" }],
      },
    ]);
    // Empty is correct here: the caller reports which assets exist,
    // which beats downloading the stable while claiming it is next.
    expect(pick(onlyStable, "red-dev-linux-x64")).toBe("");
  });

  test("extraction survives POSIX awk, which has no backreferences", () => {
    // sub(/.../, "\\1") silently yields the literal string, so every
    // URL became "\1" and nothing matched, with no error anywhere.
    const url = pick(FIXTURE, "red-dev-linux-x64");
    expect(url).toStartWith("https://");
    expect(url).not.toContain("\\1");
  });
});
