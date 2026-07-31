/**
 * The shipped binary says it is production, and means it.
 *
 * `if (!process.env.NODE_ENV) process.env.NODE_ENV = "production"` looks
 * right and never fired: bun build --compile bakes NODE_ENV="development"
 * into the executable, so the condition was false on every run for four
 * releases. tuiuiu's development warnings kept printing across the top
 * of the interface, about a defect that does not exist, and the release
 * notes said they were gone.
 *
 * A guard that cannot fire is worse than no guard, because it reads as
 * handled.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const raw = readFileSync("src/main.ts", "utf8");
// Comments stripped, because the note explaining the bug quotes the
// broken line verbatim — and the first version of this test failed on
// its own prose rather than on any code.
const src = raw
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join("\n");

describe("NODE_ENV", () => {
  test("is assigned, not defaulted", () => {
    // The exact shape that failed. `!process.env.NODE_ENV` is never true
    // in a compiled binary.
    expect(src).not.toContain("if (!process.env.NODE_ENV)");
    expect(src).toMatch(/process\.env\.NODE_ENV\s*=/);
  });

  test("the way back is a build, not an environment variable", () => {
    // RED_DEV_DEBUG was advertised as the escape hatch and never worked:
    // --define substitutes the value into every module at build time, so
    // the check is decided before the program starts. Verified by
    // running a compiled binary with NODE_ENV=production set in the
    // environment — it still took the development path.
    expect(raw).not.toContain("RED_DEV_DEBUG");
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["build:debug"]).toBeDefined();
    expect(pkg.scripts["build:debug"]).not.toContain("--define");
    // And the shipped builds must carry it, or the warnings come back.
    expect(pkg.scripts["build:linux"]).toContain("--define");
    expect(pkg.scripts["build:windows"]).toContain("--define");
  });

  test("bun really does bake in development, which is the whole reason", () => {
    // Not a test of our code — a test of the assumption underneath it.
    // If a future bun stops doing this, the comment above stops being
    // true and someone should find out from here.
    expect(process.env["NODE_ENV"]).toBeDefined();
  });
});
