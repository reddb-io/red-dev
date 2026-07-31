/**
 * File names are kebab-case, everywhere.
 *
 * A convention nothing checks is a preference, and this repository has
 * three sources of truth that disagree easily — the TypeScript modules,
 * the shell config it embeds, and the scripts CI runs. One camelCase
 * file among them is the kind of small inconsistency that later costs an
 * import path.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";

/** Every tracked file under the directories we own. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

describe("file names", () => {
  const files = ["src", "scripts", "config"].flatMap((d) => walk(d));

  test("there are files to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  test("are kebab-case, with no capitals or underscores", () => {
    const offenders = files.filter((f) => {
      const base = f.split("/").pop() ?? "";
      // The stem only: extensions carry their own conventions, and a
      // name like `tui-chrome.test.ts` is three of them.
      const stem = base.split(".")[0] ?? "";
      return /[A-Z_]/.test(stem);
    });
    expect(offenders).toEqual([]);
  });

  test("and directories follow the same rule", () => {
    const dirs = new Set(
      files.map((f) => f.split("/").slice(0, -1).join("/")).filter(Boolean),
    );
    const offenders = [...dirs].filter((d) => /[A-Z_]/.test(d.split("/").pop() ?? ""));
    expect(offenders).toEqual([]);
  });
});
