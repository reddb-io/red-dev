/**
 * The same directory has three names, which is one more than anyone
 * expects and is where this feature would quietly break.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  adoptableTools,
  defaultRoot,
  legacyRoot,
  localPath,
  namespaceMove,
} from "./shared-root.ts";

describe("localPath", () => {
  const win = "C:\\Users\\filip\\.red\\dev";

  test("WSL reaches it under /mnt", () => {
    expect(localPath(win, "wsl")).toBe("/mnt/c/Users/filip/.red/dev");
  });

  test("on Windows the binary gets the native path, not the Git Bash one", () => {
    // The bug this replaces: `/c/Users/...` is right for Git Bash and
    // wrong for a native process, and handing it here made red-dev
    // create C:\c\Users\filip\.red\dev — a phantom tree beside the real
    // one, reported as "7 new" on a share that already existed. The
    // Git Bash spelling belongs to config/bash/rc.sh and nowhere else.
    expect(localPath(win, "windows")).toBe(win);
  });

  test("a Linux desktop has no Windows drive, so it is left alone", () => {
    expect(localPath(win, "desktop")).toBe(win);
  });

  test("the drive letter is lowercased, as both mounts spell it", () => {
    expect(localPath("D:\\share", "wsl")).toBe("/mnt/d/share");
  });

  test("forward slashes survive, since Windows accepts both", () => {
    expect(localPath("C:/Users/filip/.red/dev", "wsl")).toBe("/mnt/c/Users/filip/.red/dev");
  });

  test("something that is not a Windows path is returned unchanged", () => {
    expect(localPath("/home/cyber/share", "wsl")).toBe("/home/cyber/share");
  });
});

describe("the share tree", () => {
  test("does not pre-create the per-tool config directories", () => {
    // Creating them empty made "does it exist" meaningless in two
    // places at once: a brand new root reported five tools as shared,
    // and `share adopt zellij` refused with "already shared" over an
    // empty directory. A tool's directory appears when its config does.
    const src = readFileSync("src/shared-root.ts", "utf8");
    const tree = /const TREE = \[([^\]]*)\]/.exec(src)?.[1] ?? "";
    for (const tool of adoptableTools()) {
      expect(tree).not.toContain(`config/${tool}`);
    }
    expect(tree).toContain('"config"');
    // bin stays split by format, because that part is not optional.
    expect(tree).toContain("bin/linux");
    expect(tree).toContain("bin/windows");
  });
});

describe("defaultRoot", () => {
  test("inside the profile, so it goes when the profile goes", () => {
    expect(defaultRoot("C:\\Users\\filip")).toBe("C:\\Users\\filip\\.red\\dev");
  });

  test("a trailing separator does not double up", () => {
    expect(defaultRoot("C:\\Users\\filip\\")).toBe("C:\\Users\\filip\\.red\\dev");
  });

  test("lives under the .red namespace the rest of the toolchain uses", () => {
    // The point of the move: one dotfile per namespace, not one per
    // product. A future red-* tool gets .red\<name> for free.
    expect(defaultRoot("C:\\Users\\filip")).toContain("\\.red\\");
  });

  test("the legacy spelling is still spelled out, for the migration", () => {
    // The migration needs to recognise the old root to move it. Losing
    // this constant would leave those machines silently on the old tree.
    expect(legacyRoot("C:\\Users\\filip")).toBe("C:\\Users\\filip\\.reddev");
    expect(legacyRoot("C:\\Users\\filip")).not.toBe(defaultRoot("C:\\Users\\filip"));
  });
});

/**
 * This decides whether a migration copies someone's whole config
 * directory somewhere else, unattended, during an install. The tests
 * that matter here are the ones that say *no*.
 */
describe("namespaceMove", () => {
  const profile = "C:\\Users\\filip";

  test("the old default is moved into the namespace", () => {
    expect(namespaceMove("C:\\Users\\filip\\.reddev", profile)).toEqual({
      from: "C:\\Users\\filip\\.reddev",
      to: "C:\\Users\\filip\\.red\\dev",
    });
  });

  test("a root already in the namespace is left alone", () => {
    expect(namespaceMove("C:\\Users\\filip\\.red\\dev", profile)).toBeNull();
  });

  test("a root the user put somewhere else is theirs, even named .reddev", () => {
    // The spelling is not the trigger; being the default this project
    // wrote is. Moving D:\work\.reddev because the tail looks familiar
    // relocates a directory out from under a deliberate choice.
    expect(namespaceMove("D:\\work\\.reddev", profile)).toBeNull();
  });

  test("no recorded root means nothing to move", () => {
    expect(namespaceMove(null, profile)).toBeNull();
  });

  test("matches case-insensitively, as Windows paths compare", () => {
    // A root recorded as C:\Users\Filip\... against a profile reported
    // as C:\Users\filip is one directory, not two.
    expect(namespaceMove("C:\\Users\\Filip\\.RedDev", profile)?.to).toBe(
      "C:\\Users\\filip\\.red\\dev",
    );
  });

  test("a trailing separator does not defeat the match", () => {
    expect(namespaceMove("C:\\Users\\filip\\.reddev\\", profile)).toEqual({
      from: "C:\\Users\\filip\\.reddev",
      to: "C:\\Users\\filip\\.red\\dev",
    });
  });
});
