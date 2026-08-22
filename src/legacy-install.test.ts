/**
 * Installs from before red-dev's standard — and the loop this must not be.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSpec } from "./agents.ts";
import type { Platform } from "./platform.ts";
import { backupAgentConfig, canonicalPath, findLegacyCopies, retireLegacyInstalls } from "./legacy-install.ts";

const CAPS = { apt: true, gui: false, systemd: true, winget: false, flatpak: false };
const WSL: Platform = {
  os: "linux", distro: "ubuntu", version: "24.04", codename: "noble",
  env: "wsl", arch: "x64", caps: CAPS,
};

const REDCODE: AgentSpec = {
  key: "redcode",
  label: "RedCode",
  about: "",
  cmd: "redcode",
  recommended: true,
  configFiles: [".config/redcode/opencode.json"],
  release: { repo: "reddb-io/redcode", linux: { x64: "a.tar.gz" }, windows: {} },
};

function machine() {
  const root = mkdtempSync(join(tmpdir(), "red-legacy-"));
  const bin = join(root, "local", "bin");
  const npmBin = join(root, "node", "lib", "node_modules", "@reddb-io", "redcode", "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(npmBin, { recursive: true });
  writeFileSync(join(bin, "redcode"), "#!/bin/sh\n# 0.11.0\n");
  writeFileSync(join(npmBin, "redcode"), "#!/bin/sh\n# 0.8.1\n");
  mkdirSync(join(root, ".config", "redcode"), { recursive: true });
  writeFileSync(join(root, ".config", "redcode", "opencode.json"), '{"model":"mine"}');
  return { root, bin, npmBin };
}

function scan(m: ReturnType<typeof machine>, over: Record<string, unknown> = {}) {
  return {
    hosts: [REDCODE],
    platform: WSL,
    bin: m.bin,
    method: () => "github-release",
    // PATH order: npm's copy first, exactly as `mise activate` leaves it.
    lookup: () => [join(m.npmBin, "redcode"), join(m.bin, "redcode")],
    npmGlobals: new Set(["@reddb-io/redcode"]),
    ...over,
  };
}

describe("what the mechanism in use today owns", () => {
  test("a release host has a canonical path; the others have none", () => {
    expect(canonicalPath(REDCODE, "github-release", "/b", "linux")).toBe("/b/redcode");
    expect(canonicalPath(REDCODE, "github-release", "C:/b", "windows")).toBe("C:/b/redcode.exe");
    // npm, winget and a vendor installer each own their own resolution.
    // Without a canonical copy there is nothing to call the others
    // legacy against, and guessing is the loop this avoids.
    expect(canonicalPath(REDCODE, "npm", "/b", "linux")).toBeNull();
    expect(canonicalPath(REDCODE, "installer", "/b", "linux")).toBeNull();
    expect(canonicalPath(REDCODE, null, "/b", "linux")).toBeNull();
  });
});

describe("finding what is left over", () => {
  test("the npm copy is found, and named with its package", () => {
    const m = machine();
    const found = findLegacyCopies(scan(m));
    expect(found).toHaveLength(1);
    expect(found[0]?.owner).toBe("@reddb-io/redcode");
    expect(found[0]?.canonical).toBe(join(m.bin, "redcode"));
  });

  test("red-dev's own installation is never legacy", () => {
    const m = machine();
    // The canonical copy alone: a machine already in order.
    const found = findLegacyCopies(scan(m, { lookup: () => [join(m.bin, "redcode")] }));
    expect(found).toEqual([]);
  });

  test("a copy npm does not own is found but not attributed", () => {
    const m = machine();
    const found = findLegacyCopies(scan(m, { npmGlobals: new Set<string>() }));
    expect(found).toHaveLength(1);
    expect(found[0]?.owner).toBeNull();
  });
});

describe("retiring it", () => {
  const harness = (m: ReturnType<typeof machine>, over: Record<string, unknown> = {}) => {
    const ran: string[][] = [];
    return {
      ran,
      opts: {
        ...scan(m),
        home: m.root,
        backupDir: join(m.root, "backup"),
        npm: "/usr/bin/npm",
        mise: "/usr/bin/mise",
        specOf: () => REDCODE,
        run: async (argv: string[]) => {
          ran.push(argv);
          return 0;
        },
        ...over,
      },
    };
  };

  test("configuration is copied aside before the package goes", async () => {
    const m = machine();
    const h = harness(m);
    const out = await retireLegacyInstalls(h.opts);

    expect(out).toHaveLength(1);
    expect(out[0]?.outcome).toBe("retired");
    const copied = join(m.root, "backup", "redcode", ".config", "redcode", "opencode.json");
    expect(existsSync(copied)).toBe(true);
    expect(readFileSync(copied, "utf8")).toBe('{"model":"mine"}');
    expect(h.ran.map((a) => a.join(" "))).toEqual([
      "/usr/bin/npm uninstall -g @reddb-io/redcode",
      "/usr/bin/mise reshim",
    ]);
  });

  test("a machine already in order writes nothing and removes nothing", async () => {
    const m = machine();
    const h = harness(m, { lookup: () => [join(m.bin, "redcode")] });
    const out = await retireLegacyInstalls(h.opts);

    expect(out).toEqual([]);
    expect(h.ran).toEqual([]);
    // The whole point: no backup directory is even created, so a second
    // run is indistinguishable from a machine that never had a leftover.
    expect(existsSync(join(m.root, "backup"))).toBe(false);
  });

  test("running it twice is running it once", async () => {
    const m = machine();
    const h = harness(m);
    await retireLegacyInstalls(h.opts);
    const before = h.ran.length;

    // The second pass sees what the first left: the canonical copy only.
    const second = harness(m, { lookup: () => [join(m.bin, "redcode")] });
    expect(await retireLegacyInstalls(second.opts)).toEqual([]);
    expect(second.ran).toEqual([]);
    expect(before).toBe(2);
  });

  test("what red-dev cannot identify is reported, never removed", async () => {
    const m = machine();
    const h = harness(m, { npmGlobals: new Set<string>() });
    const out = await retireLegacyInstalls(h.opts);

    expect(out[0]?.outcome).toBe("reported");
    expect(out[0]?.backedUp).toEqual([]);
    expect(h.ran).toEqual([]);
  });
});

describe("what a backup copies", () => {
  test("declared files only, and a missing one is not an error", () => {
    const m = machine();
    const spec = { ...REDCODE, configFiles: [".config/redcode/opencode.json", ".config/redcode/gone.json"] };
    const written = backupAgentConfig(spec, m.root, join(m.root, "b"));
    expect(written).toHaveLength(1);
  });

  test("a host that declares nothing copies nothing", () => {
    const m = machine();
    expect(backupAgentConfig({ ...REDCODE, configFiles: undefined }, m.root, join(m.root, "b"))).toEqual([]);
  });
});

describe("a host that moved from a release to mise", () => {
  const MISED: AgentSpec = { ...REDCODE, mise: "github:reddb-io/redcode" };

  test("mise's shim is canonical, and the release copy becomes the leftover", () => {
    const m = machine();
    const shimPath = join(m.root, "shims", "redcode");
    mkdirSync(join(m.root, "shims"), { recursive: true });
    writeFileSync(shimPath, "#!/bin/sh\n# shim\n");

    const found = findLegacyCopies({
      ...scan(m),
      hosts: [MISED],
      method: () => "mise",
      shim: () => shimPath,
      lookup: () => [join(m.bin, "redcode"), shimPath],
    });

    expect(found).toHaveLength(1);
    // What red-dev placed under the old mechanism, at a path it chose.
    expect(found[0]?.path).toBe(join(m.bin, "redcode"));
    expect(found[0]?.ours).toBe(true);
    expect(found[0]?.canonical).toBe(shimPath);
  });

  test("mise not having placed it yet makes nothing legacy", () => {
    const m = machine();
    // No canonical copy means nothing to call the others legacy against.
    const found = findLegacyCopies({
      ...scan(m),
      hosts: [MISED],
      method: () => "mise",
      shim: () => null,
      lookup: () => [join(m.bin, "redcode")],
    });
    expect(found).toEqual([]);
  });

  test("red-dev removes the copy it placed itself, and backs the config up first", async () => {
    const m = machine();
    const shimPath = join(m.root, "shims", "redcode");
    mkdirSync(join(m.root, "shims"), { recursive: true });
    writeFileSync(shimPath, "#!/bin/sh\n");

    const ran: string[][] = [];
    const out = await retireLegacyInstalls({
      ...scan(m),
      hosts: [MISED],
      method: () => "mise",
      shim: () => shimPath,
      lookup: () => [join(m.bin, "redcode"), shimPath],
      home: m.root,
      backupDir: join(m.root, "backup"),
      npm: "/usr/bin/npm",
      mise: "/usr/bin/mise",
      specOf: () => MISED,
      run: async (argv: string[]) => {
        ran.push(argv);
        return 0;
      },
    });

    expect(out[0]?.outcome).toBe("retired");
    expect(existsSync(join(m.bin, "redcode"))).toBe(false);
    // Its own file, so no package manager is asked to do it.
    expect(ran).toEqual([]);
    expect(existsSync(join(m.root, "backup", "redcode", ".config", "redcode", "opencode.json"))).toBe(
      true,
    );
  });

  test("and once removed, a second run finds nothing", async () => {
    const m = machine();
    const shimPath = join(m.root, "shims", "redcode");
    mkdirSync(join(m.root, "shims"), { recursive: true });
    writeFileSync(shimPath, "#!/bin/sh\n");
    const opts = {
      ...scan(m),
      hosts: [MISED],
      method: () => "mise" as const,
      shim: () => shimPath,
      lookup: () => (existsSync(join(m.bin, "redcode")) ? [join(m.bin, "redcode"), shimPath] : [shimPath]),
      home: m.root,
      backupDir: join(m.root, "backup"),
      npm: "/usr/bin/npm",
      mise: "/usr/bin/mise",
      specOf: () => MISED,
      run: async () => 0,
    };
    await retireLegacyInstalls(opts);
    expect(await retireLegacyInstalls(opts)).toEqual([]);
  });
});
