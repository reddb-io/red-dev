/**
 * The ledger, and the one migration that deletes.
 *
 * A converge fixes what is missing. Removing a feature leaves the
 * opposite problem: nothing is missing, and what is there should not be.
 * Global hotkeys were exactly that — a .lnk keeps its hotkey forever, so
 * dropping the code that wrote them would have left Ctrl+Alt+T bound on
 * every machine that had already run it, with the red-dev on that
 * machine no longer having any idea why.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MIGRATIONS,
  globalMiseConfigPath,
  migrateMiseSuiteToSingleIdentity,
  migrateMiseToolsToLatest,
  migrationLedgerPath,
  readMigrationLedger,
  writeMigrationLedger,
} from "./migrations.ts";

describe("legacy mise selectors", () => {
  const managed = new Set(["go", "gemini", "github:reddb-io/redcode"]);

  test("moves only red-dev-owned selectors to latest and preserves the file", () => {
    const source = `[tools]\n# chosen long ago\ngo = "1.24.4" # old default\ngemini = { version = "0.60.0", allow_builds = ["node-pty"] }\n"github:reddb-io/redcode" = '0.38.4'\nprivate-tool = "2.3.4"\n`;
    const first = migrateMiseToolsToLatest(source, managed);

    expect(first.changed).toEqual(["go", "gemini", "github:reddb-io/redcode"]);
    expect(first.text).toBe(`[tools]\n# chosen long ago\ngo = "latest" # old default\ngemini = { version = "latest", allow_builds = ["node-pty"] }\n"github:reddb-io/redcode" = 'latest'\nprivate-tool = "2.3.4"\n`);
    expect(migrateMiseToolsToLatest(first.text, managed)).toEqual({ text: first.text, changed: [] });
  });

  test("finds the global config without assuming one home layout", () => {
    expect(globalMiseConfigPath({ MISE_CONFIG_DIR: "/mise-config" }, "linux")).toBe("/mise-config/config.toml");
    expect(globalMiseConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe("/xdg/mise/config.toml");
    expect(globalMiseConfigPath({ APPDATA: "C:/Users/me/AppData/Roaming" }, "win32")).toBe("C:/Users/me/AppData/Roaming/mise/config.toml");
  });
});

describe("one mise identity per RedDB product", () => {
  const entries = [
    { spec: "github:reddb-io/redcode", alias: "redcode" },
    { spec: "npm:@reddb-io/red-router", alias: "red-router" },
    { spec: "github:someone/else", alias: "else" },
  ];

  test("retires only first-party qualified rows superseded by aliases", () => {
    const source = `[tools]\n# written by an older red-dev\n"github:reddb-io/redcode" = "latest"\n"npm:@reddb-io/red-router" = {\n  version = "latest"\n}\n"github:someone/else" = "latest"\nnode = "latest"\n`;
    const first = migrateMiseSuiteToSingleIdentity(source, entries);

    expect(first.removed).toEqual([
      "github:reddb-io/redcode -> redcode",
      "npm:@reddb-io/red-router -> red-router",
    ]);
    expect(first.text).toBe(`[tools]\n# written by an older red-dev\n\n\n\n\n"github:someone/else" = "latest"\nnode = "latest"\n`);
    expect(Bun.TOML.parse(first.text)).toEqual({
      tools: { "github:someone/else": "latest", node: "latest" },
    });
    expect(migrateMiseSuiteToSingleIdentity(first.text, entries)).toEqual({
      text: first.text,
      removed: [],
    });
  });
});

describe("the ledger", () => {
  test("ids are unique, because the ledger is keyed on them", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("ids sort in the order they were written", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect([...ids].sort()).toEqual(ids);
  });

  test("every id starts with the date it was written", () => {
    for (const m of MIGRATIONS) {
      expect(m.id).toMatch(/^\d{4}-\d{2}-\d{2}-/);
    }
  });

  test("every migration says what it does in one line", () => {
    for (const m of MIGRATIONS) {
      expect(m.describe.length).toBeGreaterThan(10);
      expect(m.describe).not.toContain("\n");
    }
  });
});

describe("the migration that removed the hotkeys", () => {
  test("is gone, because the hotkeys came back", () => {
    // It deleted the Start Menu folder red-dev writes. With the feature
    // restored, a machine whose ledger had not yet recorded it would
    // have the shortcuts written by the converge and deleted by the
    // repair pass in the same run — the outcome depending on which ran
    // first, which is the worst kind of bug to own.
    expect(MIGRATIONS.map((m) => m.id)).not.toContain("2026-08-01-remove-hotkeys");
  });

  test("and nothing else in the ledger removes anything", () => {
    // The rule at the top of migrations.ts: a migration may repair and
    // must not remove. The hotkey one was the single exception and it
    // no longer exists.
    const src = readFileSync("src/migrations.ts", "utf8");
    expect(src).not.toContain("Remove-Item");
  });
});

describe("the ledger's home", () => {
  test("is per-side, beside the run logs, not in the shared preferences file", () => {
    // The case that made this necessary: on WSL the preferences file is
    // the Windows host's, so a repair run inside the distro used to
    // mark itself done for the host too. The transcript directory is
    // resolved per-side, and these are two different machines' answers.
    const distro = migrationLedgerPath({ HOME: "/home/me" });
    const host = migrationLedgerPath({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" });
    expect(distro).toBe("/home/me/.local/state/red-dev/migrations.json");
    expect(host).toBe("C:/Users/me/AppData/Local/red-dev/logs/migrations.json");
    expect(distro).not.toBe(host);
  });

  test("round-trips what has run, and reads an absent or broken file as nothing run", () => {
    const dir = mkdtempSync(join(tmpdir(), "red-ledger-"));
    const path = join(dir, "migrations.json");

    expect(readMigrationLedger(path)).toEqual(new Set());

    writeMigrationLedger(["2026-08-19-red-skills-under-red", "2026-07-29-font-registration"], path);
    expect(readMigrationLedger(path)).toEqual(
      new Set(["2026-08-19-red-skills-under-red", "2026-07-29-font-registration"]),
    );

    writeFileSync(path, "{ not json");
    expect(readMigrationLedger(path)).toEqual(new Set());
  });

  test("carries nothing over from the shared list it replaced", async () => {
    // Seeding from `preferences.migrations` would reproduce the bug on
    // every machine that has one: those ids may have been written by
    // the other side of the boundary. `applies()` is what keeps a
    // machine from repairing itself twice.
    const source = await Bun.file("src/migrations.ts").text();
    expect(source).not.toContain("prefs.migrations");
    expect(source).not.toContain("{ migrations:");
  });
});
