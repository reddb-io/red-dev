/**
 * Not everything installed is a command.
 *
 * PowerToys puts PowerToys.exe in %LOCALAPPDATA%\PowerToys and never
 * touches PATH, so probing for the name answered "missing" on a machine
 * that had just installed it. Same shape of wrong answer as the `red`
 * collision — a name that does not identify the thing — arrived at from
 * the opposite direction.
 */

import { describe, expect, test } from "bun:test";
import { TOOLS } from "./manifest.ts";

describe("the powertoys entry", () => {
  const pt = TOOLS.find((t) => t.name === "powertoys");

  test("exists and is offered rather than assumed", () => {
    expect(pt).toBeDefined();
    expect(pt?.scope).toBe("optional");
  });

  test("probes a location, because the name is not on PATH", () => {
    const probe = pt?.cmd?.[0] ?? "";
    expect(probe).toContain("\\");
    expect(probe).toContain("PowerToys.exe");
  });

  test("the location is a variable, not one person's profile", () => {
    // Hardcoding C:\Users\filip helps exactly one machine.
    expect(pt?.cmd?.[0]).toContain("%LOCALAPPDATA%");
    expect(pt?.cmd?.[0]).not.toMatch(/C:\\Users\\/i);
  });

  test("skips on Linux with a reason rather than silently", () => {
    expect(pt?.u24.kind).toBe("skip");
    if (pt?.u24.kind === "skip") expect(pt.u24.reason.length).toBeGreaterThan(10);
  });
});

describe("path probes in general", () => {
  test("only tools that need one have one", () => {
    // Every other tool is a command, and a path probe on those would be
    // a per-platform guess where a name already works.
    const withPaths = TOOLS.filter((t) => t.cmd?.some((c) => /[\\/]/.test(c)));
    expect(withPaths.map((t) => t.name)).toEqual(["powertoys"]);
  });
});
