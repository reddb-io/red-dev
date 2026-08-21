/**
 * What a companion converge installs, and what it refuses to reach for.
 *
 * Every fixture here is a directory on this disk. That is the point rather
 * than a convenience: the claim Spec #201 makes about companions is that a
 * machine converges them out of the selected package set, so a test that
 * let one of them resolve a GitHub release would be asserting the opposite
 * of the thing under test. The runner records every argv, and one case
 * reads that trace back looking for a URL — a companion that reached the
 * network would have to put it there.
 *
 * The other half is the state on disk afterwards: launchers that are
 * executable, layouts beside the operator's own, a herdr config that still
 * has their keys in it, and a registry row naming both the set digest and
 * the version of the artifact itself. A record written over a half-applied
 * plan is the failure this whole architecture replaced, so the failing
 * cases assert the absence of a record as carefully as the passing ones
 * assert its contents.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Platform } from "./platform.ts";
import type { Trigger } from "./trigger.ts";
import {
  companionReconciliationFailed,
  companionRegistryPath,
  COMPANION_ADAPTERS,
  EXTENSION_ID,
  PLUGIN_ID,
  pruneCompanionAssets,
  readCompanionRegistry,
  reconcileCompanions,
  redSkillsCompanionReport,
  redSkillsCompanionRows,
  removeCompanions,
  type CompanionOutcome,
  type CompanionReconcileOptions,
  setVsix,
} from "./red-skills-companions.ts";
import { ZELLIJ_COMPANION_FILE, ZELLIJ_LAYER_FILE } from "./zellij-layer.ts";

const UBUNTU: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false },
};

const SET_VERSION = "3.19.5";
const SET_DIGEST = "a".repeat(64);
const PLUGIN_VERSION = "0.4.1";
const STAMPED_AT = "2026-08-18T00:00:00.000Z";

/** The launcher names the core's `bin` map produces, minus the daemon's. */
const RUNTIME_LAUNCHERS = ["red-skills-dev", "red-skills-memory", "rsp"];
/** And the daemon's, which have a record of their own. */
const DAEMON_LAUNCHERS = ["redskilled", "redskilled-mcp"];

// ------------------------------------------------------------- the fixtures

interface SetOptions {
  /** Leave an artifact out, for the companion that then has none. */
  without?: ("vsix" | "herdr" | "zellij" | "daemon")[];
  /** The version the `.vsix` carries, which is not the set's. */
  vsixVersion?: string;
}

/** A package set with the shape composeSet produces, and its companions. */
function packageSet(opts: SetOptions = {}): string {
  const tree = mkdtempSync(join(tmpdir(), "red-companions-set-"));
  const without = opts.without ?? [];

  const bin: Record<string, string> = {
    "red-skills-dev": "bin/red-skills-dev.mjs",
    "red-skills-memory": "bin/red-skills-memory.mjs",
    rsp: "bin/rsp.mjs",
  };
  if (!without.includes("daemon")) {
    bin["red-skills-redskilled"] = "bin/red-skills-redskilled.mjs";
    bin["red-skills-redskilled-mcp"] = "bin/red-skills-redskilled-mcp.mjs";
  }

  mkdirSync(join(tree, "bin"), { recursive: true });
  for (const rel of Object.values(bin)) {
    writeFileSync(join(tree, rel), "#!/usr/bin/env node\n// a shim\n");
  }
  writeFileSync(
    join(tree, "package.json"),
    `${JSON.stringify({ name: "@reddb-io/red-skills", version: SET_VERSION, bin }, null, 2)}\n`,
  );

  mkdirSync(join(tree, "dist"), { recursive: true });
  writeFileSync(join(tree, "dist", "dev.bundle.min.mjs"), "// dev\n");
  if (!without.includes("daemon")) {
    writeFileSync(join(tree, "dist", "redskilled.bundle.min.mjs"), "// the daemon\n");
  }
  if (!without.includes("vsix")) {
    const version = opts.vsixVersion ?? SET_VERSION;
    writeFileSync(join(tree, "dist", `vscode-extension-red-skills-${version}.vsix`), "PK");
  }
  if (!without.includes("herdr")) {
    const dir = join(tree, "companions", "herdr");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "herdr-plugin.toml"),
      `plugin_id = "${PLUGIN_ID}"\nversion = "${PLUGIN_VERSION}"\n`,
    );
    writeFileSync(join(dir, "herdr-plugin-red-skills.bundle.min.mjs"), "// the plugin\n");
  }
  if (!without.includes("zellij")) {
    const dir = join(tree, "companions", "zellij");
    mkdirSync(join(dir, "layouts"), { recursive: true });
    writeFileSync(join(dir, "config.kdl"), ZELLIJ_FRAGMENT);
    writeFileSync(join(dir, "layouts", "red-skills.kdl"), "layout {\n    pane\n}\n");
  }
  return tree;
}

/** What the set asks zellij for: one binding, in red-dev's own base's shape. */
const ZELLIJ_FRAGMENT = `keybinds {
    shared_except "locked" {
        bind "Ctrl d" { Run "redskilled" "dashboard"; }
    }
}
`;

interface Machine {
  home: string;
  config: string;
  bin: string;
  tree: string;
  current: string;
  /** What each editor on this machine reports having. */
  installed: Map<string, string[]>;
}

/** A machine with a package set, an editor, herdr, zellij and a home. */
function machine(opts: SetOptions = {}): Machine {
  const home = mkdtempSync(join(tmpdir(), "red-companions-home-"));
  const config = join(home, ".config");
  mkdirSync(config, { recursive: true });
  return {
    home,
    config,
    bin: join(home, ".local", "bin"),
    tree: packageSet(opts),
    current: `${home}/.red/skills/current`,
    installed: new Map<string, string[]>([["code", []]]),
  };
}

/**
 * herdr and the editors, faked down to the state red-dev reads back.
 *
 * `herdr plugin link` writes the plugins.json herdr writes, and
 * `--install-extension` adds the id the editor would list afterwards,
 * because both of those files are what verification actually looks at. A
 * fake that only counted calls would let a companion be recorded on the
 * strength of a command that exited zero and did nothing.
 */
function runner(
  m: Machine,
  code: (cmd: string[]) => number = () => 0,
): { calls: string[][]; run: (cmd: string[]) => Promise<number> } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (cmd: string[]) => {
      calls.push(cmd);
      const forced = code(cmd);
      if (forced !== 0) return forced;

      if (cmd[0] === "herdr" && cmd[1] === "plugin" && cmd[2] === "link") {
        mkdirSync(join(m.config, "herdr"), { recursive: true });
        writeFileSync(
          join(m.config, "herdr", "plugins.json"),
          `${JSON.stringify([{ plugin_id: PLUGIN_ID, plugin_root: cmd[3], enabled: true }], null, 2)}\n`,
        );
      }
      if (cmd[0] === "herdr" && cmd[1] === "plugin" && cmd[2] === "unlink") {
        rmSync(join(m.config, "herdr", "plugins.json"), { force: true });
      }
      if (cmd[1] === "--install-extension") {
        m.installed.set(cmd[0] as string, [EXTENSION_ID]);
      }
      if (cmd[1] === "--uninstall-extension") {
        m.installed.set(cmd[0] as string, []);
      }
      return 0;
    },
  };
}

function reconcile(
  m: Machine,
  opts: CompanionReconcileOptions & { platform?: Platform } = {},
): Promise<CompanionOutcome[]> {
  const { platform, ...rest } = opts;
  return reconcileCompanions(platform ?? UBUNTU, {
    home: m.home,
    config: m.config,
    herdrDir: join(m.config, "herdr"),
    zellijDir: join(m.config, "zellij"),
    bin: m.bin,
    source: m.tree,
    current: m.current,
    setDigest: SET_DIGEST,
    setVersion: SET_VERSION,
    present: () => true,
    running: () => false,
    editors: () => [...m.installed.keys()],
    // Identity: this fixture is about the walk, and its fake runner
    // keys what it installed by the command it was given. Resolution to
    // a real executable is its own subject, below.
    resolve: (cli: string) => cli,
    extensions: async (cli: string) => m.installed.get(cli) ?? [],
    compose: async () => {},
    now: () => STAMPED_AT,
    run: runner(m).run,
    ...rest,
  });
}

function statusOf(out: readonly CompanionOutcome[], name: string): string | undefined {
  return out.find((o) => o.companion === name)?.status;
}

function reasonOf(out: readonly CompanionOutcome[], name: string): string {
  return out.find((o) => o.companion === name)?.reason ?? "";
}

function lines(calls: readonly string[][]): string[] {
  return calls.map((c) => c.join(" "));
}

/** The composition red-dev would write, run for real against this home. */
async function composeFor(m: Machine): Promise<string> {
  const home = process.env["HOME"];
  const xdg = process.env["XDG_CONFIG_HOME"];
  process.env["HOME"] = m.home;
  process.env["XDG_CONFIG_HOME"] = m.config;
  delete process.env["RED_SHARE_WIN"];
  try {
    const { installZellijConfig } = await import("./dotfiles.ts");
    await installZellijConfig(UBUNTU);
    return readFileSync(join(m.config, "zellij", "config.kdl"), "utf8");
  } finally {
    if (home === undefined) delete process.env["HOME"];
    else process.env["HOME"] = home;
    if (xdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = xdg;
  }
}

// --------------------------------------------------------------- the five

describe("the five companion surfaces", () => {
  test("are the ones in the table, by name and in walk order", () => {
    expect(COMPANION_ADAPTERS.map((a) => a.name)).toEqual([
      "runtimes",
      "redskilled",
      "herdr",
      "vscode",
      "zellij",
    ]);
  });

  test("a first converge installs every one of them from the set", async () => {
    const m = machine();
    const out = await reconcile(m);

    expect(out.map((o) => o.companion)).toEqual(COMPANION_ADAPTERS.map((a) => a.name));
    for (const o of out) expect(o.status, `${o.companion}: ${o.reason ?? ""}`).toBe("reconciled");
  });

  test("and reaches nothing outside this machine to do it", async () => {
    // The whole claim of the slice, asserted the only way it can be: a
    // release resolved, an npm registry read or a tarball fetched would
    // all have to appear as an argument to something.
    const m = machine();
    const { calls, run } = runner(m);
    await reconcile(m, { run });

    for (const line of lines(calls)) {
      expect(line, line).not.toMatch(/https?:|github\.com|npm |registry\./);
    }
  });
});

// ---------------------------------------------------------- the launchers

describe("the runtimes and the daemon", () => {
  test("land on PATH as launchers that resolve through the active set", async () => {
    const m = machine();
    await reconcile(m);

    for (const name of RUNTIME_LAUNCHERS) {
      const path = join(m.bin, name);
      expect(existsSync(path), name).toBe(true);
      expect(readFileSync(path, "utf8")).toContain(`${m.current}/bin/`);
    }
    for (const name of DAEMON_LAUNCHERS) expect(existsSync(join(m.bin, name)), name).toBe(true);
  });

  test("executable, because a launcher that is not is a companion nobody can run", async () => {
    const m = machine();
    await reconcile(m);
    expect(statSync(join(m.bin, "red-skills-dev")).mode & 0o111).toBeGreaterThan(0);
  });

  test("the daemon's two are the daemon's record, not the runtimes'", async () => {
    const m = machine();
    await reconcile(m);
    const owned = readCompanionRegistry(m.home).companions["runtimes"]?.owned ?? [];
    const paths = owned.flatMap((e) => (e.kind === "path" ? [e.path] : []));

    for (const name of DAEMON_LAUNCHERS) expect(paths).not.toContain(join(m.bin, name));
    for (const name of RUNTIME_LAUNCHERS) expect(paths).toContain(join(m.bin, name));
  });

  test("a set with no daemon bundle is unavailable rather than failed", async () => {
    const m = machine({ without: ["daemon"] });
    const out = await reconcile(m);

    expect(statusOf(out, "redskilled")).toBe("unavailable");
    expect(companionReconciliationFailed(out)).toBe(false);
    expect(readCompanionRegistry(m.home).companions["redskilled"]).toBeUndefined();
  });

  test("a running daemon is told to restart, never signalled", async () => {
    const m = machine();
    const { calls } = runner(m);
    const out = await reconcile(m, { running: (cmd) => cmd === "redskilled", run: runner(m).run });

    expect(out.find((o) => o.companion === "redskilled")?.reload).toBe("restart-needed");
    expect(lines(calls).join("\n")).not.toMatch(/kill|systemctl|restart/);
  });
});

// ------------------------------------------------------------- the record

describe("what every companion record says", () => {
  test("the package-set digest, and the version of the artifact itself", async () => {
    // Two different facts, and the reason both are recorded: the set is
    // 3.19.5 and the extension in it is 4.2.0, so a row that carried only
    // one of them could not answer "which extension is on this machine".
    const m = machine({ vsixVersion: "4.2.0" });
    await reconcile(m);
    const companions = readCompanionRegistry(m.home).companions;

    for (const record of Object.values(companions)) {
      expect(record.setDigest).toBe(SET_DIGEST);
      expect(record.setVersion).toBe(SET_VERSION);
      expect(record.verifiedAt).toBe(STAMPED_AT);
    }
    expect(companions["vscode"]?.version).toBe("4.2.0");
    expect(companions["herdr"]?.version).toBe(PLUGIN_VERSION);
    expect(companions["runtimes"]?.version).toBe(SET_VERSION);
  });

  test("doctor renders both, and names what has no record yet", async () => {
    const m = machine({ without: ["zellij"] });
    await reconcile(m);
    const rows = redSkillsCompanionRows(redSkillsCompanionReport(m.home));

    expect(rows.some((r) => r.detail.includes(`vscode ${SET_VERSION}`))).toBe(true);
    expect(rows.some((r) => r.detail.includes(SET_DIGEST.slice(0, 12)))).toBe(true);
    expect(rows.at(-1)?.detail).toContain("no observed record yet: zellij");
  });
});

// ------------------------------------------------------------ idempotence

describe("a second converge", () => {
  test("issues no commands at all", async () => {
    const m = machine();
    await reconcile(m);

    const { calls, run } = runner(m);
    const out = await reconcile(m, { run });
    expect(calls).toEqual([]);
    for (const o of out) expect(o.status, o.companion).toBe("current");
  });

  test("reinstalls the companion whose state somebody deleted", async () => {
    const m = machine();
    await reconcile(m);
    rmSync(join(m.bin, "rsp"));

    const out = await reconcile(m);
    expect(statusOf(out, "runtimes")).toBe("reconciled");
    expect(statusOf(out, "vscode")).toBe("current");
    expect(existsSync(join(m.bin, "rsp"))).toBe(true);
  });

  test("reinstalls everything when the set digest moves", async () => {
    const m = machine();
    await reconcile(m);
    const out = await reconcile(m, { setDigest: "b".repeat(64) });
    for (const o of out) expect(o.status, o.companion).toBe("reconciled");
  });

  test("reinstalls the extension an editor dropped underneath it", async () => {
    const m = machine();
    await reconcile(m);
    m.installed.set("code", []);

    const out = await reconcile(m);
    expect(statusOf(out, "vscode")).toBe("reconciled");
    expect(m.installed.get("code")).toEqual([EXTENSION_ID]);
  });
});

// ------------------------------------------------------------- the editor

describe("the editor guarantee", () => {
  test("every compatible editor present gets the same revision", async () => {
    const m = machine();
    m.installed.set("codium", []);
    m.installed.set("cursor", []);

    const { calls, run } = runner(m);
    await reconcile(m, { run });

    const installs = lines(calls).filter((l) => l.includes("--install-extension"));
    expect(installs).toHaveLength(3);
    for (const cli of ["code", "codium", "cursor"]) {
      expect(installs.some((l) => l.startsWith(`${cli} `)), cli).toBe(true);
      expect(m.installed.get(cli)).toEqual([EXTENSION_ID]);
    }
    // One revision, out of one set: the same file into all three.
    expect(new Set(installs.map((l) => l.split(" ")[2])).size).toBe(1);
  });

  test("a clean machine with no editor has VS Code installed for it", async () => {
    const m = machine();
    m.installed.clear();
    let asked = 0;

    const out = await reconcile(m, {
      // Typed: the guarantee is a thing a person asked for. Every other
      // trigger defers it — see the two tests below.
      trigger: "typed",
      editors: () => [...m.installed.keys()],
      installEditor: async () => {
        asked++;
        m.installed.set("code", []);
        return ["code"];
      },
    });

    expect(asked).toBe(1);
    expect(statusOf(out, "vscode")).toBe("reconciled");
    expect(m.installed.get("code")).toEqual([EXTENSION_ID]);
  });

  test("and is not asked for when the set carries no extension", async () => {
    const m = machine({ without: ["vsix"] });
    m.installed.clear();
    let asked = 0;

    const out = await reconcile(m, {
      editors: () => [],
      installEditor: async () => {
        asked++;
        return [];
      },
    });

    expect(asked).toBe(0);
    expect(statusOf(out, "vscode")).toBe("unavailable");
  });

  test("an editor that cannot be installed blocks rather than pretends", async () => {
    const m = machine();
    m.installed.clear();

    const out = await reconcile(m, {
      trigger: "typed",
      editors: () => [],
      installEditor: async () => [],
    });
    expect(statusOf(out, "vscode")).toBe("blocked");
    expect(companionReconciliationFailed(out)).toBe(true);
    expect(readCompanionRegistry(m.home).companions["vscode"]).toBeUndefined();
  });

  test("a run nobody is watching defers the editor instead of installing one", async () => {
    const m = machine();
    m.installed.clear();
    let asked = 0;

    // What the ten-minute timer is. It found no editor twenty times in a
    // row and each time was entitled to add an apt repository, import a
    // signing key and install a desktop editor to fix it.
    const out = await reconcile(m, {
      trigger: "timer",
      editors: () => [],
      installEditor: async () => {
        asked++;
        return [];
      },
    });

    expect(asked).toBe(0);
    expect(statusOf(out, "vscode")).toBe("deferred");
    // Deferred is not stuck: the machine did what it was allowed to.
    expect(companionReconciliationFailed(out)).toBe(false);
    expect(reasonOf(out, "vscode")).toContain("red-dev install");
  });

  test("a machine with no display of its own never installs an editor, typed or not", async () => {
    const m = machine();
    m.installed.clear();
    let asked = 0;

    // WSL: caps.gui is false because the display belongs to the host, and
    // the host's editor already carries the extension.
    const out = await reconcile(m, {
      platform: { ...UBUNTU, env: "wsl", caps: { ...UBUNTU.caps, gui: false } },
      trigger: "typed",
      editors: () => [],
      installEditor: async () => {
        asked++;
        return [];
      },
    });

    expect(asked).toBe(0);
    expect(statusOf(out, "vscode")).toBe("deferred");
    expect(companionReconciliationFailed(out)).toBe(false);
    expect(reasonOf(out, "vscode")).toContain("Windows half");
  });

  test("a machine with no display drives no editor either, even one it can see", async () => {
    const m = machine();
    // The host's editor, reachable over interop and already carrying the
    // extension. Handing it a Linux path is what hung the run for two
    // minutes; the whole companion defers instead.
    const out = await reconcile(m, {
      platform: { ...UBUNTU, env: "wsl", caps: { ...UBUNTU.caps, gui: false } },
      trigger: "typed",
      editors: () => ["code"],
      run: async (cmd) => {
        if (cmd.includes("--install-extension")) {
          throw new Error("no editor may be driven from a machine with no display");
        }
        return runner(m).run(cmd);
      },
    });

    expect(statusOf(out, "vscode")).toBe("deferred");
    expect(companionReconciliationFailed(out)).toBe(false);
  });
});

// ------------------------------------------------- configuration that is not ours

describe("the herdr merge", () => {
  test("links the plugin from inside the set and binds one key", async () => {
    const m = machine();
    const { calls, run } = runner(m);
    await reconcile(m, { run });

    expect(lines(calls)).toContain(`herdr plugin link ${join(m.tree, "companions", "herdr")} --enabled`);
    expect(readFileSync(join(m.config, "herdr", "config.toml"), "utf8")).toContain('key = "prefix+d"');
  });

  test("preserves every unrelated value the operator wrote", async () => {
    const mine = `[theme]\nname = "tokyo-night"\n\n[[keys.command]]\nkey = "prefix+g"\ntype = "shell"\ncommand = "lazygit"\n`;
    const m = machine();
    mkdirSync(join(m.config, "herdr"), { recursive: true });
    const path = join(m.config, "herdr", "config.toml");
    writeFileSync(path, mine);

    await reconcile(m);
    const after = readFileSync(path, "utf8");
    expect(after.startsWith(mine.trimEnd())).toBe(true);
    expect(after).toContain(`--plugin ${PLUGIN_ID}`);
  });

  test("stands down from a prefix+d the operator already bound", async () => {
    const mine = `[[keys.command]]\nkey = "prefix+d"\ntype = "shell"\ncommand = "lazydocker"\n`;
    const m = machine();
    mkdirSync(join(m.config, "herdr"), { recursive: true });
    const path = join(m.config, "herdr", "config.toml");
    writeFileSync(path, mine);

    const out = await reconcile(m);
    expect(readFileSync(path, "utf8")).toBe(mine);
    // Still installed: the plugin is the companion, and the shortcut is a
    // convenience the operator is allowed to have spent elsewhere.
    expect(statusOf(out, "herdr")).toBe("reconciled");
  });

  test("a herdr that is not installed is absent, not failed", async () => {
    const m = machine();
    const out = await reconcile(m, { present: (cmd) => cmd !== "herdr" });

    expect(statusOf(out, "herdr")).toBe("absent");
    expect(companionReconciliationFailed(out)).toBe(false);
  });

  test("herdr linking something else is a failure, not a record", async () => {
    const m = machine();
    const out = await reconcile(m, {
      run: async (cmd: string[]) => {
        if (cmd[2] === "link") {
          mkdirSync(join(m.config, "herdr"), { recursive: true });
          writeFileSync(
            join(m.config, "herdr", "plugins.json"),
            `${JSON.stringify([{ plugin_id: PLUGIN_ID, plugin_root: "/somewhere/else" }])}\n`,
          );
        }
        return 0;
      },
    });

    expect(statusOf(out, "herdr")).toBe("failed");
    expect(readCompanionRegistry(m.home).companions["herdr"]).toBeUndefined();
  });
});

describe("the zellij merge", () => {
  test("writes the set's layouts beside the operator's own", async () => {
    const m = machine();
    const mine = join(m.config, "zellij", "layouts", "mine.kdl");
    mkdirSync(join(m.config, "zellij", "layouts"), { recursive: true });
    writeFileSync(mine, "layout {\n    pane\n}\n");

    await reconcile(m);
    expect(existsSync(join(m.config, "zellij", "layouts", "red-skills.kdl"))).toBe(true);
    expect(existsSync(mine)).toBe(true);
  });

  test("the fragment is composed into config.kdl, and the operator wins over it", async () => {
    const m = machine();
    await reconcile(m, { compose: async () => {} });

    // The layer says something about the same binding the set does, and
    // is written last on purpose: config.user.kdl is the one file red-dev
    // never rewrites, so whatever it declares has to survive both of the
    // other two authors.
    mkdirSync(join(m.config, "zellij"), { recursive: true });
    writeFileSync(
      join(m.config, "zellij", ZELLIJ_LAYER_FILE),
      'keybinds {\n    shared_except "locked" {\n        bind "Ctrl d" { Quit; }\n    }\n}\n',
    );

    const composed = await composeFor(m);
    expect(readFileSync(join(m.config, "zellij", ZELLIJ_COMPANION_FILE), "utf8")).toContain("redskilled");
    expect(composed).toContain('bind "Ctrl d" { Quit; }');
    expect(composed).not.toContain('Run "redskilled" "dashboard"');
  });

  test("and lands in config.kdl on a machine with no layer of its own", async () => {
    const m = machine();
    await reconcile(m, { compose: async () => {} });
    const composed = await composeFor(m);
    expect(composed).toContain('Run "redskilled" "dashboard"');
  });

  test("a set with no zellij surface is unavailable", async () => {
    const m = machine({ without: ["zellij"] });
    const out = await reconcile(m);
    expect(statusOf(out, "zellij")).toBe("unavailable");
  });
});

// ------------------------------------------------------------- the failures

describe("a companion that fails", () => {
  test("fails the reconciliation and stamps nothing", async () => {
    const m = machine();
    const out = await reconcile(m, {
      run: runner(m, (cmd) => (cmd[1] === "--install-extension" ? 1 : 0)).run,
    });

    expect(statusOf(out, "vscode")).toBe("failed");
    expect(companionReconciliationFailed(out)).toBe(true);
    expect(readCompanionRegistry(m.home).companions["vscode"]).toBeUndefined();
  });

  test("leaves the artifact that was working exactly where it was", async () => {
    // The rule Spec #201 draws around a failed update: the machine keeps
    // the revision it had. Nothing is uninstalled on the way in, so the
    // editor still lists the extension it listed before.
    const m = machine();
    await reconcile(m);
    const before = readCompanionRegistry(m.home).companions["vscode"];

    const out = await reconcile(m, {
      setDigest: "c".repeat(64),
      run: runner(m, (cmd) => (cmd[1] === "--install-extension" ? 1 : 0)).run,
    });

    expect(statusOf(out, "vscode")).toBe("failed");
    expect(m.installed.get("code")).toEqual([EXTENSION_ID]);
    expect(readCompanionRegistry(m.home).companions["vscode"]).toEqual(before);
  });

  test("does not stop the companions after it", async () => {
    const m = machine();
    const out = await reconcile(m, {
      run: runner(m, (cmd) => (cmd[0] === "herdr" && cmd[2] === "link" ? 1 : 0)).run,
    });

    expect(statusOf(out, "herdr")).toBe("failed");
    expect(statusOf(out, "vscode")).toBe("reconciled");
    expect(statusOf(out, "zellij")).toBe("reconciled");
  });

  test("a machine with no package set has nothing to converge", async () => {
    const m = machine();
    expect(await reconcile(m, { source: null })).toEqual([]);
    expect(existsSync(companionRegistryPath(m.home))).toBe(false);
  });
});

// ------------------------------------------------------------ the retention

describe("the artifact cache", () => {
  test("keeps what the active and previous revisions could still want", () => {
    const home = mkdtempSync(join(tmpdir(), "red-companions-cache-"));
    const cache = join(home, ".local", "share", "red-dev", "red-skills-assets");
    mkdirSync(cache, { recursive: true });
    for (const version of ["3.19.5", "3.19.4", "3.10.0"]) {
      writeFileSync(join(cache, `vscode-extension-red-skills-${version}.vsix`), "PK");
    }

    const dropped = pruneCompanionAssets(home, ["3.19.5", "3.19.4"]);
    expect(dropped).toHaveLength(1);
    expect(existsSync(join(cache, "vscode-extension-red-skills-3.10.0.vsix"))).toBe(false);
    expect(existsSync(join(cache, "vscode-extension-red-skills-3.19.5.vsix"))).toBe(true);
    expect(existsSync(join(cache, "vscode-extension-red-skills-3.19.4.vsix"))).toBe(true);
  });

  test("and a converge sweeps it without touching the set", async () => {
    const m = machine();
    const cache = join(m.home, ".local", "share", "red-dev", "red-skills-assets");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "vscode-extension-red-skills-1.0.0.vsix"), "PK");

    await reconcile(m);
    expect(existsSync(join(cache, "vscode-extension-red-skills-1.0.0.vsix"))).toBe(false);
    expect(existsSync(join(m.tree, "dist", `vscode-extension-red-skills-${SET_VERSION}.vsix`))).toBe(true);
  });
});

// -------------------------------------------------------------- the removal

describe("removing the companions", () => {
  test("takes back exactly what the record named", async () => {
    const m = machine();
    await reconcile(m);

    const out = await removeCompanions(UBUNTU, {
      home: m.home,
      config: m.config,
      herdrDir: join(m.config, "herdr"),
      zellijDir: join(m.config, "zellij"),
      bin: m.bin,
      source: m.tree,
      editors: () => [...m.installed.keys()],
      run: runner(m).run,
    });

    expect(out.every((o) => o.removed)).toBe(true);
    for (const name of [...RUNTIME_LAUNCHERS, ...DAEMON_LAUNCHERS]) {
      expect(existsSync(join(m.bin, name)), name).toBe(false);
    }
    expect(m.installed.get("code")).toEqual([]);
    expect(readCompanionRegistry(m.home).companions).toEqual({});
  });

  test("and leaves every line of the operator's config that was theirs", async () => {
    const mine = `[theme]\nname = "tokyo-night"\n`;
    const m = machine();
    mkdirSync(join(m.config, "herdr"), { recursive: true });
    const path = join(m.config, "herdr", "config.toml");
    writeFileSync(path, mine);

    await reconcile(m);
    await removeCompanions(UBUNTU, {
      home: m.home,
      config: m.config,
      herdrDir: join(m.config, "herdr"),
      zellijDir: join(m.config, "zellij"),
      bin: m.bin,
      source: m.tree,
      run: runner(m).run,
    });

    expect(readFileSync(path, "utf8")).toBe(mine);
  });
});

describe("finding the extension inside a set", () => {
  function setWith(layout: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "red-vsix-"));
    for (const [path, name] of Object.entries(layout)) {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, path, name), "PK");
    }
    return root;
  }

  test("a published set keeps it in artifacts/, which is where it now looks", () => {
    // The bug this closes had three halves and none of them met: the
    // `.vsix` is deliberately not overlaid into the tree, activation
    // did not carry `artifacts/` across, and the companion searched the
    // tree only. So doctor reported "the package set carries no .vsix"
    // about a set whose signed manifest declares one.
    const source = setWith({ artifacts: "vscode-extension-red-skills-4.0.4.vsix" });
    expect(setVsix(source)).toBe(join(source, "artifacts", "vscode-extension-red-skills-4.0.4.vsix"));
  });

  test("a set that groups its companions still wins over artifacts/", () => {
    const source = setWith({
      "companions/vscode": "vscode-extension-red-skills-4.0.4.vsix",
      artifacts: "vscode-extension-red-skills-4.0.4.vsix",
    });
    expect(setVsix(source)).toContain(join("companions", "vscode"));
  });

  test("dist/ still answers, which is what a composed set has", () => {
    const source = setWith({ dist: "vscode-extension-red-skills-3.22.0.vsix" });
    expect(setVsix(source)).toContain("dist");
  });

  test("a set with no extension anywhere is still null, not a guess", () => {
    expect(setVsix(setWith({ dist: "something-else.txt" }))).toBeNull();
  });
});

/** The fields the vscode adapter's plan actually reads. */
function companionCtx(
  source: string,
  editors: string[],
  resolve: (cli: string) => string | null,
  over: { platform?: Platform; trigger?: Trigger } = {},
): Parameters<(typeof COMPANION_ADAPTERS)[number]["plan"]>[0] {
  return {
    platform: over.platform ?? UBUNTU,
    trigger: over.trigger ?? "typed",
    source,
    setDigest: SET_DIGEST,
    setVersion: SET_VERSION,
    current: source,
    home: source,
    config: source,
    herdrDir: null,
    zellijDir: source,
    bin: source,
    editors,
    resolve,
    extensionsOf: async () => [],
    compose: async () => {},
  };
}

describe("installing the extension on Windows", () => {
  test("the step names the resolved executable, not the bare command", () => {
    // `where code` lists two files: `code`, a shell script Windows
    // cannot execute, and `code.cmd`, which it can. Spawning the name
    // took the first and failed with ENOENT while `code` was on PATH
    // and working — see commandPath in src/agents.ts.
    const vscode = COMPANION_ADAPTERS.find((a) => a.name === "vscode")!;
    const source = mkdtempSync(join(tmpdir(), "red-vsix-win-"));
    mkdirSync(join(source, "artifacts"), { recursive: true });
    writeFileSync(join(source, "artifacts", "vscode-extension-red-skills-4.0.11.vsix"), "PK");

    const plan = vscode.plan(
      companionCtx(source, ["code"], (cli) => `C:\\VS Code\\bin\\${cli}.cmd`),
    );

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.argv[0]).toBe("C:\\VS Code\\bin\\code.cmd");
  });

  test("a resolver that answers nothing leaves the name, and the failure explains itself", () => {
    const vscode = COMPANION_ADAPTERS.find((a) => a.name === "vscode")!;
    const source = mkdtempSync(join(tmpdir(), "red-vsix-none-"));
    mkdirSync(join(source, "artifacts"), { recursive: true });
    writeFileSync(join(source, "artifacts", "vscode-extension-red-skills-4.0.11.vsix"), "PK");

    const plan = vscode.plan(companionCtx(source, ["codium"], () => null));
    expect(plan.steps[0]?.argv[0]).toBe("codium");
  });
});
