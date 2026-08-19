/**
 * `~/.red/skills` is the root, and a machine provisioned under the old
 * `~/.red-skills` is moved there once.
 *
 * The move is pinned on a fake home: the tree is renamed rather than
 * copied, the absolute `current`/`previous` pointers are re-pointed into
 * the new root, the reconcile stamp is cleared so the hosts are wired
 * again at the new path, and nothing is left at the old name. A home
 * that already has the new root keeps both untouched.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MIGRATIONS } from "./migrations.ts";
import { inventoryLegacyWorkstation } from "./red-skills-adopt.ts";
import {
  legacyRedSkillsRoot,
  redSkillsCurrent,
  redSkillsCurrentPosix,
  redSkillsRoot,
  redSkillsRootPosix,
  relocateLegacyRedSkillsRoot,
} from "./red-skills-root.ts";

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "red-skills-root-"));
}

/** The shape the old root had on a machine that acquired one revision. */
function legacyTree(home: string): { set: string } {
  const legacy = legacyRedSkillsRoot(home);
  const set = join(legacy, "sets", "3.19.5+bc45c2f863eb");
  mkdirSync(join(set, "plugins", "dev"), { recursive: true });
  writeFileSync(join(set, "package.json"), '{"name":"@reddb-io/red-skills","version":"3.19.5"}');
  symlinkSync(set, join(legacy, "current"), "dir");
  symlinkSync(join(legacy, "sets", "3.19.4+000000000000"), join(legacy, "previous"), "dir");
  writeFileSync(join(legacy, "package-set.json"), '{"schema":1}');
  writeFileSync(join(legacy, "reconciled.json"), '{"schema":1,"key":"3.19.5+bc45c2f863eb"}');
  mkdirSync(join(legacy, "cache"), { recursive: true });
  return { set };
}

describe("the root", () => {
  test("is ~/.red/skills, spelled the same by every helper", () => {
    expect(redSkillsRoot("/home/x")).toBe("/home/x/.red/skills");
    expect(redSkillsCurrent("/home/x")).toBe("/home/x/.red/skills/current");
    expect(redSkillsRootPosix("C:\\Users\\x\\")).toBe("C:/Users/x/.red/skills");
    expect(redSkillsCurrentPosix("/home/x")).toBe("/home/x/.red/skills/current");
    expect(legacyRedSkillsRoot("/home/x")).toBe("/home/x/.red-skills");
  });
});

describe("relocating the old root", () => {
  test("renames the tree, re-points the pointers, clears the stamp and leaves nothing behind", () => {
    const home = fakeHome();
    legacyTree(home);

    const result = relocateLegacyRedSkillsRoot(home);

    expect(result.outcome).toBe("moved");
    const root = redSkillsRoot(home);
    expect(existsSync(join(root, "sets", "3.19.5+bc45c2f863eb", "package.json"))).toBe(true);
    expect(readFileSync(join(root, "package-set.json"), "utf8")).toBe('{"schema":1}');

    // The pointers name the new root in full, not the old one through the alias.
    expect(readlinkSync(join(root, "current"))).toBe(join(root, "sets", "3.19.5+bc45c2f863eb"));
    expect(readlinkSync(join(root, "previous"))).toBe(join(root, "sets", "3.19.4+000000000000"));
    expect(realpathSync(redSkillsCurrent(home))).toBe(realpathSync(join(root, "sets", "3.19.5+bc45c2f863eb")));
    expect(result.relinked.sort()).toEqual([join(root, "current"), join(root, "previous")]);

    // The stamp said the hosts were wired against this revision — at the old path.
    expect(existsSync(join(root, "reconciled.json"))).toBe(false);
    expect(result.cleared).toEqual([join(root, "reconciled.json")]);

    // One RedSkills directory per home: the old name is gone, not aliased.
    expect(existsSync(legacyRedSkillsRoot(home))).toBe(false);
  });

  test("is a no-op a second time, and on a home that never had the old root", () => {
    const home = fakeHome();
    legacyTree(home);
    relocateLegacyRedSkillsRoot(home);

    expect(relocateLegacyRedSkillsRoot(home).outcome).toBe("nothing");
    expect(relocateLegacyRedSkillsRoot(fakeHome()).outcome).toBe("nothing");
  });

  test("leaves both trees alone when the new root already exists", () => {
    const home = fakeHome();
    legacyTree(home);
    mkdirSync(join(redSkillsRoot(home), "sets"), { recursive: true });
    writeFileSync(join(redSkillsRoot(home), "package-set.json"), "new");

    const result = relocateLegacyRedSkillsRoot(home);

    expect(result.outcome).toBe("kept");
    expect(readFileSync(join(redSkillsRoot(home), "package-set.json"), "utf8")).toBe("new");
    expect(lstatSync(legacyRedSkillsRoot(home)).isSymbolicLink()).toBe(false);
    expect(existsSync(join(legacyRedSkillsRoot(home), "reconciled.json"))).toBe(true);
  });

  test("is in the ledger, after the adoption that inventories what it would otherwise carry", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    const at = ids.indexOf("2026-08-19-red-skills-under-red");
    expect(at).toBeGreaterThan(ids.indexOf("2026-08-16-red-skills-legacy-retention"));
  });
});

describe("the adoption and the move", () => {
  test("standalone trees under the old root are inventoried before the move, and once after it", async () => {
    const home = fakeHome();
    const legacy = legacyRedSkillsRoot(home);
    for (const version of ["v3.17.1", "v3.18.12"]) {
      const tree = join(legacy, "versions", version);
      mkdirSync(join(tree, ".claude-plugin"), { recursive: true });
      writeFileSync(join(tree, ".claude-plugin", "marketplace.json"), "{}");
      writeFileSync(join(tree, ".upstream"), "reddb-io/red-skills\n");
    }
    symlinkSync(join(legacy, "versions", "v3.18.12"), join(legacy, "current"), "dir");
    mkdirSync(join(legacy, "cache"), { recursive: true });
    writeFileSync(join(legacy, "cache", "v3.17.1.tar.gz"), "x".repeat(64));
    const opts = { home, config: join(home, ".config"), registrations: async () => ({}) };

    // The ledger adopts first, against a machine whose state is still
    // under the old name: the inventory has to see it there.
    const before = (await inventoryLegacyWorkstation(opts)).items.map((i) => i.path).sort();
    expect(before).toEqual(
      [
        join(legacy, "cache", "v3.17.1.tar.gz"),
        join(legacy, "versions", "v3.17.1"),
        join(legacy, "versions", "v3.18.12"),
      ].sort(),
    );

    relocateLegacyRedSkillsRoot(home);

    // Moved, the same three are under the new root — and only there.
    const root = redSkillsRoot(home);
    const after = (await inventoryLegacyWorkstation(opts)).items.map((i) => i.path).sort();
    expect(after).toEqual(
      [
        join(root, "cache", "v3.17.1.tar.gz"),
        join(root, "versions", "v3.17.1"),
        join(root, "versions", "v3.18.12"),
      ].sort(),
    );
  });
});
