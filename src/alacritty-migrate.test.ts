/**
 * A file written once and never rewritten still has to survive what
 * red-dev got wrong in it.
 *
 * Two things went wrong. The previous repair decided whether an import
 * already sat under `[general]` with a regex that could not cross the
 * `[WARN]` in red-dev's own comment, so it added a second `[general]` —
 * invalid TOML, which Alacritty answers by loading none of the file and
 * none of its imports. And it moved every import under `[general]`, a key
 * Alacritty 0.13 does not read. The fixture is that broken file exactly
 * as it was found on a machine.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse } from "smol-toml";
import {
  importStyleFor,
  migrateImportKey,
  parseAlacrittyVersion,
  repairAlacrittyToml,
  requiredImports,
} from "./alacritty.ts";
import type { AlacrittyVersion } from "./alacritty.ts";

const V013: AlacrittyVersion = [0, 13, 2];
const V015: AlacrittyVersion = [0, 15, 1];
const REQUIRED = requiredImports(null);
const BROKEN = readFileSync("src/fixtures/alacritty-duplicate-general.toml", "utf8");

const OLD = `# red-dev — Alacritty.

import = [
  'theme.toml',
  'font.toml',
  'shell.toml',
]

[window]
opacity = 0.90
`;

async function migrate(content: string, version?: AlacrittyVersion | null): Promise<string> {
  const dir = mkdtempSync(`${tmpdir()}/alacritty-`);
  const path = `${dir}/alacritty.toml`;
  await Bun.write(path, content);
  await migrateImportKey(path, REQUIRED, version);
  return await Bun.file(path).text();
}

function repaired(text: string, version?: AlacrittyVersion | null): string {
  const out = repairAlacrittyToml(text, REQUIRED, version);
  if (out.kind !== "repaired") throw new Error(`expected a repair, got ${out.kind}`);
  return out.text;
}

type Doc = { import?: string[]; general?: { import?: string[] } } & Record<string, unknown>;

describe("which import spelling a version reads", () => {
  test("0.13 reads only the top-level key", () => {
    expect(importStyleFor(V013)).toBe("top-level");
  });

  test("0.14 and later read [general] import", () => {
    expect(importStyleFor([0, 14, 0])).toBe("general");
    expect(importStyleFor(V015)).toBe("general");
    expect(importStyleFor([1, 0, 0])).toBe("general");
  });

  test("an unknown version gets the spelling both read", () => {
    expect(importStyleFor(null)).toBe("top-level");
  });

  test("the version line alacritty prints is understood", () => {
    expect(parseAlacrittyVersion("alacritty 0.13.2")).toEqual([0, 13, 2]);
    expect(parseAlacrittyVersion("alacritty 0.15.1 (1f7e1bb)\n")).toEqual([0, 15, 1]);
    expect(parseAlacrittyVersion("command not found")).toBeNull();
  });
});

describe("the broken file with two [general] tables", () => {
  test("is invalid TOML, which is the whole bug", () => {
    expect(() => parse(BROKEN)).toThrow();
  });

  test("becomes one top-level import on Alacritty 0.13", () => {
    const out = repaired(BROKEN, V013);
    const doc = parse(out) as Doc;
    expect(doc.import).toEqual(["cursor.toml", "font.toml", "keys.toml", "shell.toml"]);
    expect(doc.general).toBeUndefined();
    expect(out).not.toContain("[general]");
  });

  test("becomes one [general] table on Alacritty 0.14+", () => {
    const out = repaired(BROKEN, V015);
    const doc = parse(out) as Doc;
    expect(doc.general?.import).toEqual(["cursor.toml", "font.toml", "keys.toml", "shell.toml"]);
    expect(doc.import).toBeUndefined();
    expect(out.match(/^\[general\]$/gm)?.length).toBe(1);
  });

  test("becomes a top-level import when the version is unknown", () => {
    const doc = parse(repaired(BROKEN, null)) as Doc;
    expect(doc.import).toContain("keys.toml");
    expect(doc.general).toBeUndefined();
  });

  test("keeps every other setting and the person's comments", () => {
    const out = repaired(BROKEN, V013);
    const before = BROKEN.split("[window]")[1];
    expect(out.split("[window]")[1]).toBe(before);
    expect(out).toContain("# This file is created once and never rewritten, so it is yours to edit.");
    // red-dev's own comment explained the spelling 0.13 cannot read.
    expect(out).not.toContain("general.import, not a bare top-level import");
  });

  test("says what it changed", () => {
    const outcome = repairAlacrittyToml(BROKEN, REQUIRED, V013);
    expect(outcome.kind).toBe("repaired");
    if (outcome.kind !== "repaired") return;
    expect(outcome.changes.join("\n")).toContain("merged 2 [general] tables");
    expect(outcome.changes.join("\n")).toContain("import moved to the top level");
  });

  test("is repaired once: a second converge changes nothing", () => {
    for (const v of [V013, V015, null]) {
      const once = repaired(BROKEN, v);
      expect(repairAlacrittyToml(once, REQUIRED, v).kind).toBe("unchanged");
    }
  });

  test("keeps a backup of what it replaced", async () => {
    const dir = mkdtempSync(`${tmpdir()}/alacritty-`);
    const path = `${dir}/alacritty.toml`;
    await Bun.write(path, BROKEN);
    expect(await migrateImportKey(path, REQUIRED, V013)).toBe(true);
    const backups = readdirSync(dir).filter((f) => f.startsWith("alacritty.toml.red-dev-backup-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(`${dir}/${backups[0]}`, "utf8")).toBe(BROKEN);
  });

  test("merges other [general] keys instead of losing them", () => {
    const text = BROKEN.replace("[general]\nimport", "[general]\nlive_config_reload = true\nimport");
    for (const v of [V013, V015]) {
      const doc = parse(repaired(text, v)) as Doc;
      expect((doc.general as Record<string, unknown>)["live_config_reload"]).toBe(true);
    }
  });

  test("survives Windows line endings", () => {
    const crlf = BROKEN.replace(/\n/g, "\r\n");
    const out = repaired(crlf, V013);
    expect(out).not.toMatch(/[^\r]\n/);
    expect((parse(out) as Doc).import).toContain("keys.toml");
  });
});

describe("a valid file", () => {
  test("with general.import is moved to the top level on 0.13", () => {
    const text = "[general]\nimport = [\n  'cursor.toml',\n  'font.toml',\n  'keys.toml',\n  'shell.toml',\n]\n\n[window]\nopacity = 0.5\n";
    const doc = parse(repaired(text, V013)) as Doc;
    expect(doc.import).toContain("keys.toml");
    expect(doc.general).toBeUndefined();
    expect((doc["window"] as Record<string, unknown>)["opacity"]).toBe(0.5);
  });

  test("with a top-level import moves under [general] on 0.14+", async () => {
    const out = await migrate(OLD, V015);
    expect(out.indexOf("[general]")).toBeLessThan(out.indexOf("import = ["));
    expect((parse(out) as Doc).general?.import).toContain("keys.toml");
    expect(out).toContain("opacity = 0.90");
  });

  test("keeps its spelling when the version is unknown", () => {
    const general = "[general]\nimport = [\n  'cursor.toml',\n  'font.toml',\n  'keys.toml',\n  'shell.toml',\n]\n";
    expect(repairAlacrittyToml(general, REQUIRED, null).kind).toBe("unchanged");
    const top = "import = [\n  'cursor.toml',\n  'font.toml',\n  'keys.toml',\n  'shell.toml',\n]\n";
    expect(repairAlacrittyToml(top, REQUIRED, null).kind).toBe("unchanged");
  });

  test("that is already right is left byte for byte", async () => {
    const settled = "import = ['shell.toml', 'keys.toml', 'font.toml', 'cursor.toml']\n# mine\n[window]\nopacity = 1\n";
    expect(await migrate(settled, V013)).toBe(settled);
  });

  test("gains an import it predates, and drops the retired theme.toml", async () => {
    const old = OLD.replace("  'shell.toml',\n", "");
    const out = await migrate(old, V013);
    expect(out).toContain("shell.toml");
    expect(out).toContain("cursor.toml");
    expect(out).not.toContain("theme.toml");
    expect(() => parse(out)).not.toThrow();
  });

  test("keeps an import the user added", async () => {
    const mine = OLD.replace("  'shell.toml',", "  'shell.toml',\n  'meu.toml',");
    expect(await migrate(mine, V013)).toContain("meu.toml");
  });

  test("without any import is not given one", async () => {
    const custom = "[window]\nopacity = 0.5\n";
    expect(await migrate(custom, V013)).toBe(custom);
  });

  test("is refused rather than written when the repair would not parse", () => {
    // A dotted general.* key at the root and a [general] table cannot both
    // exist; the repair must not turn one invalid file into another.
    const text = "general.live_config_reload = true\nimport = ['cursor.toml']\n[general]\n[general]\n";
    expect(repairAlacrittyToml(text, REQUIRED, V015).kind).toBe("refused");
  });
});
