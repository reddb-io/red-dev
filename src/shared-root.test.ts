/**
 * The same directory has three names, which is one more than anyone
 * expects and is where this feature would quietly break.
 */

import { describe, expect, test } from "bun:test";
import { defaultRoot, localPath } from "./shared-root.ts";

describe("localPath", () => {
  const win = "C:\\Users\\filip\\.reddev";

  test("WSL reaches it under /mnt", () => {
    expect(localPath(win, "wsl")).toBe("/mnt/c/Users/filip/.reddev");
  });

  test("on Windows the binary gets the native path, not the Git Bash one", () => {
    // The bug this replaces: `/c/Users/...` is right for Git Bash and
    // wrong for a native process, and handing it here made red-dev
    // create C:\c\Users\filip\.reddev — a phantom tree beside the real
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
    expect(localPath("C:/Users/filip/.reddev", "wsl")).toBe("/mnt/c/Users/filip/.reddev");
  });

  test("something that is not a Windows path is returned unchanged", () => {
    expect(localPath("/home/cyber/share", "wsl")).toBe("/home/cyber/share");
  });
});

describe("defaultRoot", () => {
  test("inside the profile, so it goes when the profile goes", () => {
    expect(defaultRoot("C:\\Users\\filip")).toBe("C:\\Users\\filip\\.reddev");
  });

  test("a trailing separator does not double up", () => {
    expect(defaultRoot("C:\\Users\\filip\\")).toBe("C:\\Users\\filip\\.reddev");
  });
});
