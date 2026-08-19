/**
 * The record that replaced the build stamp.
 *
 * While both artifacts were built here, the freshness question was "which
 * checkout did this come out of" — neither can be asked its own version,
 * because both report the artifact's rather than the release's. So the
 * build recorded the tree it read.
 *
 * There is no tree any more. The published package stopped carrying
 * monorepo source, and both artifacts now come from the release, so the
 * question is "which release did this come out of" and the record holds a
 * tag. It is also the only artifact on the machine that means "red-dev
 * did this", which is what an uninstall is entitled to act on.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  forgetRecord,
  readRecord,
  resolvedSource,
  sourceRoot,
  writeRecord,
} from "./red-skills-ext.ts";

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
  const dir = `${root}/.red/skills/versions/${version}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/package.json`, JSON.stringify({ name: "red-skills", version }));
  const link = `${root}/.red/skills/current`;
  try {
    unlinkSync(link);
  } catch {
    // First call: there is nothing to unlink yet.
  }
  symlinkSync(dir, link);
}

const recordFile = (root: string) => `${root}/.local/share/red-dev/red-skills-extensions.json`;

describe("the checkout", () => {
  test("is found through the current symlink", () => {
    const root = machine("v3.3.0");
    expect(sourceRoot()).toBe(`${root}/.red/skills/current`);
  });

  test("is absent when red-skills was never installed", () => {
    process.env["HOME"] = mkdtempSync(`${tmpdir()}/red-skills-`);
    expect(sourceRoot()).toBeNull();
    expect(resolvedSource()).toBeNull();
  });

  test("resolves to the version directory, not the symlink", () => {
    // The symlink is the only thing that moves and every version under
    // it is immutable, so the resolved path is the whole freshness
    // question for anything that reads the tree.
    const root = machine("v3.3.0");
    expect(resolvedSource()).toBe(`${root}/.red/skills/versions/v3.3.0`);
  });

  test("neither artifact needs it any more", async () => {
    // The record is written on a machine with no checkout at all. This
    // is the fact the whole slice turns on: `sourceRoot()` being null
    // used to mean "nothing can be installed".
    const root = mkdtempSync(`${tmpdir()}/red-skills-`);
    process.env["HOME"] = root;
    expect(sourceRoot()).toBeNull();

    await writeRecord({ vscode: { tag: "v3.18.12", editors: ["code"] } });
    expect(readRecord().vscode?.tag).toBe("v3.18.12");
  });
});

describe("the install record", () => {
  test("holds the release tag, not a path into a tree", async () => {
    const root = machine("v3.3.0");
    await writeRecord({ vscode: { tag: "v3.18.12", editors: ["code"] } });
    expect(readFileSync(recordFile(root), "utf8")).not.toContain(root);
  });

  test("goes stale exactly when the release moves", async () => {
    // This is the whole mechanism: same tag, nothing to do; newer tag,
    // install again. Both directions, because a check that only ever
    // says "install" is as useless as one that never does.
    machine("v3.3.0");
    await writeRecord({ vscode: { tag: "v3.18.12" } });
    expect(readRecord().vscode?.tag).toBe("v3.18.12");
    expect(readRecord().vscode?.tag).not.toBe("v3.19.0");
  });

  test("keeps the other artifact's entry", async () => {
    // They advance independently: reinstalling the editor extension must
    // not tell the next run that herdr is current too.
    machine("v3.3.0");
    await writeRecord({ herdr: { tag: "v3.18.12" } });
    await writeRecord({ vscode: { tag: "v3.19.0" } });
    expect(readRecord()).toEqual({
      herdr: { tag: "v3.18.12" },
      vscode: { tag: "v3.19.0" },
    });
  });

  test("an unreadable record means install again, not skip", () => {
    const root = machine("v3.3.0");
    mkdirSync(`${root}/.local/share/red-dev`, { recursive: true });
    writeFileSync(recordFile(root), "{ truncated");
    expect(readRecord()).toEqual({});
  });

  test("forgetting one artifact leaves the other standing", async () => {
    machine("v3.3.0");
    await writeRecord({ herdr: { tag: "v3.18.12" }, vscode: { tag: "v3.18.12" } });
    await forgetRecord("vscode");
    expect(readRecord()).toEqual({ herdr: { tag: "v3.18.12" } });
  });

  test("forgetting the last one takes the file with it", async () => {
    const root = machine("v3.3.0");
    await writeRecord({ herdr: { tag: "v3.18.12" } });
    await forgetRecord("herdr");
    // Not an empty object left behind: nothing installed and a file
    // saying so are different states, and only one of them is true.
    expect(existsSync(recordFile(root))).toBe(false);
    expect(readRecord()).toEqual({});
  });
});
