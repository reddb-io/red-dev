/**
 * Shadowed copies: the failure where every step succeeds.
 *
 * mise installs the new version and says so; the shell keeps running an
 * older copy that comes first on PATH. Nothing errors, the report is
 * green, and the version people see never moves.
 *
 * The lookup is injected, so these run on a machine with none of these
 * tools installed and no duplicates to arrange — including the case
 * taken from the machine this was written on, where tq resolved to a
 * cargo build shadowing an older ~/.local/bin copy.
 */

import { describe, expect, test } from "bun:test";
import { describeShadowed, findShadowed, type ShadowedTool } from "./shadowed.ts";
import { TOOLS } from "./manifest.ts";
import type { Platform } from "./platform.ts";

const UBUNTU: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false },
};

const MISE_ROOT = "/home/u/.local/share/mise/installs";

describe("findShadowed", () => {
  test("one copy is not a conflict", () => {
    const found = findShadowed(UBUNTU, () => ["/usr/local/bin/tq"], TOOLS, MISE_ROOT);
    expect(found).toHaveLength(0);
  });

  test("nothing on PATH is not a conflict either — that is `missing`, reported elsewhere", () => {
    expect(findShadowed(UBUNTU, () => [], TOOLS, MISE_ROOT)).toHaveLength(0);
  });

  test("two copies of a mise tool are reported, winner first", () => {
    const found = findShadowed(
      UBUNTU,
      (name) => (name === "tq" ? ["/home/u/.cargo/bin/tq", "/home/u/.local/bin/tq"] : []),
      TOOLS,
      MISE_ROOT,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe("tq");
    expect(found[0]?.copies[0]).toBe("/home/u/.cargo/bin/tq");
  });

  test("tools mise does not own are not this check's business", () => {
    // git has two copies on plenty of machines and it means nothing
    // here: no upgrade path of ours is being defeated by it.
    const found = findShadowed(
      UBUNTU,
      (name) => (name === "git" ? ["/usr/bin/git", "/usr/local/bin/git"] : []),
      TOOLS,
      MISE_ROOT,
    );
    expect(found).toHaveLength(0);
  });

  test("a namesake that is a different program is not a copy", () => {
    // Ubuntu's /usr/bin/red is GNU ed's restricted mode. Reporting it
    // as a stale RedDB CLI would put "remove /usr/bin/red" in front of
    // someone as a fix — advice to delete part of the base system.
    const found = findShadowed(
      UBUNTU,
      (name) => (name === "red" ? ["/usr/bin/red", "/home/u/.local/bin/red"] : []),
      TOOLS,
      MISE_ROOT,
      (path) => path !== "/usr/bin/red",
    );
    expect(found).toHaveLength(0);
  });

  test("the mise copy is identified even when it loses", () => {
    const found = findShadowed(
      UBUNTU,
      (name) =>
        name === "red"
          ? ["/home/u/.local/bin/red", `${MISE_ROOT}/github-reddb-io-reddb/1.23.2/red`]
          : [],
      TOOLS,
      MISE_ROOT,
      () => true,
    );
    expect(found[0]?.managedDir).toBe(`${MISE_ROOT}/github-reddb-io-reddb/1.23.2`);
  });
});

describe("describeShadowed", () => {
  test("a losing mise copy says an upgrade will miss the copy in use", () => {
    const s: ShadowedTool = {
      name: "red",
      copies: ["/home/u/.local/bin/red", `${MISE_ROOT}/github-reddb-io-reddb/1.23.2/red`],
      managedDir: `${MISE_ROOT}/github-reddb-io-reddb/1.23.2`,
    };
    const [row] = describeShadowed([s]);
    expect(row?.detail).toContain("/home/u/.local/bin/red");
    expect(row?.detail).toContain("not running");
    expect(row?.fix).toContain("remove /home/u/.local/bin/red");
  });

  test("the real case from this machine names both copies", () => {
    // tq 0.26.2 from cargo shadowing tq 0.20.0 in ~/.local/bin, with
    // 0.28.2 published. Neither current, and no check saw it.
    const [row] = describeShadowed([
      {
        name: "tq",
        copies: ["/home/u/.cargo/bin/tq", "/home/u/.local/bin/tq"],
        managedDir: null,
      },
    ]);
    expect(row?.detail).toContain("/home/u/.cargo/bin/tq");
    expect(row?.detail).toContain("/home/u/.local/bin/tq");
    expect(row?.kind).toBe("warning");
  });

  test("it counts copies rather than saying 1 copies", () => {
    const [one] = describeShadowed([
      { name: "tq", copies: ["/a/tq", "/b/tq"], managedDir: null },
    ]);
    const [two] = describeShadowed([
      { name: "tq", copies: ["/a/tq", "/b/tq", "/c/tq"], managedDir: null },
    ]);
    expect(one?.detail).toContain("1 other copy");
    expect(two?.detail).toContain("2 other copies");
  });

  test("nothing found says nothing", () => {
    expect(describeShadowed([])).toHaveLength(0);
  });
});
