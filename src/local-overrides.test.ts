/**
 * The one place a personal setting can actually live.
 *
 * Everything in config/bash is regenerated on every converge, so an
 * alias added to any of it survives until the next install and then
 * quietly does not. Until local.sh there was nowhere in this project to
 * put one and have it stay.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const rc = readFileSync("config/bash/rc.sh", "utf8");
const sharedRoot = readFileSync("src/shared-root.ts", "utf8");

describe("rc.sh sources the override files", () => {
  test("both of them", () => {
    expect(rc).toContain("$RED_SHARE/config/bash/local.sh");
    expect(rc).toContain("$HOME/.config/red-dev/local.sh");
  });

  test("after the generated files, so an override actually overrides", () => {
    // Sourced before them, every alias here would be replaced by the
    // generated aliases.sh a moment later — present in the file and
    // absent from the shell, which is the worst of both.
    const loop = rc.indexOf("for _red_part in path shared build-resources zellij");
    const mine = rc.indexOf("for _red_mine in");
    expect(loop).toBeGreaterThan(-1);
    expect(mine).toBeGreaterThan(loop);
  });

  test("the machine-local one is sourced after the shared one", () => {
    // Shared travels to every machine; local is what is true here and
    // nowhere else. This machine gets the last word about itself.
    const line = rc.slice(rc.indexOf("for _red_mine in"));
    const shared = line.indexOf("RED_SHARE");
    const local = line.indexOf(".config/red-dev/local.sh");
    expect(shared).toBeGreaterThan(-1);
    expect(local).toBeGreaterThan(shared);
  });

  test("the shared one is skipped when there is no share", () => {
    // ${RED_SHARE:+...} expands to the empty string with no share, and
    // the loop body drops an empty entry. Without the guard the loop
    // would try to read "/config/bash/local.sh" at the filesystem root.
    expect(rc).toContain('"${RED_SHARE:+$RED_SHARE/config/bash/local.sh}"');
    expect(rc).toContain('[ -n "$_red_mine" ]');
  });

  test("a missing file is not an error", () => {
    // Neither is created on a machine that never opted into a share,
    // and an unreadable one must not break every shell on the box.
    expect(rc).toContain('[ -r "$_red_mine" ]');
  });
});

describe("the template red-dev leaves behind", () => {
  test("is created once and never rewritten", () => {
    // The whole value of the file is that converge does not touch it.
    expect(sharedRoot).toContain("if (existsSync(file)) return;");
  });

  test("carries content, so it can be found at all", () => {
    // An empty directory is not discoverable, and nobody guesses a path
    // they were never shown.
    expect(sharedRoot).toContain("LOCAL_TEMPLATE");
    expect(sharedRoot).toContain("red-dev created this file once");
  });

  test("points at the machine-local file for machine-local things", () => {
    expect(sharedRoot).toContain("~/.config/red-dev/local.sh instead");
  });
});
