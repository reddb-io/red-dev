/**
 * A name on PATH is not an identity.
 *
 * Ubuntu ships /usr/bin/red — GNU ed's restricted mode — so probing for
 * `red` found it, reported the RedDB CLI as present, and the real one
 * was never installed on any Linux machine. `red-dev doctor` printed
 * "ok red" about GNU ed 1.20.1 for as long as that entry existed.
 */

import { describe, expect, test } from "bun:test";
import { TOOLS } from "./manifest.ts";

describe("the red entry", () => {
  const red = TOOLS.find((t) => t.name === "red");

  test("exists", () => {
    expect(red).toBeDefined();
  });

  test("carries a signature, because the name collides", () => {
    expect(red?.signature).toBeInstanceOf(RegExp);
  });

  test("the signature accepts the RedDB CLI", () => {
    // What `red --version` actually printed on the machine that found
    // this: the RedDB binary answers with its own name.
    expect(red?.signature?.test("reddb 1.23.2")).toBe(true);
  });

  test("and rejects the GNU ed that shipped with the distro", () => {
    const ed = "GNU ed 1.20.1\nCopyright (C) 1994 Andrew L. Moore.";
    expect(red?.signature?.test(ed)).toBe(false);
  });
});

describe("signatures in general", () => {
  test("are the exception, not the rule", () => {
    // Running every tool to ask its version would cost a process per
    // check on every doctor and every converge. Only names that
    // genuinely collide earn one.
    const withSignature = TOOLS.filter((t) => t.signature);
    expect(withSignature.length).toBeLessThan(5);
  });
});
