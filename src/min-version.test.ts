/**
 * Version floors: present is not installed when the version is below one.
 *
 * The case that motivated this is neovim. noble's archive ships 0.9.5,
 * LazyVim refuses to start under 0.11.2, and converge reported `present`
 * on every run because a binary named nvim existed. A probe that only
 * asks "is something here" cannot see that.
 *
 * parseVersion and compareVersions are tested directly; installState is
 * covered through the manifest entries rather than by spawning a real
 * binary at a version this machine may or may not have.
 */

import { describe, expect, test } from "bun:test";
import {
  compareVersions,
  installState,
  isInstalled,
  isPresent,
  parseVersion,
  TOOLS,
  type Tool,
} from "./manifest.ts";

describe("parseVersion", () => {
  test("reads the version out of real --version output", () => {
    expect(parseVersion("NVIM v0.9.5")).toBe("0.9.5");
    expect(parseVersion("nvim 0.11.2\nBuild type: Release")).toBe("0.11.2");
    expect(parseVersion("git version 2.43.0")).toBe("2.43.0");
  });

  test("pads a two-segment version rather than rejecting it", () => {
    expect(parseVersion("zellij 0.44")).toBe("0.44.0");
  });

  test("folds the reddb-io fork marker into a fourth segment", () => {
    // Both dialects of the same build: cargo metadata on the binary,
    // a pre-release dash on the tag. They must normalize identically,
    // and differently from the stock release they patch.
    expect(parseVersion("zellij 0.44.3+red.1")).toBe("0.44.3.1");
    expect(parseVersion("v0.44.3-red.1")).toBe("0.44.3.1");
    expect(parseVersion("zellij 0.44.3")).toBe("0.44.3");
  });

  test("returns null when there is no version to find", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("command not found")).toBeNull();
  });
});

describe("compareVersions", () => {
  test("orders by numeric segment, not lexically", () => {
    expect(compareVersions("0.9.5", "0.11.2")).toBe(-1);
    expect(compareVersions("0.11.2", "0.9.5")).toBe(1);
    expect(compareVersions("0.11.2", "0.11.2")).toBe(0);
  });

  test("treats a missing segment as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBe(-1);
  });

  test("does not stop at the first differing digit count", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
  });
});

/**
 * `bun` rather than a manifest tool: these assertions need a binary that
 * is certainly present and certainly prints a version, and the process
 * running the test is exactly that.
 */
function bunWithFloor(min: string): Tool {
  return {
    name: "bun",
    cmd: ["bun"],
    minVersion: min,
    scope: "core",
    u24: { kind: "apt", pkg: "bun" },
    win: { kind: "skip", reason: "not under test" },
  };
}

describe("installState", () => {
  test("a version above the floor is ok", () => {
    expect(installState(bunWithFloor("0.0.1"))).toBe("ok");
    expect(isInstalled(bunWithFloor("0.0.1"))).toBe(true);
  });

  test("a version below the floor is outdated, not absent", () => {
    expect(installState(bunWithFloor("999.0.0"))).toBe("outdated");
  });

  test("a command that does not exist is absent", () => {
    const ghost = { ...bunWithFloor("0.0.1"), cmd: ["red-dev-no-such-binary"] };
    expect(installState(ghost)).toBe("absent");
    expect(isPresent(ghost)).toBe(false);
  });
});

describe("isPresent vs isInstalled", () => {
  test("an outdated tool is not installed but is still present", () => {
    // The uninstall list is built from isPresent. Were it built from
    // isInstalled, a tool below its floor would disappear from it while
    // sitting on disk — no way to remove the thing the doctor flags.
    const stale = bunWithFloor("999.0.0");
    expect(isInstalled(stale)).toBe(false);
    expect(isPresent(stale)).toBe(true);
  });
});

describe("the neovim floor", () => {
  test("is declared, and is LazyVim's", () => {
    const nvim = TOOLS.find((t) => t.name === "neovim");
    expect(nvim?.minVersion).toBe("0.11.2");
  });

  test("rejects what the noble archive ships", () => {
    expect(compareVersions("0.9.5", "0.11.2")).toBeLessThan(0);
  });
});
