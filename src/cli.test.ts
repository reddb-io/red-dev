import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildCli, parseArgs } from "./cli.ts";
import { missingRights } from "./rights.ts";
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
    expect(parse(["lang", "--latest", "node,python"])).toMatchObject({
      runtimeIds: ["node", "python"],
      latest: true,
    });
  });

  test("reads the agents subcommands as subcommands, not as agent keys", () => {
    expect(parse(["agents", "default", "codex"])).toMatchObject({
      agentDefault: true,
      agentDefaultKey: "codex",
      agentKeys: undefined,
      errors: [],
    });
    expect(parse(["agents", "run"])).toMatchObject({
      agentRun: true,
      agentKeys: undefined,
      passthrough: [],
      errors: [],
    });
    expect(parse(["agents", "update"])).toMatchObject({
      agentUpdate: true,
      agentRun: false,
      agentDefault: false,
      agentKeys: undefined,
      errors: [],
    });
  });

  test("`agents update` is a command a person can find without being told", () => {
    // A subcommand that parses and appears nowhere in --help exists only
    // for whoever already knew about it.
    expect(buildCli().help(["agents"])).toContain("update");
  });

  test("the keys viewer and Learn are commands, and findable in --help", () => {
    // Reachable non-interactively, like everything else the menu
    // offers: a section that exists only inside the interface is a
    // section nobody can put in a script, a bug report or a remedy.
    expect(parse(["keys"])).toMatchObject({ command: "keys", errors: [] });
    expect(parse(["learn"])).toMatchObject({ command: "learn", errors: [] });
    const help = buildCli().help();
    expect(help).toContain("keys");
    expect(help).toContain("learn");
  });

  test("the keys viewer takes no arguments, and says so rather than ignoring them", () => {
    // The search is typed into the viewer. A query silently swallowed
    // here would look like a viewer that cannot search.
    expect(parse(["keys", "--query", "terminal"]).errors.length).toBeGreaterThan(0);
  });

  test("keeps what follows `--` for the program red-dev starts", () => {
    // Strict mode would otherwise reject these as unknown options of
    // ours. They are the person's arguments to their own agent — up to
    // and including the one red-dev will never add itself.
    const inv = parse(["agents", "run", "--", "--dangerously-skip-permissions", "-p", "hi"]);
    expect(inv).toMatchObject({ command: "agents", agentRun: true, errors: [] });
    expect(inv.passthrough).toEqual(["--dangerously-skip-permissions", "-p", "hi"]);
  });

  test("reads a wallpaper independently from the theme", () => {
    expect(parse(["wallpaper", "flare"])).toMatchObject({
      command: "wallpaper",
      wallpaperName: "flare",
      errors: [],
    });
    expect(parse(["wallpaper", "theme"]).errors).toEqual([]);
    expect(parse(["wallpaper", "C:\\Users\\filipe\\Pictures\\wall.png"])).toMatchObject({
      wallpaperName: "C:\\Users\\filipe\\Pictures\\wall.png",
      errors: [],
    });
    expect(parse(["wallpaper", "https://example.com/wall.png?variant=wide"])).toMatchObject({
      wallpaperName: "https://example.com/wall.png?variant=wide",
      errors: [],
    });
  });

  test("reads the command and its positional", () => {
    const inv = parse(["install", "core"]);
    expect(inv.command).toBe("install");
    expect(inv.scope).toBe("core");
    expect(inv.errors).toEqual([]);
  });

  test("the command a deferred converge names is typeable exactly as printed", () => {
    // `red-dev privileged` is printed to an operator as the way to
    // finish work a converge deferred, so a rename here turns a remedy
    // into an unknown-command error at the worst possible moment.
    const inv = parse(["privileged"]);
    expect(inv.command).toBe("privileged");
    expect(inv.errors).toEqual([]);
    expect(missingRights("administrator").remedy).toContain("red-dev privileged");
  });

  test("the repository statusline is one stable red-dev command", () => {
    const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8")) as {
      statusLine: { command: string };
    };
    expect(settings.statusLine.command).toBe("bun run src/main.ts statusline");
    expect(parse(["statusline"]).errors).toEqual([]);
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

  test("Rescue and Reclaim are previews until apply is explicitly requested", () => {
    expect(parse(["rescue"])).toMatchObject({ command: "rescue", apply: false, yes: false });
    expect(parse(["rescue", "--apply", "--yes"])).toMatchObject({
      command: "rescue",
      apply: true,
      yes: true,
    });
    expect(parse(["reclaim", "/work/reddb", "--apply", "--crash-dumps", "--package-caches", "--build-cache"])).toMatchObject({
      command: "reclaim",
      apply: true,
      crashDumps: true,
      packageCaches: true,
      buildCache: true,
      reclaimWorkspace: "/work/reddb",
    });
  });
});
