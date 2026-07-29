import { describe, expect, test } from "bun:test";
import { versionAtLeast } from "./platform.ts";

describe("versionAtLeast", () => {
  test("compares Ubuntu releases numerically, not lexically", () => {
    // The reason this exists: "9" > "10" as strings, and 24.04 vs 26.04
    // decides which manifest column a machine gets.
    expect(versionAtLeast("26.04", "26.04")).toBe(true);
    expect(versionAtLeast("26.04", "24.04")).toBe(true);
    expect(versionAtLeast("24.04", "26.04")).toBe(false);
  });

  test("handles unequal segment counts", () => {
    expect(versionAtLeast("24.04.1", "24.04")).toBe(true);
    expect(versionAtLeast("24", "24.04")).toBe(false);
  });

  test("a missing version is never new enough", () => {
    // A machine we cannot identify must fall back to the older column
    // rather than being handed packages that may not exist there.
    expect(versionAtLeast(null, "26.04")).toBe(false);
  });

  test("does not compare double-digit segments as strings", () => {
    expect(versionAtLeast("10.0", "9.0")).toBe(true);
    expect(versionAtLeast("9.0", "10.0")).toBe(false);
  });
});
