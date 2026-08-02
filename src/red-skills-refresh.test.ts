/**
 * The two artifacts built from a checkout nothing advanced.
 *
 * `~/.red-skills/current` froze at the version that first wired the
 * machine: convergeRedSkills asks whether red-skills is *wired*, a wired
 * machine has nothing left to do, and so update never re-ran the
 * installer. Meanwhile Claude's own plugin cache kept updating through
 * the marketplace, so the daemon answered a newer version than the tree
 * the vscode extension and the herdr plugin were built from — two
 * copies, one moving, and everything here built out of the still one.
 *
 * Neither artifact can be asked about it: both declare version 0.1.0 and
 * have declared 0.1.0 across every red-skills release, so asking the
 * editor or herdr answers about the artifact rather than its source. The
 * build records which checkout it read instead, and that record is what
 * these cover.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readStamp, recordBuild, resolvedSource, sourceRoot } from "./red-skills-ext.ts";

const saved = process.env["HOME"];

afterEach(() => {
  if (saved === undefined) delete process.env["HOME"];
  else process.env["HOME"] = saved;
});

/** A machine with red-skills at `version`, and `current` pointing there. */
function machine(version: string): string {
  const root = mkdtempSync(`${tmpdir()}/red-skills-`);
  process.env["HOME"] = root;
  point(root, version);
  return root;
}

/** What the installer does when it lands a newer tarball. */
function point(root: string, version: string): void {
  const dir = `${root}/.red-skills/versions/${version}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/package.json`, JSON.stringify({ name: "red-skills", version }));
  const link = `${root}/.red-skills/current`;
  try {
    unlinkSync(link);
  } catch {
    // First call: there is nothing to unlink yet.
  }
  symlinkSync(dir, link);
}

const stampFile = (root: string) =>
  readFileSync(`${root}/.local/share/red-dev/red-skills-built.json`, "utf8");

describe("the checkout", () => {
  test("is found through the current symlink", () => {
    const root = machine("v3.3.0");
    expect(sourceRoot()).toBe(`${root}/.red-skills/current`);
  });

  test("is absent when red-skills was never installed", () => {
    process.env["HOME"] = mkdtempSync(`${tmpdir()}/red-skills-`);
    expect(sourceRoot()).toBeNull();
    expect(resolvedSource()).toBeNull();
  });

  test("resolves to the version directory, not the symlink", () => {
    // The symlink is the only thing that moves and every version under
    // it is immutable. Recording the symlink path would compare equal
    // to itself forever and rebuild nothing, ever.
    const root = machine("v3.3.0");
    expect(resolvedSource()).toBe(`${root}/.red-skills/versions/v3.3.0`);
  });
});

describe("the build stamp", () => {
  test("records where the build read from", async () => {
    const root = machine("v3.3.0");
    await recordBuild("vscode");
    expect(readStamp().vscode).toBe(`${root}/.red-skills/versions/v3.3.0`);
    expect(stampFile(root)).not.toContain("current");
  });

  test("goes stale exactly when current moves", async () => {
    // This is the whole mechanism: same tree, nothing to do; advanced
    // tree, rebuild. Both directions, because a check that only ever
    // says "rebuild" is as useless as one that never does.
    machine("v3.3.0");
    await recordBuild("vscode");
    expect(readStamp().vscode).toBe(resolvedSource() as string);

    point(process.env["HOME"] as string, "v3.4.0");
    expect(readStamp().vscode).not.toBe(resolvedSource());
  });

  test("keeps the other artifact's entry", async () => {
    // They advance independently: rebuilding the editor extension must
    // not tell the next run that herdr is current too.
    machine("v3.3.0");
    await recordBuild("herdr");
    await recordBuild("vscode");
    expect(readStamp()).toEqual({ herdr: resolvedSource() as string, vscode: resolvedSource() as string });
  });

  test("an unreadable stamp means rebuild, not skip", async () => {
    const root = machine("v3.3.0");
    mkdirSync(`${root}/.local/share/red-dev`, { recursive: true });
    writeFileSync(`${root}/.local/share/red-dev/red-skills-built.json`, "{ truncated");
    expect(readStamp()).toEqual({});
  });

  test("nothing is recorded when there is no checkout", async () => {
    const root = mkdtempSync(`${tmpdir()}/red-skills-`);
    process.env["HOME"] = root;
    await recordBuild("vscode");
    expect(readStamp()).toEqual({});
  });
});
