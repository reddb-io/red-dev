/**
 * The one tool where a version gap is a compatibility gap.
 *
 * apt ships Blender 4.0.2 on Ubuntu 24.04 and winget ships 5.2.0. For
 * most of the manifest that difference is a shrug. Here a .blend written
 * on the Windows half of a machine does not open on the WSL half, which
 * makes "installed on both" worse than "installed on one".
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TOOLS, providerFor } from "./manifest.ts";
import type { Platform } from "./platform.ts";

function platform(over: Partial<Platform>): Platform {
  return {
    os: "linux",
    distro: "ubuntu",
    version: "24.04",
    codename: "noble",
    env: "desktop",
    arch: "x64",
    caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
    ...over,
  } as Platform;
}

const tool = TOOLS.find((t) => t.name === "blender");

describe("where blender sits", () => {
  test("is offered rather than installed by default", () => {
    // 1.2 GB. Everything else in the manifest that is not optional is
    // measured in megabytes.
    expect(tool?.scope).toBe("optional");
  });

  test("says what it costs, where the question is asked", () => {
    // The Tools step arrives with everything ticked, so the description
    // is the only thing standing between a reader and a gigabyte.
    expect(tool?.about).toContain("1.2 GB");
  });

  test("does not come from apt, which is two majors behind", () => {
    // The whole reason this is a builtin. apt would install 4.0.2 next
    // to a Windows 5.2.0 and neither could open the other's files.
    expect(providerFor(tool!, platform({}))).toEqual({ kind: "builtin", name: "blender" });
    expect(JSON.stringify(tool)).not.toContain('"apt"');
  });

  test("uses winget on Windows, where the official build is current", () => {
    const win = platform({
      os: "windows",
      env: "windows",
      caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
    });
    expect(providerFor(tool!, win)).toEqual({
      kind: "winget",
      id: "BlenderFoundation.Blender",
    });
  });
});

describe("how the version is chosen", () => {
  const src = readFileSync("src/blender.ts", "utf8");

  test("is asked of Blender rather than written down here", () => {
    // A pinned version is wrong the week after it is written, and wrong
    // silently: the converge keeps installing an old build and keeps
    // reporting success.
    expect(src).toContain("download.blender.org/release/");
    expect(src).not.toMatch(/const \w*VERSION\w* = ['"]\d+\.\d+/);
  });

  test("sorts numerically, so 5.10 beats 5.2", () => {
    // Lexically, "Blender5.10" sorts before "Blender5.2". That bug
    // would surface roughly two years from now, on a machine nobody is
    // watching.
    expect(src).toContain("a.major - b.major");
    expect(src).toContain("a.minor - b.minor");
  });

  test("extracts the tree whole instead of lifting the binary out", () => {
    // Blender is python, datafiles and shared objects around an
    // executable. A binary copied out of it starts and then cannot find
    // its own runtime.
    expect(src).toContain("--strip-components=1");
    expect(src).toContain("ln -sf".replace(" ", '", "'));
  });

  test("skips when the installed version already matches", () => {
    expect(src).toContain("already installed");
  });

  test("publishes a desktop entry, which is what WSLg puts in the Start Menu", () => {
    expect(src).toContain("blender.desktop");
  });
});
