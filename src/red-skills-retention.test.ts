/**
 * Retention: the prune that runs forever, and the cleanup that runs once.
 *
 * Both halves are about deleting, so every test below is written from
 * the other side of that: what survives. A retention pass that reclaims
 * a gigabyte and takes the tree the machine resolves through has not
 * saved anybody anything.
 *
 * The cleanup runs against a fabricated home — versions, tarballs and
 * two hosts' plugin caches, shaped like the ones measured on a real
 * machine — so it holds with no RedSkills, no mise and no agent host
 * installed. The prune is pinned as the command it issues and the place
 * in the update it issues it from, because there is no mise here to run
 * it against.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureTo } from "./log.ts";
import { MIGRATIONS } from "./migrations.ts";
import { misePruneCommand } from "./providers.ts";
import {
  clearLegacyRedSkills,
  planLegacyRedSkillsCleanup,
  type LegacyItem,
} from "./red-skills-retention.ts";
import { runUpdate, updateStageOrder } from "./update-order.ts";

/** A file of a known size, so the report has something to add up. */
function fileOf(path: string, bytes: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x".repeat(bytes));
}

function versionTree(home: string, version: string): string {
  const dir = join(home, ".red-skills", "versions", `v${version}`);
  fileOf(join(dir, "package.json"), 64);
  fileOf(join(dir, "src", "index.ts"), 512);
  return dir;
}

function pluginCopy(home: string, host: string, plugin: string, version: string): string {
  const dir = join(home, `.${host}`, "plugins", "cache", "red-skills", plugin, version);
  fileOf(join(dir, "plugin.json"), 128);
  return dir;
}

function claudeRecords(home: string, paths: string[]): void {
  const path = join(home, ".claude", "plugins", "installed_plugins.json");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 2,
      plugins: Object.fromEntries(
        paths.map((installPath, i) => [`p${i}@red-skills`, [{ scope: "user", installPath }]]),
      ),
    }),
  );
}

/**
 * The machine this whole slice was measured on, in miniature.
 *
 * Fourteen extracted trees became three, and twenty-five plugin copies
 * became four, but every shape that decides an outcome is here: a
 * `current` link, an older tree beside it, a retained tarball, two
 * hosts, and a copy one of them still records as installed.
 */
function legacyHome(): { home: string; current: string; superseded: string } {
  const home = mkdtempSync(join(tmpdir(), "red-retention-"));

  const superseded = versionTree(home, "3.17.1");
  versionTree(home, "3.0.4");
  const current = versionTree(home, "3.18.12");
  symlinkSync(current, join(home, ".red-skills", "current"), "dir");

  fileOf(join(home, ".red-skills", "cache", "v3.17.1.tar.gz"), 4096);
  fileOf(join(home, ".red-skills", "cache", "v3.18.12.tar.gz"), 4096);

  pluginCopy(home, "claude", "dev", "3.0.4");
  const pinned = pluginCopy(home, "claude", "dev", "3.17.1");
  pluginCopy(home, "claude", "dev", "3.18.12");
  claudeRecords(home, [pinned]);

  pluginCopy(home, "codex", "dev", "3.17.1");
  pluginCopy(home, "codex", "dev", "3.18.12");

  return { home, current, superseded };
}

function paths(items: LegacyItem[]): string[] {
  return items.map((item) => item.path).sort();
}

describe("the one-time cleanup", () => {
  test("removes the trees, the tarballs and the superseded plugin copies", () => {
    const { home, superseded } = legacyHome();

    const { removed, bytes } = clearLegacyRedSkills({ home });

    expect(paths(removed)).toEqual(
      [
        join(home, ".claude", "plugins", "cache", "red-skills", "dev", "3.0.4"),
        join(home, ".codex", "plugins", "cache", "red-skills", "dev", "3.17.1"),
        join(home, ".red-skills", "cache", "v3.17.1.tar.gz"),
        join(home, ".red-skills", "cache", "v3.18.12.tar.gz"),
        join(home, ".red-skills", "versions", "v3.0.4"),
        superseded,
      ].sort(),
    );
    for (const item of removed) expect(existsSync(item.path)).toBe(false);

    // What was reclaimed, which is the only number anybody reads: two
    // trees at 576 bytes, two tarballs at 4096 and two plugin copies at
    // 128. A report that names paths and not sizes cannot answer the
    // question this slice exists for.
    expect(bytes).toBe(2 * 576 + 2 * 4096 + 2 * 128);
    expect(removed.map((item) => item.kind).sort()).toEqual([
      "plugin-copy",
      "plugin-copy",
      "tarball",
      "tarball",
      "version-tree",
      "version-tree",
    ]);
  });

  test("a second run removes nothing further and still succeeds", () => {
    const { home } = legacyHome();
    clearLegacyRedSkills({ home });

    const again = clearLegacyRedSkills({ home });

    expect(again.removed).toEqual([]);
    expect(again.bytes).toBe(0);
    expect(planLegacyRedSkillsCleanup({ home })).toEqual([]);
  });

  test("a machine that never had the old install mode has nothing to clear", () => {
    const home = mkdtempSync(join(tmpdir(), "red-retention-fresh-"));
    expect(planLegacyRedSkillsCleanup({ home })).toEqual([]);
    expect(clearLegacyRedSkills({ home }).removed).toEqual([]);
  });
});

describe("what the cleanup must never take", () => {
  test("the version current resolves to, and the link itself", () => {
    const { home, current } = legacyHome();

    clearLegacyRedSkills({ home });

    expect(existsSync(current)).toBe(true);
    expect(existsSync(join(current, "package.json"))).toBe(true);
    expect(existsSync(join(home, ".red-skills", "current"))).toBe(true);
  });

  test("a copy a host still records as installed, or the newest it holds", () => {
    const { home } = legacyHome();

    clearLegacyRedSkills({ home });

    const claude = join(home, ".claude", "plugins", "cache", "red-skills", "dev");
    // Recorded as installed, and older than one it also has: the host
    // is resolving through it, which makes it the plugin rather than a
    // leftover copy of it.
    expect(existsSync(join(claude, "3.17.1"))).toBe(true);
    expect(existsSync(join(claude, "3.18.12"))).toBe(true);
    expect(existsSync(join(home, ".codex", "plugins", "cache", "red-skills", "dev", "3.18.12")))
      .toBe(true);
  });

  test("a version directory that is a link into mise's installs", () => {
    // The layout red-skills-core.ts maintains. It costs nothing, and
    // what it points at is mise's to prune — deleting through it would
    // take an install mise still believes it has.
    const home = mkdtempSync(join(tmpdir(), "red-retention-linked-"));
    const installs = mkdtempSync(join(tmpdir(), "red-retention-installs-"));
    fileOf(join(installs, "3.17.1", "package.json"), 64);
    const linked = join(home, ".red-skills", "versions", "v3.17.1");
    mkdirSync(join(home, ".red-skills", "versions"), { recursive: true });
    symlinkSync(join(installs, "3.17.1"), linked, "dir");
    const current = versionTree(home, "3.18.12");
    symlinkSync(current, join(home, ".red-skills", "current"), "dir");

    expect(planLegacyRedSkillsCleanup({ home })).toEqual([]);
    expect(existsSync(linked)).toBe(true);
    expect(existsSync(join(installs, "3.17.1", "package.json"))).toBe(true);
  });

  test("every tree, when current does not resolve to one", () => {
    // Nothing is protected on a machine whose link is dangling or
    // absent, and a prune with nothing protected is one that takes the
    // tree the next converge is about to point at.
    const home = mkdtempSync(join(tmpdir(), "red-retention-dangling-"));
    const tree = versionTree(home, "3.17.1");
    symlinkSync(join(home, ".red-skills", "versions", "v9.9.9"), join(home, ".red-skills", "current"), "dir");

    expect(planLegacyRedSkillsCleanup({ home }).filter((i) => i.kind === "version-tree")).toEqual([]);
    expect(existsSync(tree)).toBe(true);
  });

  test("a host whose record of what it installed cannot be read", () => {
    // An unparseable record is not evidence that nothing is installed.
    // The other host is unaffected: refusing one is not refusing all.
    const { home } = legacyHome();
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "{ not json");

    const plan = planLegacyRedSkillsCleanup({ home });

    expect(plan.filter((i) => i.path.includes(".claude"))).toEqual([]);
    expect(paths(plan.filter((i) => i.path.includes(".codex")))).toEqual([
      join(home, ".codex", "plugins", "cache", "red-skills", "dev", "3.17.1"),
    ]);
  });

  test("a directory under a plugin whose name is not a version", () => {
    // Put there by something this module does not understand, which is
    // the whole reason not to delete it.
    const home = mkdtempSync(join(tmpdir(), "red-retention-odd-"));
    pluginCopy(home, "claude", "dev", "3.18.12");
    const odd = pluginCopy(home, "claude", "dev", "staging-2841cf97");

    expect(planLegacyRedSkillsCleanup({ home })).toEqual([]);
    expect(existsSync(odd)).toBe(true);
  });
});

describe("the migration that runs it", () => {
  const migration = MIGRATIONS.find((m) => m.id === "2026-08-16-red-skills-legacy-retention");

  /** Run `fn` with HOME pointed at a fabricated machine. */
  async function withHome<T>(home: string, fn: () => Promise<T> | T): Promise<T> {
    const saved = process.env["HOME"];
    const savedProfile = process.env["USERPROFILE"];
    process.env["HOME"] = home;
    delete process.env["USERPROFILE"];
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env["HOME"];
      else process.env["HOME"] = saved;
      if (savedProfile !== undefined) process.env["USERPROFILE"] = savedProfile;
    }
  }

  test("is in the ledger, so it runs once and is recorded", () => {
    expect(migration).toBeDefined();
    expect(migration!.describe).toContain("RedSkills");
  });

  test("applies to a machine carrying the old install mode, and clears it", async () => {
    const { home, current, superseded } = legacyHome();
    const lines: string[] = [];

    await withHome(home, async () => {
      expect(await migration!.applies({} as never)).toBe(true);
      const release = captureTo((line) => lines.push(line));
      try {
        await migration!.run({} as never);
      } finally {
        release();
      }
      // The ledger is a promise rather than a guarantee, so the second
      // run is asked the same question the first was.
      expect(await migration!.applies({} as never)).toBe(false);
    });

    expect(existsSync(superseded)).toBe(false);
    expect(existsSync(current)).toBe(true);
    // What it took, path by path, and then the one line with the number
    // this whole slice exists for.
    expect(lines.filter((line) => line.includes(superseded))).toHaveLength(1);
    expect(lines.at(-1)).toContain("6 left over");
    expect(lines.at(-1)).toContain("back");
  });

  test("a second run removes nothing further and reports success", async () => {
    const { home } = legacyHome();
    const lines: string[] = [];

    await withHome(home, async () => {
      const release = captureTo((line) => lines.push(line));
      try {
        await migration!.run({} as never);
        lines.length = 0;
        // Run rather than skipped through `applies`: a ledger entry can
        // be lost with a preferences file, and the migration has to be
        // safe to run again on its own terms.
        await migration!.run({} as never);
      } finally {
        release();
      }
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("mise owns every version");
  });

  test("does not apply to a machine with nothing left behind", async () => {
    const home = mkdtempSync(join(tmpdir(), "red-retention-clean-"));
    await withHome(home, async () => {
      expect(await migration!.applies({} as never)).toBe(false);
    });
  });
});

describe("the prune that retires versions from here on", () => {
  test("is mise's own, over the tools this repo declares", () => {
    // Bare `mise prune` would reach the user's own runtimes, for the
    // same reason `mise upgrade` is named tool by tool: their unused
    // Node versions are not ours to collect. `--tools` keeps it off
    // their tracked config links as well.
    const argv = misePruneCommand("/usr/bin/mise", ["red", "tq", "red-skills"]);
    expect(argv).toEqual(["/usr/bin/mise", "prune", "--tools", "red", "tq", "red-skills"]);
  });

  test("runs at the end of the update, after the tools are upgraded", () => {
    const order = updateStageOrder();
    expect(order.at(-1)).toBe("prune");
    expect(order.indexOf("suite")).toBeLessThan(order.indexOf("prune"));
    expect(order.indexOf("converge")).toBeLessThan(order.indexOf("prune"));
  });

  test("is the command the update's last stage issues", () => {
    // Read off main.ts rather than run, because running it needs a mise
    // and a machine with versions to collect. What can regress here is
    // the wiring: a stage declared in the order and left doing nothing
    // is retention that reports success and prunes nothing.
    const main = readFileSync(`${import.meta.dir}/main.ts`, "utf8");
    const stage = main.slice(main.indexOf("    prune: async ()"));
    expect(stage.slice(0, stage.indexOf("},"))).toContain("misePruneSuite(p)");
  });

  test("a prune that fails does not fail the update", async () => {
    // It is the last thing an update does and the least important: a
    // machine that could not collect its old versions is still a
    // machine that updated. The answer stays the converge's.
    const failures: string[] = [];
    const run = await runUpdate(
      async (stage) => {
        if (stage === "prune") throw new Error("mise prune exited 1");
        return stage === "converge" ? 0 : undefined;
      },
      (stage, message, fatal) => failures.push(`${stage}${fatal ? "!" : ""}: ${message}`),
    );

    expect(run.code).toBe(0);
    expect(run.ran.at(-1)).toBe("prune");
    expect(failures).toEqual(["prune: mise prune exited 1"]);
  });
});
