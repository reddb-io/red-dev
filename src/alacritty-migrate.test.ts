/**
 * A file written once and never rewritten still has to survive upstream
 * renaming a key.
 *
 * Alacritty deprecated the bare top-level `import`, so every launch
 * printed a warning over the terminal before the shell had drawn
 * anything — on a config red-dev had written itself. The policy that
 * caused it is correct and stays: the user is invited to edit that file.
 * What was missing is the narrowest possible repair.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { migrateImportKey } from "./alacritty.ts";

const OLD = `# red-dev — Alacritty.

import = [
  'theme.toml',
  'font.toml',
  'shell.toml',
]

[window]
opacity = 0.90
`;

async function migrate(content: string): Promise<string> {
  const dir = mkdtempSync(`${tmpdir()}/alacritty-`);
  const path = `${dir}/alacritty.toml`;
  await Bun.write(path, content);
  await migrateImportKey(path);
  return await Bun.file(path).text();
}

describe("the alacritty import key", () => {
  test("moves under [general] when it is the shape red-dev writes", async () => {
    const out = await migrate(OLD);
    expect(out).toContain("[general]");
    expect(out.indexOf("[general]")).toBeLessThan(out.indexOf("import = ["));
    // Everything else is the user's and survives.
    expect(out).toContain("opacity = 0.90");
  });

  test("leaves a config that is already complete alone", async () => {
    const already = OLD.replace("import = [", "[general]\nimport = [");
    const out = await migrate(already);
    expect((out.match(/\[general\]/g) ?? []).length).toBe(1);
  });

  test("adds an import the file predates", async () => {
    // The bug that mattered more than the warning. This machine's config
    // was written before shell.toml existed, so it never imported it —
    // and `red-dev shell` had been writing a choice into a file nothing
    // read.
    const old = OLD.replace("  'shell.toml',\n", "");
    expect(old).not.toContain("shell.toml");
    const out = await migrate(old);
    expect(out).toContain("shell.toml");
    expect(out).toContain("theme.toml");
    expect(out).toContain("font.toml");
  });

  test("keeps an import the user added", async () => {
    const mine = OLD.replace("  'shell.toml',", "  'shell.toml',\n  'meu.toml',");
    expect(await migrate(mine)).toContain("meu.toml");
  });

  test("does not touch an import written some other way", async () => {
    const custom = "[window]\nopacity = 0.5\n";
    expect(await migrate(custom)).toBe(custom);
  });
});

