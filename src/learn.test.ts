/**
 * A link to a heading that no longer exists is a link to the top of a
 * sixty-kilobyte page, and nothing anywhere reports it.
 *
 * That is the whole reason this file reads the README. The Learn section
 * offers the documentation *by anchor*, which is only worth more than
 * one "docs" link for as long as the anchors land; a heading renamed in
 * a docs pass would leave six entries silently pointing at the front
 * page. The README is in this repository, so the check is cheap and the
 * rename fails here rather than on somebody's machine.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { anchor, browseArgv, LEARN, learnLines } from "./learn.ts";
import type { Platform } from "./platform.ts";

const readme = readFileSync("README.md", "utf8");

/** Every anchor GitHub would generate for this README's own headings. */
const headings = new Set(
  readme
    .split("\n")
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => anchor(line.replace(/^#+ /, ""))),
);

function machine(over: Partial<Platform>): Platform {
  return {
    os: "linux",
    distro: "ubuntu",
    version: "24.04",
    codename: "noble",
    env: "desktop",
    arch: "x64",
    caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
    ...over,
  };
}

describe("the README, by anchor", () => {
  test("there are sections to check", () => {
    expect(LEARN.filter((e) => e.key.startsWith("readme.")).length).toBeGreaterThan(3);
  });

  for (const entry of LEARN.filter((e) => e.key.startsWith("readme."))) {
    test(`${entry.label} points at a heading the README still has`, () => {
      const fragment = entry.url?.split("#")[1];
      expect(fragment).toBeDefined();
      expect(headings.has(fragment!)).toBe(true);
    });
  }

  test("anchors are folded the way GitHub folds them", () => {
    expect(anchor("Quick start")).toBe("quick-start");
    expect(anchor("Under the hood")).toBe("under-the-hood");
    expect(anchor("Themes & colour")).toBe("themes--colour");
  });
});

describe("what else Learn carries", () => {
  test("RedSkills, because it is the other half of what gets installed", () => {
    const skills = LEARN.find((e) => e.key === "red-skills");
    expect(skills?.url).toBe("https://github.com/reddb-io/red-skills");
  });

  test("and the keys viewer itself, which is a surface rather than a link", () => {
    // The one entry that answers a question about *this* machine. A URL
    // here would be the wrong answer to "which key does that".
    const keys = LEARN.find((e) => e.key === "keys");
    expect(keys).toBeDefined();
    expect(keys?.url).toBeNull();
    expect(learnLines([keys!])[0]).toContain("red-dev keys");
  });

  test("every entry is printable, with somewhere to go on the line", () => {
    const lines = learnLines();
    expect(lines).toHaveLength(LEARN.length);
    for (const line of lines) expect(line).toMatch(/https:\/\/|red-dev keys/);
  });
});

describe("opening a link", () => {
  test("Windows and WSL both go through the shell launcher", () => {
    for (const env of ["windows", "wsl"] as const) {
      expect(browseArgv("https://example.com", machine({ env }), () => null)).toEqual([
        "cmd.exe",
        "/c",
        "start",
        "",
        "https://example.com",
      ]);
    }
  });

  test("a desktop uses xdg-open when it has one", () => {
    expect(browseArgv("https://example.com", machine({}), (cmd) => `/usr/bin/${cmd}`)).toEqual([
      "xdg-open",
      "https://example.com",
    ]);
    expect(browseArgv("https://example.com", machine({}), () => null)).toBeNull();
  });

  test("and a server has nothing to open it with, which is an answer", () => {
    // Not a failure to report: printing the URL is what a headless
    // machine can actually use.
    expect(browseArgv("https://example.com", machine({ env: "server" }), () => "/usr/bin/x")).toBeNull();
  });
});
