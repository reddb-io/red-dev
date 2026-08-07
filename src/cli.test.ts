import { describe, expect, test } from "bun:test";
import { buildCli, parseArgs } from "./cli.ts";
import { DEFAULT_THEME, themeNames } from "./themes.ts";

const cli = buildCli();
const parse = (argv: string[]) => parseArgs(cli, argv);

describe("command parsing", () => {
  test("reads explicit unattended agent and runtime selections", () => {
    expect(parse(["agents", "claude-code,codex"]).agentKeys).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(parse(["lang", "node@lts,bun@latest"]).runtimeIds).toEqual([
      "node@lts",
      "bun@latest",
    ]);
  });

  test("reads the command and its positional", () => {
    const inv = parse(["install", "core"]);
    expect(inv.command).toBe("install");
    expect(inv.scope).toBe("core");
    expect(inv.errors).toEqual([]);
  });

  test("no arguments means no command, not an error", () => {
    // This is what opens the interactive menu, so it must stay distinct
    // from a rejected command.
    const inv = parse([]);
    expect(inv.command).toBeNull();
    expect(inv.errors).toEqual([]);
  });

  test("an unknown verb is rejected, and the message lists the real ones", () => {
    // Strict mode makes this a parse error rather than leaving the verb
    // in `rest` for us to notice. Worth pinning: without it, an
    // unrecognised command falls through to a null command, which is
    // also what "no arguments" looks like — and a typo would silently
    // open the interactive menu.
    const inv = parse(["frobnicate"]);
    expect(inv.command).toBeNull();
    const message = inv.errors.join(" ");
    expect(message).toContain("frobnicate");
    expect(message.toLowerCase()).toContain("unknown command");
  });
});

describe("validation", () => {
  test("rejects a scope that is not one of ours", () => {
    const inv = parse(["plan", "nonsense"]);
    expect(inv.errors.join(" ")).toContain("invalid scope");
  });

  test("rejects an unknown theme by name", () => {
    const inv = parse(["theme", "octarine"]);
    expect(inv.errors.join(" ")).toContain("unknown theme");
  });

  test("accepts every theme it advertises", () => {
    for (const name of themeNames()) {
      expect(parse(["theme", name]).errors).toEqual([]);
    }
  });

  test("rejects an unknown option", () => {
    expect(parse(["plan", "--banana"]).errors.length).toBeGreaterThan(0);
  });
});

describe("opacity", () => {
  test("defaults to a mild transparency", () => {
    expect(parse(["install"]).opacity).toBe(90);
  });

  test("accepts the full valid range", () => {
    expect(parse(["theme", "--opacity", "0"]).opacity).toBe(0);
    expect(parse(["theme", "--opacity", "100"]).opacity).toBe(100);
  });

  test("rejects out-of-range rather than silently ignoring it", () => {
    // Windows Terminal drops an invalid opacity without complaint: no
    // error and no effect, which is the worst way to fail.
    expect(parse(["theme", "--opacity", "150"]).errors.join(" ")).toContain(
      "between 0 and 100",
    );
    expect(parse(["theme", "--opacity", "-5"]).errors.join(" ")).toContain(
      "between 0 and 100",
    );
  });
});

describe("flags", () => {
  test("dry-run is off unless asked for", () => {
    expect(parse(["install"]).dryRun).toBe(false);
    expect(parse(["install", "--dry-run"]).dryRun).toBe(true);
  });

  test("font and theme carry their defaults", () => {
    const inv = parse(["install"]);
    expect(inv.font).toBe("firacode");
    expect(inv.themeName).toBe(DEFAULT_THEME);
  });
});
