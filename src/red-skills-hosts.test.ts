/**
 * What a converge asks the seven hosts, and what it refuses to write down.
 *
 * Two observables are held here and nothing else. The first is the command
 * trace: a reconciliation that "decided" not to run and issued the commands
 * anyway is the bug, and so is one that reports a host as current after the
 * host refused. The second is the state on disk afterwards — the generated
 * trees, the projected extensions, the operator's own settings file — which
 * is the half the retired stamp never looked at and the half this module
 * exists to observe.
 *
 * So the runner is injected and the hosts are fakes, but the package set is
 * a real tree with real generators in it, and the generators really run.
 * That is the only way to assert the thing the split exists for: a skill
 * added to the tree appears on the machine with nothing here changed, and
 * removal takes back what the generator's own manifest recorded rather than
 * what this repo guesses.
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { Platform } from "./platform.ts";
import { activatedPlugins } from "./red-skills-plugins.ts";
import { hostActivationConfig } from "./red-skills-set.ts";
import {
  HOST_ADAPTERS,
  readHostRegistry,
  reconcileSkillHosts,
  redSkillsHostReport,
  redSkillsHostRows,
  removeSkillHosts,
  type AdapterContext,
  type HostAdapter,
  type HostOutcome,
  type HostReconcileOptions,
  reconciliationFailed,
} from "./red-skills-hosts.ts";

const UBUNTU: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false },
};

/** What the set carries, and what red-dev switches on out of it. */
const CARRIED = ["dev", "memory"];
const ACTIVATED = ["dev"];

/** The hosts red-dev drives with an application's own CLI. */
const MARKETPLACE_HOSTS = ["claude", "codex"];
/** The hosts a generator inside the set wires. */
const GENERATOR_HOSTS = ["opencode", "redcode", "pi"];
/** The hosts red-dev projects itself, because the set ships no generator. */
const PROJECTED_HOSTS = ["gemini", "hermes"];

const STAMPED_AT = "2026-08-18T00:00:00.000Z";

// ------------------------------------------------------------- the fixtures

/**
 * A generator, faked down to the two things red-dev knows about it.
 *
 * It renders every skill of every plugin the set's activation config
 * enables, and it records every path it wrote in an uninstall manifest that
 * its own `--uninstall` reads back. Everything else about the real script
 * is deliberately on the other side of the fence.
 */
function opencodeGenerator(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
tree="$(cd "$(dirname "$0")/.." && pwd)"
action=install
host=opencode
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) action=uninstall ;;
    --host) host="$2"; shift ;;
  esac
  shift
done
config="\${XDG_CONFIG_HOME:?}/$host"
manifest="$config/redskills-install-manifest.txt"
if [[ "$action" == "uninstall" ]]; then
  if [[ -f "$manifest" ]]; then
    while IFS= read -r path || [[ -n "$path" ]]; do
      if [[ -n "$path" ]]; then rm -rf "$path"; fi
    done < "$manifest"
    rm -f "$manifest"
  fi
  exit 0
fi
mkdir -p "$config/skills"
: > "$manifest"
for plugin in "$tree"/plugins/*/; do
  name="$(basename "$plugin")"
  flag="$(awk -v want="  $name:" '$0 == want { found = 1; next } found { print; exit }' "$tree/.red/config.yaml")"
  case "$flag" in *"enabled: true"*) ;; *) continue ;; esac
  for skill in "$plugin"skills/*/SKILL.md; do
    [[ -f "$skill" ]] || continue
    s="$(basename "$(dirname "$skill")")"
    mkdir -p "$config/skills/$s"
    cp "$skill" "$config/skills/$s/SKILL.md"
    printf '%s\\n' "$config/skills/$s" >> "$manifest"
  done
done
`;
}

/** pi's, which writes under the home rather than under the config root. */
function piGenerator(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
tree="$(cd "$(dirname "$0")/.." && pwd)"
action=install
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) action=uninstall ;;
    --source-dir) tree="$2"; shift ;;
  esac
  shift
done
config="\${HOME:?}/.pi"
manifest="$config/redskills-install-manifest.txt"
if [[ "$action" == "uninstall" ]]; then
  if [[ -f "$manifest" ]]; then
    while IFS= read -r path || [[ -n "$path" ]]; do
      if [[ -n "$path" ]]; then rm -rf "$path"; fi
    done < "$manifest"
    rm -f "$manifest"
  fi
  exit 0
fi
mkdir -p "$config/skills"
: > "$manifest"
for plugin in "$tree"/plugins/*/; do
  name="$(basename "$plugin")"
  flag="$(awk -v want="  $name:" '$0 == want { found = 1; next } found { print; exit }' "$tree/.red/config.yaml")"
  case "$flag" in *"enabled: true"*) ;; *) continue ;; esac
  for skill in "$plugin"skills/*/SKILL.md; do
    [[ -f "$skill" ]] || continue
    s="$(basename "$(dirname "$skill")")"
    mkdir -p "$config/skills/$s"
    cp "$skill" "$config/skills/$s/SKILL.md"
    printf '%s\\n' "$config/skills/$s" >> "$manifest"
  done
done
`;
}

interface SetOptions {
  /** Skills the `dev` plugin carries. */
  skills?: string[];
  /**
   * Whether `dev` declares an MCP server for a host to project.
   *
   * `"dangling"` declares one whose script is not in the set — the shape a
   * half-composed package set has, and the one a host must refuse.
   */
  mcp?: boolean | "dangling";
  /** Whether `dev` declares hooks, and whether their scripts are there. */
  hooks?: "declared" | "dangling";
  /**
   * Whether the first `dev` skill carries a payload beside its `SKILL.md`.
   *
   * A skill is a directory: the references it cites and the scripts it runs
   * are as much of it as the entry point. `"dangling"` cites one the set
   * does not carry — the shape a half-composed set has, and the one a
   * skills-only host must refuse before it writes anything.
   */
  assets?: boolean | "dangling";
  /** Whether `dev` carries agent definitions, which no skills-only host loads. */
  agents?: boolean;
  /** Generators to leave out, for the hosts that then have none. */
  without?: string[];
}

/** A package set: the shape composeSet produces, small enough to hash. */
function packageSet(opts: SetOptions = {}): string {
  const tree = mkdtempSync(join(tmpdir(), "red-hosts-set-"));
  const without = opts.without ?? [];

  mkdirSync(join(tree, "scripts"), { recursive: true });
  for (const [name, body] of [
    ["install-opencode.sh", opencodeGenerator()],
    ["install-pi.sh", piGenerator()],
  ] as const) {
    if (without.includes(name)) continue;
    const path = join(tree, "scripts", name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  const carried = opts.skills ?? ["shipped"];
  for (const skill of carried) addSkill(tree, "dev", skill);
  if (opts.assets !== undefined && carried[0] !== undefined) addAssets(tree, carried[0], opts.assets);
  if (opts.agents === true) {
    const dir = join(tree, "plugins", "dev", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "reviewer.md"), "---\nname: reviewer\n---\n");
  }
  // A payload the set carries and nothing activates. Every assertion about
  // "only dev" is really an assertion that this one never lands.
  addSkill(tree, "memory", "memory-only");

  if (opts.mcp !== false) {
    // The dangling variant names a script by path, which is the only kind
    // of declaration a host can check: `bun run d.mjs` resolves against a
    // cwd nothing here owns, and pretending to verify it would be a check
    // that fails on every correct set.
    const server = opts.mcp === "dangling"
      ? { command: "bun", args: ["run", "${CLAUDE_PLUGIN_ROOT}/servers/redskilled.mjs"] }
      : { command: "bun", args: ["run", "d.mjs"] };
    writeFileSync(
      join(tree, "plugins", "dev", ".mcp.json"),
      `${JSON.stringify({ mcpServers: { redskilled: server } }, null, 2)}\n`,
    );
  }

  if (opts.hooks !== undefined) {
    const dir = join(tree, "plugins", "dev", "hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "hooks.json"),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/castle.sh" }] },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    if (opts.hooks === "declared") {
      const script = join(dir, "castle.sh");
      writeFileSync(script, "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(script, 0o755);
    }
  }

  mkdirSync(join(tree, ".red"), { recursive: true });
  writeFileSync(join(tree, ".red", "config.yaml"), hostActivationConfig(CARRIED, ACTIVATED));
  return tree;
}

/** One more skill in the tree, which is the only edit some tests make. */
function addSkill(tree: string, plugin: string, name: string): void {
  const dir = join(tree, "plugins", plugin, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: what ${name} does\n---\n`);
}

/**
 * The payload one skill carries beside its entry point.
 *
 * The dangling variant is a link with nothing behind it, which is what a
 * set composed against a tree that moved leaves: the copy still puts it on
 * the machine, still pointing at nothing, and the skill that cites it fails
 * in the middle of somebody's session rather than at install time.
 */
function addAssets(tree: string, skill: string, kind: boolean | "dangling"): void {
  const root = join(tree, "plugins", "dev", "skills", skill);
  mkdirSync(join(root, "references"), { recursive: true });
  writeFileSync(join(root, "references", "guide.md"), "# the long form of it\n");
  mkdirSync(join(root, "scripts"), { recursive: true });
  const script = join(root, "scripts", "run.sh");
  writeFileSync(script, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(script, 0o755);
  if (kind === "dangling") symlinkSync("./gone.md", join(root, "references", "cited.md"));
}

/** Claude's own store, with a marketplace of the operator's beside ours. */
function knownMarketplaces(current: string): string {
  return `{
  "their-marketplace": {
    "source": { "source": "github", "repo": "someone/theirs" }
  },
  "red-skills": {
    "source": { "source": "directory", "path": "${current}" }
  }
}
`;
}

/** The same fact in Codex's vocabulary, in the file Codex writes it to. */
function codexConfig(current: string): string {
  return `model = "gpt-5"

[marketplaces.red-skills]
source_type = "local"
source = "${current}"
`;
}

/** A Gemini settings file with the operator's hand all over it. */
function geminiSettings(): string {
  return `{
  "theme": "GitHub Dark",
  "mcpServers": {
    "their-own": {
      "command": "node",
      "args": ["/home/someone/tools/server.mjs"]
    }
  },
  "autoAccept": false
}
`;
}

interface Machine {
  home: string;
  config: string;
  tree: string;
  current: string;
}

/** A machine with all seven hosts, a package set, and settings of its own. */
function machine(opts: SetOptions = {}): Machine {
  const home = mkdtempSync(join(tmpdir(), "red-hosts-home-"));
  const config = join(home, ".config");
  const tree = packageSet(opts);
  const current = `${home}/.red/skills/current`;

  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(home, ".claude", "plugins", "known_marketplaces.json"), knownMarketplaces(current));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), codexConfig(current));
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(home, ".gemini", "settings.json"), geminiSettings());

  return { home, config, tree, current };
}

/**
 * Collects the argv a reconciliation issued, and runs the real ones.
 *
 * A generator is addressed by absolute path and actually executes; a host
 * CLI is a name this machine does not have, and is recorded and answered
 * for. `code` overrides both, which is how a refusing host is expressed.
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
      const argv0 = cmd[0] ?? "";
      if (!argv0.startsWith("/")) return 0;
      const proc = Bun.spawn(cmd, {
        env: { ...process.env, HOME: m.home, XDG_CONFIG_HOME: m.config },
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      return await proc.exited;
    },
  };
}

function reconcile(m: Machine, opts: HostReconcileOptions = {}): Promise<HostOutcome[]> {
  return reconcileSkillHosts(UBUNTU, {
    home: m.home,
    config: m.config,
    source: m.tree,
    current: m.current,
    plugins: ACTIVATED,
    present: () => true,
    running: () => false,
    now: () => STAMPED_AT,
    ...opts,
  });
}

function statusOf(out: readonly HostOutcome[], host: string): string | undefined {
  return out.find((o) => o.host === host)?.status;
}

function adapterNamed(name: string): HostAdapter {
  const adapter = HOST_ADAPTERS.find((a) => a.name === name);
  if (!adapter) throw new Error(`no adapter named ${name}`);
  return adapter;
}

function lines(calls: readonly string[][]): string[] {
  return calls.map((c) => c.join(" "));
}

// -------------------------------------------------------------- the seven

describe("the seven adapters Spec #201 settled", () => {
  test("are the ones in the table, by name and in walk order", () => {
    expect(HOST_ADAPTERS.map((a) => a.name)).toEqual([
      "claude",
      "codex",
      "opencode",
      "redcode",
      "gemini",
      "pi",
      "hermes",
    ]);
  });

  test("a first converge reconciles every one of them", async () => {
    // Nothing recorded yet, which is the state of a machine that has never
    // been reconciled. Unknown is not "current": an empty registry has to
    // mean reconcile, or a machine gets its first one never.
    const m = machine();
    const { run } = runner(m);
    const out = await reconcile(m, { run });

    expect(out.map((o) => o.host)).toEqual(HOST_ADAPTERS.map((a) => a.name));
    for (const o of out) expect(o.status, `${o.host}: ${o.reason ?? ""}`).toBe("reconciled");
  });

  test("and records the mechanism each one was actually reached through", async () => {
    // Not a column of the table: for Gemini and Hermes the mode is a fact
    // about the package set, and the day RedSkills ships a generator for
    // them the same adapter records `generator` instead.
    const m = machine();
    await reconcile(m, { run: runner(m).run });
    const hosts = readHostRegistry(m.home).hosts;

    for (const name of MARKETPLACE_HOSTS) expect(hosts[name]?.mode, name).toBe("marketplace");
    for (const name of GENERATOR_HOSTS) expect(hosts[name]?.mode, name).toBe("generator");
    expect(hosts["gemini"]?.mode).toBe("extension");
    expect(hosts["hermes"]?.mode).toBe("skills");
  });

  test("a set that ships a generator for a projected host uses it instead", async () => {
    const m = machine();
    const script = join(m.tree, "scripts", "install-gemini.sh");
    writeFileSync(script, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(script, 0o755);

    const { calls, run } = runner(m);
    const out = await reconcile(m, { run, adapters: [adapterNamed("gemini")] });

    // Blocked rather than reconciled, and deliberately: the script above
    // records no install manifest, so there is nothing to observe and
    // nothing that could be removed later. What is asserted here is the
    // choice — the projection stood down for the tree's own generator.
    expect(out[0]?.mode).toBe("generator");
    expect(lines(calls)).toEqual([`${script} --source-dir ${m.tree} --user`]);
    expect(existsSync(join(m.home, ".gemini", "extensions", "red-skills"))).toBe(false);
  });
});

// -------------------------------------------------------------- only `dev`

describe("only the dev plugin is activated", () => {
  test("out of everything the machine carries locally", () => {
    expect(activatedPlugins(["dev", "memory", "brain"])).toEqual(["dev"]);
    expect(activatedPlugins(["memory", "brain"])).toEqual([]);
  });

  test("the marketplace hosts are never asked for another one", async () => {
    const m = machine();
    const { calls, run } = runner(m);
    await reconcile(m, { run, plugins: ACTIVATED });

    const issued = lines(calls).join("\n");
    expect(issued).toContain("dev@red-skills");
    expect(issued).not.toContain("memory@red-skills");
    expect(issued).not.toContain("brain@red-skills");
  });

  test("the projected hosts carry dev's skills and nothing else", async () => {
    const m = machine({ skills: ["shipped", "also-shipped"] });
    await reconcile(m, { run: runner(m).run });

    const gemini = join(m.home, ".gemini", "extensions", "red-skills", "skills");
    const hermes = join(m.home, ".hermes", "skills", "red-skills");
    for (const root of [gemini, hermes]) {
      expect(existsSync(join(root, "shipped", "SKILL.md")), root).toBe(true);
      expect(existsSync(join(root, "also-shipped", "SKILL.md")), root).toBe(true);
      expect(existsSync(join(root, "memory-only")), root).toBe(false);
    }
  });

  test("and the generators render what the set's activation config enables", async () => {
    // The three hosts red-dev hands no plugin list to. Activation reaches
    // them through the config composeSet writes beside the tree, which is
    // why that file names every payload and enables one.
    const m = machine();
    await reconcile(m, { run: runner(m).run });

    expect(readFileSync(join(m.tree, ".red", "config.yaml"), "utf8")).toContain(
      "  dev:\n    enabled: true\n  memory:\n    enabled: false\n",
    );
    for (const host of ["opencode", "redcode"]) {
      expect(existsSync(join(m.config, host, "skills", "shipped", "SKILL.md")), host).toBe(true);
      expect(existsSync(join(m.config, host, "skills", "memory-only")), host).toBe(false);
    }
    expect(existsSync(join(m.home, ".pi", "skills", "shipped", "SKILL.md"))).toBe(true);
    expect(existsSync(join(m.home, ".pi", "skills", "memory-only"))).toBe(false);
  });
});

// ----------------------------------------------------------- the regression

/**
 * The rule this module replaced, spelled out so the miss can be asserted.
 *
 * A host was current when the checkout path it was last refreshed against
 * was the path resolved now. Nothing else was compared, which is why an
 * edit that keeps the path is invisible to it.
 */
function pathOnlyStampSaysCurrent(stamped: string, resolved: string): boolean {
  return stamped === resolved;
}

describe("a source that changed in place", () => {
  test("is missed by the retired path-only stamp and caught by the record", async () => {
    // A development checkout, or a set rebuilt from the same version: the
    // bytes moved and the path did not. This is the case Spec #201 names
    // as the reason a path stamp cannot be the identity.
    const m = machine();
    await reconcile(m, { run: runner(m).run });
    const before = readHostRegistry(m.home).hosts["opencode"];
    expect(before?.setDigest).toBeTruthy();

    addSkill(m.tree, "dev", "arrived-later");

    // The old rule, on the same two facts it had: the resolved path is the
    // stamped path, so it reports a host that has never seen the new skill
    // as already refreshed.
    expect(pathOnlyStampSaysCurrent(m.tree, m.tree)).toBe(true);

    const { calls, run } = runner(m);
    const out = await reconcile(m, { run });

    expect(calls.length).toBeGreaterThan(0);
    for (const o of out) expect(o.status, `${o.host}: ${o.reason ?? ""}`).toBe("reconciled");
    const after = readHostRegistry(m.home).hosts["opencode"];
    expect(after?.setDigest).not.toBe(before?.setDigest);
    // And the skill is on the machine, with nothing in this repo changed
    // to let it through: the generator renders the tree it ships in.
    expect(existsSync(join(m.config, "opencode", "skills", "arrived-later", "SKILL.md"))).toBe(true);
    expect(existsSync(join(m.home, ".gemini", "extensions", "red-skills", "skills", "arrived-later")))
      .toBe(true);
  });

  test("while a converge that changed nothing issues no commands at all", async () => {
    // The other direction, because a gate that only ever says "reconcile"
    // is as broken as one that never does. Not "issues fewer" and not
    // "issues them and they no-op" — the trace is empty.
    const m = machine();
    await reconcile(m, { run: runner(m).run });

    const { calls, run } = runner(m);
    const out = await reconcile(m, { run });

    expect(calls).toEqual([]);
    for (const o of out) expect(o.status, o.host).toBe("current");
  });

  test("red-skills absent from the machine reconciles nothing", async () => {
    const m = machine();
    const { calls, run } = runner(m);
    const out = await reconcile(m, { source: null, run });

    expect(calls).toEqual([]);
    expect(out).toEqual([]);
  });
});

describe("state that moved under a host", () => {
  test("is reconciled again, and only that host is", async () => {
    // The observation the stamp could never make. Nothing about the set
    // changed; what changed is that the machine no longer has what the
    // record says it has.
    const m = machine();
    await reconcile(m, { run: runner(m).run });
    rmSync(join(m.config, "opencode", "skills", "shipped"), { recursive: true, force: true });

    const { calls, run } = runner(m);
    const out = await reconcile(m, { run });

    expect(statusOf(out, "opencode")).toBe("reconciled");
    expect(lines(calls)).toEqual([`${m.tree}/scripts/install-opencode.sh --global --host opencode`]);
    expect(existsSync(join(m.config, "opencode", "skills", "shipped", "SKILL.md"))).toBe(true);
    for (const other of ["redcode", "gemini", "pi", "hermes", "claude", "codex"]) {
      expect(statusOf(out, other), other).toBe("current");
    }
  });

  test("including one an operator edited by hand", async () => {
    const m = machine();
    await reconcile(m, { run: runner(m).run });
    writeFileSync(
      join(m.home, ".gemini", "extensions", "red-skills", "REDSKILLS.md"),
      "somebody rewrote this\n",
    );

    const out = await reconcile(m, { run: runner(m).run });
    expect(statusOf(out, "gemini")).toBe("reconciled");
    expect(readFileSync(join(m.home, ".gemini", "extensions", "red-skills", "REDSKILLS.md"), "utf8"))
      .toContain("shipped");
  });
});

// ---------------------------------------------------------- the verification

describe("nothing short of a verified reconciliation is recorded", () => {
  test("a host that refuses a required command", async () => {
    const m = machine();
    const { run } = runner(m, (cmd) => (cmd[0] === "claude" ? 1 : 0));
    const out = await reconcile(m, { run });

    expect(statusOf(out, "claude")).toBe("failed");
    expect(readHostRegistry(m.home).hosts["claude"]).toBeUndefined();
    // And the others are untouched by it: one CLI broken for its own
    // reasons is the ordinary state of a machine with several agents.
    for (const other of HOST_ADAPTERS.filter((a) => a.name !== "claude")) {
      expect(statusOf(out, other.name), other.name).toBe("reconciled");
    }
  });

  test("a runner that throws is a failed host, not a failed converge", async () => {
    const m = machine();
    const out = await reconcile(m, {
      run: async (cmd) => {
        if (cmd[0] === "codex") throw new Error("spawn failed");
        return 0;
      },
      adapters: [adapterNamed("codex"), adapterNamed("hermes")],
    });

    expect(statusOf(out, "codex")).toBe("failed");
    expect(statusOf(out, "hermes")).toBe("reconciled");
    expect(readHostRegistry(m.home).hosts["codex"]).toBeUndefined();
  });

  test("a generator that succeeded and recorded no manifest", async () => {
    // The partial case, and the one that matters most: every command
    // exited zero, so an exit-code verdict would call this converged. What
    // is missing is any record of what was written, which means nothing to
    // observe now and nothing to remove later.
    const m = machine();
    const script = join(m.tree, "scripts", "install-opencode.sh");
    writeFileSync(script, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(script, 0o755);

    const out = await reconcile(m, { run: runner(m).run, adapters: [adapterNamed("opencode")] });

    expect(out[0]?.status).toBe("failed");
    expect(out[0]?.reason).toContain("install manifest");
    expect(readHostRegistry(m.home).hosts["opencode"]).toBeUndefined();
  });

  test("a marketplace host whose registration still points somewhere else", async () => {
    // Told to update, and it did — but what it wrote down says GitHub.
    // That is exactly the state a record must not describe as converged,
    // and only reading the host's own file can tell.
    const m = machine();
    writeFileSync(
      join(m.home, ".claude", "plugins", "known_marketplaces.json"),
      `{\n  "red-skills": {\n    "source": { "source": "github", "repo": "reddb-io/red-skills" }\n  }\n}\n`,
    );

    const out = await reconcile(m, { run: runner(m).run, adapters: [adapterNamed("claude")] });

    expect(out[0]?.status).toBe("failed");
    expect(out[0]?.reason).toContain("registered from");
    expect(readHostRegistry(m.home).hosts["claude"]).toBeUndefined();
  });

  test("a set with no generator for a host it needs one for", async () => {
    const m = machine({ without: ["install-opencode.sh", "install-pi.sh"] });
    const { calls, run } = runner(m);
    const out = await reconcile(m, { run });

    for (const host of GENERATOR_HOSTS) {
      expect(statusOf(out, host), host).toBe("blocked");
      expect(readHostRegistry(m.home).hosts[host], host).toBeUndefined();
    }
    expect(lines(calls).some((c) => c.includes("/scripts/"))).toBe(false);
    // Blocked is a reported failure of the whole walk, not a quiet skip:
    // seven-host success cannot be claimed while one of them is stuck.
    for (const host of PROJECTED_HOSTS) expect(statusOf(out, host), host).toBe("reconciled");
  });

  test("a set with no skills leaves the projected hosts blocked", async () => {
    const m = machine({ skills: [], mcp: false });
    const out = await reconcile(m, { run: runner(m).run });

    for (const host of PROJECTED_HOSTS) {
      expect(statusOf(out, host), host).toBe("blocked");
      expect(readHostRegistry(m.home).hosts[host], host).toBeUndefined();
    }
  });

  test("a host that is not on the machine, until the converge after it appears", async () => {
    // Absence must not be recorded. A skipped host written down as current
    // is a host installed tomorrow and left on yesterday's set forever.
    const m = machine();
    const first = await reconcile(m, { run: runner(m).run, present: (cmd) => cmd !== "hermes" });

    expect(statusOf(first, "hermes")).toBe("absent");
    expect(first.find((o) => o.host === "hermes")?.reason).toContain("not installed");
    expect(readHostRegistry(m.home).hosts["hermes"]).toBeUndefined();

    const second = await reconcile(m, { run: runner(m).run });
    expect(statusOf(second, "hermes")).toBe("reconciled");
    expect(existsSync(join(m.home, ".hermes", "skills", "red-skills", "shipped"))).toBe(true);
  });
});

// ------------------------------------------------------ the operator's files

describe("configuration the operator owns", () => {
  test("keeps every byte outside the field red-dev owns", async () => {
    const m = machine();
    await reconcile(m, { run: runner(m).run });

    const after = readFileSync(join(m.home, ".gemini", "settings.json"), "utf8");
    // Their formatting, their key order, their server, their trailing
    // newline. A parse-and-restringify merge loses all four.
    expect(after).toContain(`  "theme": "GitHub Dark",\n`);
    expect(after).toContain(`      "args": ["/home/someone/tools/server.mjs"]\n`);
    expect(after).toContain(`  "autoAccept": false\n`);
    expect(after.endsWith("}\n")).toBe(true);
    // And the one thing that is ours, named so it cannot collide.
    expect(JSON.parse(after)["mcpServers"]["red-skills-redskilled"]).toEqual({
      command: "bun",
      args: ["run", "d.mjs"],
    });
  });

  test("and is handed back exactly as it was when RedSkills is removed", async () => {
    const m = machine();
    await reconcile(m, { run: runner(m).run });
    await removeSkillHosts(UBUNTU, {
      home: m.home,
      config: m.config,
      source: m.tree,
      plugins: ACTIVATED,
      present: () => true,
      run: runner(m).run,
    });

    expect(readFileSync(join(m.home, ".gemini", "settings.json"), "utf8")).toBe(geminiSettings());
  });

  test("a set that declares no MCP never opens the settings file at all", async () => {
    const m = machine({ mcp: false });
    rmSync(join(m.tree, "plugins", "dev", ".mcp.json"), { force: true });
    await reconcile(m, { run: runner(m).run });

    expect(readFileSync(join(m.home, ".gemini", "settings.json"), "utf8")).toBe(geminiSettings());
    expect(existsSync(join(m.home, ".gemini", "extensions", "red-skills"))).toBe(true);
  });

  test("Claude's own store is read and never rewritten", async () => {
    const m = machine();
    await reconcile(m, { run: runner(m).run });
    expect(readFileSync(join(m.home, ".claude", "plugins", "known_marketplaces.json"), "utf8"))
      .toBe(knownMarketplaces(m.current));
  });
});

// ------------------------------------------------------------- the Gemini

/** What an adapter is a function of, for the plans and checks called directly. */
function hostContext(m: Machine, os: AdapterContext["os"] = "linux"): AdapterContext {
  return {
    os,
    plugins: ACTIVATED,
    source: m.tree,
    setDigest: "0".repeat(64),
    setVersion: "v9.9.9",
    current: m.current,
    home: m.home,
    config: m.config,
  };
}

const GEMINI_EXTENSION = ["extensions", "red-skills"] as const;

function geminiDir(m: Machine): string {
  return join(m.home, ".gemini", ...GEMINI_EXTENSION);
}

function geminiSettingsFile(m: Machine): string {
  return join(m.home, ".gemini", "settings.json");
}

/** Every file under a tree, with the bytes and the mtime that prove no rewrite. */
function snapshot(root: string, base = root): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) {
      Object.assign(out, snapshot(path, base));
      continue;
    }
    out[path.slice(base.length)] = `${statSync(path).mtimeMs}\0${readFileSync(path, "utf8")}`;
  }
  return out;
}

async function geminiCheck(m: Machine): Promise<{ ok: boolean; reason?: string }> {
  const adapter = adapterNamed("gemini");
  const ctx = hostContext(m);
  const checked = await adapter.check?.(ctx, adapter.plan(ctx));
  if (!checked) throw new Error("the Gemini adapter answers no check");
  return checked.ok ? { ok: true } : { ok: false, reason: checked.reason };
}

function geminiOnly(m: Machine, opts: HostReconcileOptions = {}): Promise<HostOutcome[]> {
  return reconcile(m, { run: runner(m).run, adapters: [adapterNamed("gemini")], ...opts });
}

describe("the Gemini projection of the local dev set", () => {
  test("a set whose declared hook script is not in it never reaches the disk", async () => {
    // The fixture the acceptance criteria ask for: a projection that names
    // a path nothing carries. Refused at plan time, so `~/.gemini` is
    // exactly as it was and there is no half-installed extension to find.
    const m = machine({ hooks: "dangling" });
    const { calls, run } = runner(m);
    const out = await geminiOnly(m, { run });

    expect(out[0]?.status).toBe("blocked");
    expect(out[0]?.reason).toContain("hooks/castle.sh");
    expect(calls).toEqual([]);
    expect(existsSync(geminiDir(m))).toBe(false);
    expect(readFileSync(geminiSettingsFile(m), "utf8")).toBe(geminiSettings());
    expect(readHostRegistry(m.home).hosts["gemini"]).toBeUndefined();
  });

  test("and neither does one whose declared MCP server points at nothing", async () => {
    const m = machine({ mcp: "dangling" });
    const out = await geminiOnly(m);

    expect(out[0]?.status).toBe("blocked");
    expect(out[0]?.reason).toContain("servers/redskilled.mjs");
    expect(existsSync(geminiDir(m))).toBe(false);
    expect(readFileSync(geminiSettingsFile(m), "utf8")).toBe(geminiSettings());
    expect(readHostRegistry(m.home).hosts["gemini"]).toBeUndefined();
  });

  test("a valid set installs into a clean Gemini home with nothing spawned", async () => {
    // No `~/.gemini` at all, and no command issued: the projection is
    // files red-dev writes itself, so it needs no CLI and no network.
    const m = machine({ hooks: "declared" });
    rmSync(join(m.home, ".gemini"), { recursive: true, force: true });

    const { calls, run } = runner(m);
    const out = await geminiOnly(m, { run });

    expect(out[0]?.status).toBe("reconciled");
    expect(out[0]?.mode).toBe("extension");
    expect(calls).toEqual([]);

    expect(JSON.parse(readFileSync(join(geminiDir(m), "gemini-extension.json"), "utf8"))).toMatchObject({
      name: "red-skills",
      contextFileName: "REDSKILLS.md",
    });
    expect(readFileSync(join(geminiDir(m), "REDSKILLS.md"), "utf8")).toContain("shipped");
    expect(existsSync(join(geminiDir(m), "skills", "shipped", "SKILL.md"))).toBe(true);
    expect(JSON.parse(readFileSync(geminiSettingsFile(m), "utf8"))["mcpServers"]).toEqual({
      "red-skills-redskilled": { command: "bun", args: ["run", "d.mjs"] },
    });
    expect(readHostRegistry(m.home).hosts["gemini"]?.mode).toBe("extension");
  });

  test("verification reads Gemini's own state back, not the exit code", async () => {
    const m = machine({ hooks: "declared" });

    // Nothing projected yet: there is no extension for Gemini to load.
    expect(await geminiCheck(m)).toMatchObject({ ok: false });

    await geminiOnly(m);
    expect(await geminiCheck(m)).toEqual({ ok: true });

    // Every declared surface, one at a time. The manifest Gemini reads
    // first, the skills path it resolves out of it, and the server it
    // starts from a file red-dev owns one field of.
    const manifest = join(geminiDir(m), "gemini-extension.json");
    const kept = readFileSync(manifest, "utf8");
    writeFileSync(manifest, "{ not json\n");
    expect((await geminiCheck(m)).reason).toContain("Gemini can load");
    writeFileSync(manifest, kept);

    rmSync(join(geminiDir(m), "skills", "shipped"), { recursive: true, force: true });
    expect((await geminiCheck(m)).reason).toContain("skills/shipped");
    mkdirSync(join(geminiDir(m), "skills", "shipped"), { recursive: true });
    writeFileSync(join(geminiDir(m), "skills", "shipped", "SKILL.md"), "---\nname: shipped\n---\n");

    writeFileSync(geminiSettingsFile(m), geminiSettings());
    expect((await geminiCheck(m)).reason).toContain("mcpServers.red-skills-redskilled");
  });

  test("and a state that moved under it is reconciled again rather than skipped", async () => {
    const m = machine({ hooks: "declared" });
    await geminiOnly(m);

    // A second tool rewrote the settings file, taking our server with it.
    writeFileSync(geminiSettingsFile(m), geminiSettings());
    const out = await geminiOnly(m);

    expect(out[0]?.status).toBe("reconciled");
    expect(JSON.parse(readFileSync(geminiSettingsFile(m), "utf8"))["mcpServers"]["red-skills-redskilled"])
      .toEqual({ command: "bun", args: ["run", "d.mjs"] });
  });

  test("re-running the install produces no drift at all", async () => {
    const m = machine({ hooks: "declared" });
    expect((await geminiOnly(m))[0]?.status).toBe("reconciled");
    const before = snapshot(join(m.home, ".gemini"));

    const { calls, run } = runner(m);
    const out = await geminiOnly(m, { run });

    expect(out[0]?.status).toBe("current");
    expect(calls).toEqual([]);
    // Byte for byte and mtime for mtime: a converge that rewrote an
    // unchanged file would be claiming work it did not do.
    expect(snapshot(join(m.home, ".gemini"))).toEqual(before);
  });

  test("uninstall removes what it owns and leaves the rest of ~/.gemini", async () => {
    const m = machine({ hooks: "declared" });
    await geminiOnly(m);

    const theirs = join(m.home, ".gemini", "extensions", "their-extension");
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, "gemini-extension.json"), "{ \"name\": \"theirs\" }\n");

    const out = await removeSkillHosts(UBUNTU, {
      home: m.home,
      config: m.config,
      source: m.tree,
      plugins: ACTIVATED,
      present: () => true,
      run: runner(m).run,
      adapters: [adapterNamed("gemini")],
    });

    expect(out[0]?.removed).toBe(true);
    expect(existsSync(geminiDir(m))).toBe(false);
    expect(readFileSync(join(theirs, "gemini-extension.json"), "utf8")).toContain("theirs");
    expect(readFileSync(geminiSettingsFile(m), "utf8")).toBe(geminiSettings());
    expect(readHostRegistry(m.home).hosts["gemini"]).toBeUndefined();
  });

  test("what Gemini cannot be given is said in the outcome and in doctor", async () => {
    // Hooks are the rich capability the set carries and this host has no
    // runner for. Saying so is the point: a converge that reported seven
    // identical hosts would be describing the table, not the machine.
    const m = machine({ hooks: "declared" });
    const first = await geminiOnly(m);

    expect(first[0]?.status).toBe("reconciled");
    expect(first[0]?.missing?.join(" ")).toContain("hooks");

    // And it survives into the record, so the converge that skips the host
    // still says what the host does not have.
    const second = await geminiOnly(m);
    expect(second[0]?.status).toBe("current");
    expect(second[0]?.missing?.join(" ")).toContain("hooks");

    const row = redSkillsHostRows(redSkillsHostReport(m.home)).find((r) => r.detail.startsWith("gemini"));
    expect(row?.detail).toContain("hooks");
    expect(redSkillsHostReport(m.home).hosts[0]?.capabilities).toContainEqual(
      expect.objectContaining({ name: "hooks", state: "unsupported" }),
    );
  });

  test("a set that declares no MCP is reported as carrying none, not as broken", async () => {
    const m = machine({ mcp: false });
    const out = await geminiOnly(m);

    expect(out[0]?.status).toBe("reconciled");
    expect(out[0]?.missing?.join(" ")).toContain("mcp");
    expect(readFileSync(geminiSettingsFile(m), "utf8")).toBe(geminiSettings());
  });

  test("a Gemini session that was up is told to restart, never killed", async () => {
    const m = machine({ hooks: "declared" });
    const { calls, run } = runner(m);
    const out = await geminiOnly(m, { run, running: () => true });

    expect(out[0]?.reload).toBe("restart-needed");
    expect(calls).toEqual([]);
    const row = redSkillsHostRows(redSkillsHostReport(m.home)).find((r) => r.detail.startsWith("gemini"));
    expect(row?.status).toBe("warn");
    expect(row?.detail).toContain("restart needed");
  });
});

// ------------------------------------------------------------- the Hermes

const HERMES_SKILLS = ["skills", "red-skills"] as const;

function hermesDir(m: Machine): string {
  return join(m.home, ".hermes", ...HERMES_SKILLS);
}

async function hermesCheck(m: Machine): Promise<{ ok: boolean; reason?: string }> {
  const adapter = adapterNamed("hermes");
  const ctx = hostContext(m);
  const checked = await adapter.check?.(ctx, adapter.plan(ctx));
  if (!checked) throw new Error("the Hermes adapter answers no check");
  return checked.ok ? { ok: true } : { ok: false, reason: checked.reason };
}

function hermesOnly(m: Machine, opts: HostReconcileOptions = {}): Promise<HostOutcome[]> {
  return reconcile(m, { run: runner(m).run, adapters: [adapterNamed("hermes")], ...opts });
}

describe("the user-global surface Hermes supports", () => {
  test("is a skills tree of its own, and no command and no config file", () => {
    // The contract, read off the plan rather than off the disk: everything
    // this host is given lands under one directory red-dev made, nothing is
    // spawned to put it there, and no field of anybody's file is ours.
    const m = machine({ hooks: "declared", assets: true, agents: true });
    const adapter = adapterNamed("hermes");
    const desired = adapter.plan(hostContext(m));

    expect(adapter.cmd).toBe("hermes");
    expect(desired.mode).toBe("skills");
    expect(desired.steps).toEqual([]);
    expect(desired.merges).toEqual([]);
    expect(desired.manifests).toEqual([]);

    const owned = [
      ...desired.writes.map((w) => w.path),
      ...desired.copies.map((c) => c.to),
      ...desired.expect.flatMap((e) => (e.kind === "path" ? [e.path] : [])),
    ];
    expect(owned.length).toBeGreaterThan(0);
    for (const path of owned) expect(path, path).toStartWith(hermesDir(m));

    // And the limits, named rather than left to be inferred from what is
    // missing: three capabilities the set carries that this host has no
    // mechanism for, in one list beside the one it does.
    expect(desired.capabilities.map((c) => `${c.name}:${c.state}`)).toEqual([
      "skills:projected",
      "mcp:unsupported",
      "hooks:unsupported",
      "agents:unsupported",
    ]);
  });

  test("a set that ships a generator for it stands the projection down", () => {
    const m = machine();
    const script = join(m.tree, "scripts", "install-hermes.sh");
    writeFileSync(script, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(script, 0o755);

    const desired = adapterNamed("hermes").plan(hostContext(m));
    expect(desired.mode).toBe("generator");
    expect(lines(desired.steps.map((s) => s.argv))).toEqual([`${script} --source-dir ${m.tree} --user`]);
    expect(desired.copies).toEqual([]);
  });
});

describe("the Hermes projection of the local dev set", () => {
  test("a valid set installs complete skills and their payload, with nothing spawned", async () => {
    // A clean machine: no `~/.hermes` at all, and no command issued. The
    // projection is a tree red-dev copies out of the set it already has,
    // so it needs no CLI, no marketplace and no network.
    const m = machine({ hooks: "declared", assets: true, agents: true });
    expect(existsSync(join(m.home, ".hermes"))).toBe(false);

    const { calls, run } = runner(m);
    const out = await hermesOnly(m, { run });

    expect(out[0]?.status).toBe("reconciled");
    expect(out[0]?.mode).toBe("skills");
    expect(calls).toEqual([]);

    const shipped = join(hermesDir(m), "shipped");
    expect(readFileSync(join(shipped, "SKILL.md"), "utf8")).toContain("name: shipped");
    // The whole skill, not its entry point: a reference the model is sent
    // to read and a script it is told to run are the skill as much as the
    // page naming them.
    expect(readFileSync(join(shipped, "references", "guide.md"), "utf8")).toContain("the long form");
    expect(statSync(join(shipped, "scripts", "run.sh")).mode & 0o111).not.toBe(0);
    // And nothing the set carries but nobody activated.
    expect(existsSync(join(hermesDir(m), "memory-only"))).toBe(false);

    expect(readFileSync(join(hermesDir(m), "REDSKILLS.md"), "utf8")).toContain("shipped");
    expect(readHostRegistry(m.home).hosts["hermes"]?.mode).toBe("skills");
  });

  test("a skill citing a file the set does not carry never reaches the disk", async () => {
    const m = machine({ assets: "dangling" });
    const { calls, run } = runner(m);
    const out = await hermesOnly(m, { run });

    expect(out[0]?.status).toBe("blocked");
    expect(out[0]?.reason).toContain("references/cited.md");
    expect(calls).toEqual([]);
    expect(existsSync(join(m.home, ".hermes"))).toBe(false);
    expect(readHostRegistry(m.home).hosts["hermes"]).toBeUndefined();
  });

  test("verification reads the projected tree back, not the exit code", async () => {
    const m = machine({ assets: true });

    // Nothing projected yet: there is no skill for Hermes to read.
    expect(await hermesCheck(m)).toMatchObject({ ok: false });

    await hermesOnly(m);
    expect(await hermesCheck(m)).toEqual({ ok: true });

    // Every part of the surface, one at a time: the payload beside the
    // entry point, the entry point itself, and the page that says what
    // this host has and has not.
    const asset = join(hermesDir(m), "shipped", "references", "guide.md");
    rmSync(asset);
    expect((await hermesCheck(m)).reason).toContain("references/guide.md");
    writeFileSync(asset, "# the long form of it\n");

    rmSync(join(hermesDir(m), "shipped"), { recursive: true, force: true });
    expect((await hermesCheck(m)).reason).toContain("shipped/SKILL.md");

    rmSync(join(hermesDir(m), "REDSKILLS.md"));
    expect((await hermesCheck(m)).reason).toContain("REDSKILLS.md");
  });

  test("a projection that lost part of a skill is reconciled again, not skipped", async () => {
    const m = machine({ assets: true });
    await hermesOnly(m);

    // The state the record described is not the state on disk any more.
    rmSync(join(hermesDir(m), "shipped", "scripts"), { recursive: true, force: true });
    const out = await hermesOnly(m);

    expect(out[0]?.status).toBe("reconciled");
    expect(existsSync(join(hermesDir(m), "shipped", "scripts", "run.sh"))).toBe(true);
  });

  test("and one that could not be written at all is recorded as nothing", async () => {
    // An operator's stray file where the skills path has to be. The plan
    // fails partway, which is the state a success record must never
    // describe: the next converge has to ask this host again.
    const m = machine({ assets: true });
    mkdirSync(join(m.home, ".hermes"), { recursive: true });
    writeFileSync(join(m.home, ".hermes", "skills"), "not a directory\n");

    const out = await hermesOnly(m);

    expect(out[0]?.status).toBe("failed");
    expect(readHostRegistry(m.home).hosts["hermes"]).toBeUndefined();
  });

  test("re-running the install produces no drift at all", async () => {
    const m = machine({ assets: true, hooks: "declared" });
    expect((await hermesOnly(m))[0]?.status).toBe("reconciled");
    const before = snapshot(join(m.home, ".hermes"));

    const { calls, run } = runner(m);
    const out = await hermesOnly(m, { run });

    expect(out[0]?.status).toBe("current");
    expect(calls).toEqual([]);
    // Byte for byte and mtime for mtime: a converge that recopied an
    // unchanged tree would be claiming work it did not do.
    expect(snapshot(join(m.home, ".hermes"))).toEqual(before);
  });

  test("uninstall removes what it owns and leaves the rest of ~/.hermes", async () => {
    const m = machine({ assets: true });
    await hermesOnly(m);

    const theirs = join(m.home, ".hermes", "skills", "hand-written");
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, "SKILL.md"), "---\nname: hand-written\n---\n");
    const settings = join(m.home, ".hermes", "settings.json");
    writeFileSync(settings, `{ "theme": "theirs" }\n`);

    const out = await removeSkillHosts(UBUNTU, {
      home: m.home,
      config: m.config,
      source: m.tree,
      plugins: ACTIVATED,
      present: () => true,
      run: runner(m).run,
      adapters: [adapterNamed("hermes")],
    });

    expect(out[0]?.removed).toBe(true);
    expect(existsSync(hermesDir(m))).toBe(false);
    expect(readFileSync(join(theirs, "SKILL.md"), "utf8")).toContain("hand-written");
    expect(readFileSync(settings, "utf8")).toBe(`{ "theme": "theirs" }\n`);
    expect(readHostRegistry(m.home).hosts["hermes"]).toBeUndefined();
  });

  test("what Hermes cannot be given is said, and its skills are installed anyway", async () => {
    // The whole point of the capability vocabulary: a set carrying hooks,
    // servers and agents is not a broken set for this host, and a host
    // that takes none of the three is not a host with worse skills.
    const m = machine({ hooks: "declared", agents: true, assets: true });
    const first = await hermesOnly(m);

    expect(first[0]?.status).toBe("reconciled");
    const said = first[0]?.missing?.join("\n") ?? "";
    for (const name of ["mcp", "hooks", "agents"]) expect(said, name).toContain(`no ${name}`);
    expect(existsSync(join(hermesDir(m), "shipped", "SKILL.md"))).toBe(true);

    // It survives into the record, so the converge that skips the host
    // still says what the host does not have.
    const second = await hermesOnly(m);
    expect(second[0]?.status).toBe("current");
    expect(second[0]?.missing?.join("\n")).toContain("no agents");

    const report = redSkillsHostReport(m.home);
    expect(report.hosts[0]?.capabilities).toContainEqual(
      expect.objectContaining({ name: "agents", state: "unsupported" }),
    );
    const row = redSkillsHostRows(report).find((r) => r.detail.startsWith("hermes"));
    // Converged, and poorer than its neighbour: both on the same line, and
    // neither of them a warning about the host being broken.
    expect(row?.status).toBe("ok");
    expect(row?.detail).toContain("no hooks");
    // And the same sentences on the page Hermes itself reads, so a model
    // waiting for a hook to fire here is told nothing ever will.
    expect(readFileSync(join(hermesDir(m), "REDSKILLS.md"), "utf8")).toContain("no hooks");
  });

  test("a set carrying none of them is reported as carrying none, not as refused", async () => {
    const m = machine({ mcp: false });
    const out = await hermesOnly(m);

    expect(out[0]?.status).toBe("reconciled");
    const said = out[0]?.missing?.join("\n") ?? "";
    expect(said).toContain("the package set declares no MCP server");
    expect(said).toContain("the package set declares no hook");
    expect(said).toContain("the package set carries no agent");
    expect(said).not.toContain("Hermes");
  });
});

// -------------------------------------------------------------- the removal

describe("removal is the ownership manifest, replayed", () => {
  test("takes back what was recorded and nothing beside it", async () => {
    const m = machine({ skills: ["shipped", "also-shipped"] });
    await reconcile(m, { run: runner(m).run });

    // Things nobody here wrote, in the directories red-dev writes into.
    // Nothing recorded them, so nothing may remove them.
    const theirs = [
      join(m.config, "opencode", "skills", "hand-written"),
      join(m.home, ".gemini", "extensions", "their-extension"),
      join(m.home, ".hermes", "skills", "theirs"),
      join(m.home, ".pi", "skills", "hand-written"),
    ];
    for (const dir of theirs) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "mine\n");
    }

    const { calls, run } = runner(m);
    const out = await removeSkillHosts(UBUNTU, {
      home: m.home,
      config: m.config,
      source: m.tree,
      plugins: ACTIVATED,
      present: () => true,
      run,
    });

    expect(out.every((o) => o.removed)).toBe(true);
    // The generators were routed back through their own scripts.
    expect(lines(calls)).toContain(`${m.tree}/scripts/install-opencode.sh --uninstall --global --host opencode`);
    expect(lines(calls)).toContain(`${m.tree}/scripts/install-pi.sh --uninstall --user`);
    // What was recorded is gone.
    expect(existsSync(join(m.config, "opencode", "skills", "shipped"))).toBe(false);
    expect(existsSync(join(m.config, "redcode", "redskills-install-manifest.txt"))).toBe(false);
    expect(existsSync(join(m.home, ".gemini", "extensions", "red-skills"))).toBe(false);
    expect(existsSync(join(m.home, ".hermes", "skills", "red-skills"))).toBe(false);
    expect(existsSync(join(m.home, ".pi", "skills", "shipped"))).toBe(false);
    // And what was not is untouched.
    for (const dir of theirs) expect(existsSync(join(dir, "SKILL.md")), dir).toBe(true);
    // Including the operator's other marketplace, in the file red-dev
    // takes only its own entry out of.
    expect(readFileSync(join(m.home, ".claude", "plugins", "known_marketplaces.json"), "utf8")).toBe(
      `{\n  "their-marketplace": {\n    "source": { "source": "github", "repo": "someone/theirs" }\n  }\n}\n`,
    );
    // The record goes with the state it described.
    expect(readHostRegistry(m.home).hosts).toEqual({});
  });

  test("works with the package set already pruned off the machine", async () => {
    // The record is the manifest, so removal does not need the tree the
    // way the old unwire did. Only the host's own commands do, and those
    // are skipped rather than guessed at.
    const m = machine();
    await reconcile(m, { run: runner(m).run });

    const { calls, run } = runner(m);
    const out = await removeSkillHosts(UBUNTU, {
      home: m.home,
      config: m.config,
      source: null,
      plugins: ACTIVATED,
      present: () => true,
      run,
    });

    expect(calls).toEqual([]);
    expect(out.every((o) => o.removed)).toBe(true);
    expect(existsSync(join(m.config, "opencode", "skills", "shipped"))).toBe(false);
    expect(existsSync(join(m.home, ".gemini", "extensions", "red-skills"))).toBe(false);
    expect(readHostRegistry(m.home).hosts).toEqual({});
  });

  test("a host nothing was recorded for is left alone", async () => {
    const m = machine();
    const { calls, run } = runner(m);
    const out = await removeSkillHosts(UBUNTU, {
      home: m.home,
      config: m.config,
      source: m.tree,
      plugins: ACTIVATED,
      present: () => true,
      run,
    });

    expect(calls).toEqual([]);
    expect(out.every((o) => !o.removed)).toBe(true);
    for (const o of out) expect(o.reason, o.host).toContain("nothing was recorded");
  });
});

// --------------------------------------------------------------- the report

describe("what doctor is told", () => {
  test("every host's observed digest, mode and reload state, as data", async () => {
    const m = machine();
    await reconcile(m, { run: runner(m).run });

    const report = redSkillsHostReport(m.home);
    expect(report.unrecorded).toEqual([]);
    expect(report.hosts.map((h) => h.host)).toEqual(HOST_ADAPTERS.map((a) => a.name));
    for (const row of report.hosts) {
      expect(row.setDigest, row.host).toMatch(/^[0-9a-f]{64}$/);
      expect(row.stateDigest, row.host).toMatch(/^[0-9a-f]{64}$/);
      expect(row.plugins, row.host).toEqual(ACTIVATED);
      expect(row.reload, row.host).toBe("current");
      expect(row.verifiedAt, row.host).toBe(STAMPED_AT);
    }
    // Two hosts with different state have different state digests: the
    // number describes the machine rather than the set.
    const digests = new Set(report.hosts.map((h) => h.stateDigest));
    expect(digests.size).toBeGreaterThan(1);
  });

  test("names the hosts it has never observed rather than omitting them", async () => {
    const m = machine();
    await reconcile(m, { run: runner(m).run, adapters: [adapterNamed("hermes")] });

    const report = redSkillsHostReport(m.home);
    expect(report.hosts.map((h) => h.host)).toEqual(["hermes"]);
    expect(report.unrecorded).toEqual(["claude", "codex", "opencode", "redcode", "gemini", "pi"]);
    expect(redSkillsHostRows(report).some((r) => r.status === "n/a")).toBe(true);
  });

  test("a session that was up is reported as needing a restart, never killed", async () => {
    // Plugin freshness does not justify interrupting somebody's work, so
    // the only thing that happens to a running host is that it is said so.
    const m = machine();
    const { calls, run } = runner(m);
    const out = await reconcile(m, { run, running: () => true, adapters: [adapterNamed("hermes")] });

    expect(out[0]?.reload).toBe("restart-needed");
    expect(readHostRegistry(m.home).hosts["hermes"]?.reload).toBe("restart-needed");
    expect(lines(calls).some((c) => c.includes("kill") || c.includes("pkill"))).toBe(false);

    const rows = redSkillsHostRows(redSkillsHostReport(m.home));
    expect(rows.find((r) => r.detail.startsWith("hermes"))?.status).toBe("warn");
    expect(rows.find((r) => r.detail.startsWith("hermes"))?.detail).toContain("restart needed");
  });

  test("with nothing recorded at all it says so and reads no host", () => {
    const home = mkdtempSync(join(tmpdir(), "red-hosts-empty-"));
    const report = redSkillsHostReport(home);
    expect(report.hosts).toEqual([]);
    expect(report.unrecorded).toEqual(HOST_ADAPTERS.map((a) => a.name));
  });

  test("the registry the path-only stamp left behind reads as no record", async () => {
    // The old file was a bare host-to-path map with no schema. Every host
    // is reconciled once on the converge after the upgrade, which is
    // correct: there is nothing in it worth believing.
    const m = machine();
    const path = join(m.home, ".local", "share", "red-dev", "red-skills-hosts.json");
    mkdirSync(join(m.home, ".local", "share", "red-dev"), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ claude: m.tree, opencode: m.tree }, null, 2)}\n`);

    expect(readHostRegistry(m.home).hosts).toEqual({});
    const out = await reconcile(m, { run: runner(m).run });
    for (const o of out) expect(o.status, o.host).toBe("reconciled");
  });
});

describe("the converge reaches the reconciliation", () => {
  test("on the already-wired path too", () => {
    // Asserted against the source because it is not observable any other
    // way without an agent CLI in the loop, and because the failure it
    // guards is precise: convergeRedSkills used to return at "already
    // wired", which is every ordinary converge. A reconciliation written
    // and never reached from there would leave the set moving under a
    // machine whose hosts are never told.
    const src = readFileSync(`${import.meta.dir}/agents.ts`, "utf8");
    const converge = src.slice(src.indexOf("export async function convergeRedSkills"));
    const wired = converge.indexOf("already wired into");
    expect(wired).toBeGreaterThan(-1);
    expect(converge.slice(wired)).toContain("reconcileSkillHosts");
    // And what a host did not get is on the converge itself rather than
    // only in a doctor run nobody is obliged to make.
    expect(converge.slice(wired)).toContain("h.missing");
  });
});

describe("what a generator's install manifest records", () => {
  /** The real shape: two comment lines, then absolute paths. */
  function manifestFile(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "red-manifest-"));
    const path = join(dir, "redskills-install-manifest.txt");
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  }

  test("the header comments are not files red-dev owns", async () => {
    // The bug this replaces: every non-empty line was a path, so
    // `# RedSkills OpenCode install manifest` was recorded as one and
    // the verification then reported it "was not written" — opencode
    // and redcode could never verify, on any machine, ever.
    const real = join(mkdtempSync(join(tmpdir(), "red-owned-")), "plugin.ts");
    writeFileSync(real, "//\n");
    const path = manifestFile([
      "# RedSkills OpenCode install manifest",
      "# One absolute path per line. Used by scripts/install-opencode.sh --uninstall.",
      real,
      "",
      "  ",
      "not-an-absolute-path.txt",
    ]);

    const { hostManifestPaths } = await import("./red-skills-hosts.ts");
    expect(hostManifestPaths(path)).toEqual([real]);
  });

  test("an absent manifest is no paths rather than a throw", async () => {
    const { hostManifestPaths } = await import("./red-skills-hosts.ts");
    expect(hostManifestPaths(join(tmpdir(), "red-nope", "missing.txt"))).toEqual([]);
  });
});

describe("the skills a package set can project", () => {
  function pluginWith(declared: string[] | null, dirs: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "red-skills-plugin-"));
    for (const dir of dirs) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(
        join(root, dir, "SKILL.md"),
        `---\nname: ${basename(dir)}\ndescription: d\n---\n`,
      );
    }
    if (declared !== null) {
      mkdirSync(join(root, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(root, ".claude-plugin", "plugin.json"),
        `${JSON.stringify({ name: "dev", skills: declared }, null, 2)}\n`,
      );
    }
    return root;
  }

  test("comes from the plugin's own declaration, drafts and all excluded", async () => {
    // red-skills organises skills into buckets and ships an
    // `in-progress/` one it declares nowhere. A scan one level under
    // `skills/` found nothing at all — 48 skills in the dev plugin, none
    // projected, and Gemini and Hermes blocked with "the package set
    // carries no skills to project" on every machine.
    const root = pluginWith(
      ["./skills/engineering/afk", "./skills/knowledge/wiki"],
      ["skills/engineering/afk", "skills/knowledge/wiki", "skills/in-progress/draft"],
    );

    const { setSkillsIn } = await import("./red-skills-hosts.ts");
    expect(setSkillsIn(root).map((s) => s.name).sort()).toEqual(["afk", "wiki"]);
  });

  test("falls back to looking, at both layouts, for a plugin that declares nothing", async () => {
    const root = pluginWith(null, [
      "skills/older-layout",
      "skills/engineering/afk",
      "skills/in-progress/draft",
    ]);
    const { setSkillsIn } = await import("./red-skills-hosts.ts");
    // The flat one and the bucketed one; never the drafts bucket.
    expect(setSkillsIn(root).map((s) => s.name).sort()).toEqual(["afk", "older-layout"]);
  });

  test("a declaration naming something absent does not invent it", async () => {
    const root = pluginWith(["./skills/engineering/gone"], ["skills/engineering/afk"]);
    const { setSkillsIn } = await import("./red-skills-hosts.ts");
    // Nothing declared exists, so the fallback answers instead of an
    // empty projection that would read as "this set has no skills".
    expect(setSkillsIn(root).map((s) => s.name)).toEqual(["afk"]);
  });
});

describe("a generator that cannot run on this platform", () => {
  test("blocks rather than fails, so it stops holding every other host", () => {
    // `.sh` has no shebang handling on Windows: the spawn failed with
    // EFTYPE, the reconciliation was reported failed, and the adoption —
    // which removes nothing until every surface verifies — was held by
    // one host that cannot work there at all.
    const m = machine();
    const opencode = HOST_ADAPTERS.find((a) => a.name === "opencode")!;

    const onWindows = opencode.plan(hostContext(m, "windows"));
    expect(onWindows.blocked).toContain("shell script");
    expect(onWindows.steps).toEqual([]);

    const onLinux = opencode.plan(hostContext(m, "linux"));
    expect(onLinux.blocked).toBeUndefined();
    expect(onLinux.steps.length).toBeGreaterThan(0);
  });
});

describe("a host that cannot converge on this platform", () => {
  test("is blocked permanently, and a permanent block is not a failed reconciliation", () => {
    // The verdict is what `red-dev update` answers with and what the
    // Spec #185 adoption gates on. Counting "no implementation on this
    // OS" as failure made every Windows update partial forever and held
    // the adoption on every machine there.
    const permanent: HostOutcome[] = [
      { host: "claude", status: "current", mode: "marketplace" },
      { host: "opencode", status: "blocked", mode: "generator", reason: "shell script", permanent: true },
    ];
    expect(reconciliationFailed(permanent)).toBe(false);

    // A block a later run could clear still is a failure: the set may
    // simply not have finished installing yet.
    const temporary: HostOutcome[] = [
      { host: "claude", status: "current", mode: "marketplace" },
      { host: "opencode", status: "blocked", mode: "generator", reason: "no install-opencode.sh" },
    ];
    expect(reconciliationFailed(temporary)).toBe(true);

    const failed: HostOutcome[] = [{ host: "codex", status: "failed", mode: "marketplace" }];
    expect(reconciliationFailed(failed)).toBe(true);
  });

  test("opencode declares its Windows block permanent, and nothing else does", () => {
    const m = machine();
    const onWindows = HOST_ADAPTERS.find((a) => a.name === "opencode")!.plan(
      hostContext(m, "windows"),
    );
    expect(onWindows.permanent).toBe(true);
    expect(HOST_ADAPTERS.find((a) => a.name === "opencode")!.plan(hostContext(m, "linux")).permanent)
      .toBeUndefined();
  });
});
