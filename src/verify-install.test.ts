/**
 * The claim "installed" is the one this project has been wrong about
 * most often, and always in the same direction: an installer exited
 * zero and nobody looked. What is asserted here is the wording of what
 * looking found — a verification that says "satisfies" about a version
 * that does not is worse than no verification at all.
 */

import { describe, expect, test } from "bun:test";
import { verificationLines } from "./verify-install.ts";

const said = (input: Parameters<typeof verificationLines>[0]): string =>
  verificationLines(input)
    .lines.map((l) => `${l.level} ${l.message}`)
    .join("\n");

describe("verificationLines", () => {
  test("names where the binary was found and what it answered", () => {
    const out = said({ tool: "zellij", path: "/home/u/.local/bin/zellij", output: "zellij 0.44.1" });
    expect(out).toContain("found at /home/u/.local/bin/zellij");
    expect(out).toContain("--version says: zellij 0.44.1");
  });

  test("with no pin and no floor, running is the whole expectation", () => {
    const v = verificationLines({ tool: "gum", path: "/usr/bin/gum", output: "gum version 0.16" });
    expect(v.satisfied).toBe(true);
    expect(v.version).toBe("0.16.0");
  });

  test("a floor that is met is reported as met", () => {
    const v = verificationLines({
      tool: "nvim",
      path: "/usr/bin/nvim",
      output: "NVIM v0.11.2",
      minVersion: "0.11.2",
    });
    expect(v.satisfied).toBe(true);
    expect(said({ tool: "nvim", path: "/usr/bin/nvim", output: "NVIM v0.11.2", minVersion: "0.11.2" })).toContain(
      "ok 0.11.2 satisfies the 0.11.2 floor",
    );
  });

  test("a floor that is not met is not quietly waved through", () => {
    // The bug: apt installs noble's 0.9.5, exits zero, and the converge
    // reports an editor that LazyVim refuses to start under.
    const v = verificationLines({
      tool: "nvim",
      path: "/usr/bin/nvim",
      output: "NVIM v0.9.5",
      minVersion: "0.11.2",
    });
    expect(v.satisfied).toBe(false);
    expect(said({ tool: "nvim", path: "/usr/bin/nvim", output: "NVIM v0.9.5", minVersion: "0.11.2" })).toContain(
      "warn 0.9.5 is below the required 0.11.2",
    );
  });

  test("a pin is a point: newer is also wrong", () => {
    const newer = verificationLines({
      tool: "zellij",
      path: "/usr/bin/zellij",
      output: "zellij 0.44.3",
      pinVersion: "0.44.1",
    });
    expect(newer.satisfied).toBe(false);
    const exact = verificationLines({
      tool: "zellij",
      path: "/usr/bin/zellij",
      output: "zellij 0.44.1",
      pinVersion: "0.44.1",
    });
    expect(exact.satisfied).toBe(true);
  });

  test("nothing on PATH is a warning that says where to look next", () => {
    // ~/.local/bin is added by the shell configuration a converge also
    // writes, so this is a normal outcome of a correct install and the
    // wording must not read as a failure.
    const v = verificationLines({ tool: "tq", path: null, output: null });
    expect(v.satisfied).toBe(false);
    expect(said({ tool: "tq", path: null, output: null })).toContain("warn tq is not on PATH yet");
  });

  test("a binary that will not run is reported as such", () => {
    const v = verificationLines({ tool: "red", path: "/usr/bin/red", output: null });
    expect(v.satisfied).toBe(false);
    expect(said({ tool: "red", path: "/usr/bin/red", output: null })).toContain(
      "warn red --version did not run",
    );
  });

  test("output carrying no version, under an expectation, is not satisfied", () => {
    const v = verificationLines({
      tool: "docker",
      path: "/usr/bin/docker",
      output: "Docker version unknown",
      minVersion: "20.0.0",
    });
    expect(v.satisfied).toBe(false);
    expect(v.version).toBeNull();
  });

  test("a managed item has no binary and is not asked for one", () => {
    // A font, a settings tree. "not on PATH" about one of those is a
    // false alarm on every single run.
    const v = verificationLines({ tool: "nerd-font", path: null, output: null, managed: true });
    expect(v.satisfied).toBe(true);
    expect(v.lines).toEqual([]);
  });

  test("only the first line of --version output is quoted", () => {
    // Several of these print a paragraph. A verification that pastes it
    // into the log destroys the row structure around it.
    const out = said({
      tool: "docker",
      path: "/usr/bin/docker",
      output: "Docker version 27.0.3, build abc\nlots\nmore\nlines",
    });
    expect(out).toContain("--version says: Docker version 27.0.3, build abc");
    expect(out).not.toContain("more");
  });
});
