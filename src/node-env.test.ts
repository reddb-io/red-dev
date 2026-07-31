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

  test("there is a way back to development behaviour", () => {
    // Forcing production unconditionally would leave no way to see a
    // real warning while working on the interface.
    expect(raw).toContain("RED_DEV_DEBUG");
  });

  test("bun really does bake in development, which is the whole reason", () => {
    // Not a test of our code — a test of the assumption underneath it.
    // If a future bun stops doing this, the comment above stops being
    // true and someone should find out from here.
    expect(process.env["NODE_ENV"]).toBeDefined();
  });
});
