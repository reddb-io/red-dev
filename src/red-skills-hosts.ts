/**
 * Reconciling the agent hosts against what they actually have.
 *
 * Seven applications on this workstation can be taught RedSkills, and
 * every one of them learns it differently: Claude Code and Codex own
 * marketplace caches, OpenCode and RedCode consume a generated tree, Pi
 * and Hermes read skills off a path, Gemini takes an extension. One
 * package set has to reach all seven and be provably there afterwards.
 *
 * ## Why the stamp had to go
 *
 * The first version of this file recorded, per host, the checkout path it
 * was last refreshed against, and skipped a host whose recorded path was
 * the resolved one. That is a correct gate for exactly one kind of change:
 * a new version installed at a new path. It is blind to every other kind.
 *
 * A development checkout is edited in place and never moves. A package set
 * rebuilt from the same version carries different bytes under the same
 * name. And a host's own state is not addressed by the stamp at all — an
 * operator who cleared their plugin cache, an upgrade that dropped a
 * generated directory, a config a second tool rewrote all leave the stamp
 * saying "current" about a host that has nothing. The stamp described what
 * red-dev *attempted*, and reported it as what the machine *has*.
 *
 * So a record here is written from three observations rather than one
 * assumption: the digest of the package set the host was reconciled
 * against, the digest of the state that reconciliation is responsible for
 * as it exists on disk now, and the mode the adapter used to put it there.
 * A converge re-reconciles a host when any of the three has moved — which
 * covers the in-place edit, the rebuilt set and the cleared cache, and
 * still costs nothing on the ordinary converge where all three agree.
 *
 * ## Plan, apply, verify, record — in that order
 *
 * Every adapter answers a plan: the commands to issue, the files red-dev
 * writes itself, the fields it owns inside files somebody else owns, and
 * the state that has to exist afterwards. Applying it runs that plan;
 * verifying it reads the result back from disk; and only a verification
 * that passed writes a record. A host that was absent, blocked, refused a
 * command or converged only partly leaves whatever record it had — which
 * means the next converge asks it again, and doctor keeps saying the true
 * thing about it in the meantime. Being wrong that way costs one extra
 * reconciliation; being wrong the other way is a host frozen on an old
 * tree with a file on disk claiming it is current.
 *
 * ## Only `dev` is activated
 *
 * The package set carries every plugin payload, and Spec #201 activates
 * exactly one of them in the coder hosts: `dev` is the global process
 * surface, and Memory, Brain and the maintainer-only behaviour must not
 * start acting on a machine because they happened to be in the tarball.
 * So the activation set is derived from the set rather than from the
 * manifest's install list — everything is installed locally, one thing is
 * switched on.
 *
 * ## What red-dev writes, and what it refuses to write
 *
 * Where the package set carries a generator for a host, that generator is
 * invoked and nothing here reimplements it: the scripts live beside the
 * skills they render, so a skill added to RedSkills appears on the machine
 * with no release of this repo. Where it does not, red-dev projects the
 * activated plugin itself — but only into state it owns outright, or into
 * one named field of a user's file through src/owned-config.ts, which
 * leaves every other byte of that file exactly where it was.
 *
 * ## Converged is not the same as equal
 *
 * Seven hosts do not have seven equal surfaces. Gemini takes skills and
 * MCP and has no hook runner at all, so a set that ships hooks reaches it
 * without them; a set may declare no MCP for anybody. Both leave a host
 * that is genuinely converged and genuinely poorer than its neighbour, and
 * a walk that answered "reconciled" and stopped would be reporting the
 * table rather than the machine. So each plan says what became of every
 * capability the set carries, the record keeps it, and the converge and
 * doctor both name what a host did not get — with `absent` (the set
 * carried none) kept apart from `unsupported` (the host cannot take it),
 * because only one of the two is fixed by shipping a better set.
 *
 * Everything red-dev owns is written into the record as an ownership
 * manifest, and removal is that manifest read back. That is the whole of
 * the uninstall contract: a config directory holds files nobody here put
 * there, and the only defensible answer to "what did we leave behind" is a
 * list written at the time rather than a guess made afterwards.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { log } from "./log.ts";
import { redSkillsCurrentPosix } from "./red-skills-root.ts";
import { dropOwnedField, readOwnedField } from "./owned-config.ts";
import {
  applyOwned,
  dedupeOwned,
  may,
  missingOwned,
  must,
  ownedKey,
  runSteps,
  stateDigestOf,
  type Applied,
  type OwnedCopy,
  type OwnedEntry,
  type OwnedMerge,
  type OwnedWrite,
  type Step,
} from "./owned-state.ts";
import type { Platform } from "./platform.ts";
import type { Tool } from "./manifest.ts";
import { activatedPlugins } from "./red-skills-plugins.ts";

/**
 * One command in a host's reconciliation.
 *
 * The vocabulary is src/owned-state.ts's, re-exported under the name this
 * module's callers already use: a host step is a step, and two spellings
 * of the same record would be one more thing to keep in agreement.
 */
export type HostStep = Step;

/**
 * The richest mechanism an adapter found on this machine for its host.
 *
 * Recorded rather than declared, because for two of the seven it is a
 * property of the package set rather than of the host: Gemini and Hermes
 * are projected by red-dev today and will be `generator` the day RedSkills
 * ships a script for them. A doctor report that said "extension" about a
 * machine running a generator would be describing the table instead of the
 * machine, which is the failure this whole module is a correction to.
 */
export type AdapterMode = "marketplace" | "generator" | "extension" | "skills";

/** Whether a running session has yet to see what converged underneath it. */
export type ReloadState = "current" | "restart-needed";

/**
 * One thing the package set carries, and what became of it in this host.
 *
 * Seven hosts do not have seven equal surfaces. Gemini takes skills and
 * MCP and has no hook runner at all; a set may declare no MCP for anyone.
 * Both of those produce a host that is genuinely converged and genuinely
 * has less than its neighbour, and the two reasons are not the same fact:
 * `absent` is something the set never carried, `unsupported` is something
 * the host cannot be given. A converge that reported seven identical rows
 * would be describing the table instead of the machine, which is the
 * failure this whole module is a correction to.
 */
export interface HostCapability {
  /** `skills`, `mcp`, `hooks`. */
  name: string;
  /** Projected into the host, absent from the set, or beyond the host. */
  state: "projected" | "absent" | "unsupported";
  /** Why it is not projected. Present exactly when it is not. */
  reason?: string;
}

/** The capabilities a host did not get, as the lines a person reads. */
export function missingCapabilities(capabilities: readonly HostCapability[] = []): string[] {
  return capabilities
    .filter((c) => c.state !== "projected")
    .map((c) => `no ${c.name}: ${c.reason ?? c.state}`);
}

/** What every adapter is a function of. */
export interface AdapterContext {
  /** The plugins to activate — `dev` alone. */
  plugins: readonly string[];
  /** The resolved package set: `~/.red/skills/current`, followed. */
  source: string;
  /** That set's whole-set digest, which is what a record is keyed on. */
  setDigest: string;
  /** Its version, for a line a person reads. */
  setVersion: string;
  /** The stable pointer the marketplace hosts are registered against. */
  current: string;
  /** This user's home. */
  home: string;
  /** `$XDG_CONFIG_HOME`, or `~/.config`. */
  config: string;
  /**
   * What this machine is, for the adapters whose answer depends on it.
   *
   * Defaults to `process.platform`, and is a field rather than a call so
   * a Windows-only decision can be exercised on a machine that is not
   * Windows. Only the shape of the platform matters here, so it is that
   * string and not the whole Platform record.
   */
  os: "windows" | "linux" | "darwin";
}

export type { OwnedCopy, OwnedEntry, OwnedMerge, OwnedWrite };

/** Everything an adapter would do, computed before anything is touched. */
export interface HostPlan {
  /** How this host is being reached on this machine. */
  mode: AdapterMode;
  /** The commands to issue, in the order they have to be issued. */
  steps: HostStep[];
  /** Files red-dev writes itself. */
  writes: OwnedWrite[];
  /** Trees red-dev copies out of the package set. */
  copies: OwnedCopy[];
  /** Fields red-dev owns inside files somebody else owns. */
  merges: OwnedMerge[];
  /** State that must exist afterwards for this host to count as done. */
  expect: OwnedEntry[];
  /** What the set carries, and what this host does with each of it. */
  capabilities: HostCapability[];
  /**
   * Where a generator records what it wrote.
   *
   * Read rather than predicted: the generator is the only thing that knows
   * which paths it created, and a list in this repo would be one that
   * drifts from the tree — the way it fails being that it deletes
   * somebody else's file.
   */
  manifests: string[];
  /** Why this adapter cannot act here at all. Reported, never recorded. */
  blocked?: string;
  /**
   * True when `blocked` names a condition no later run can clear — this
   * platform, not this moment. See reconciliationFailed.
   */
  permanent?: boolean;
}

/** A plan with every empty part spelled out once, here instead of seven times. */
function plan(partial: Partial<HostPlan> & { mode: AdapterMode }): HostPlan {
  return {
    steps: [],
    writes: [],
    copies: [],
    merges: [],
    expect: [],
    capabilities: [],
    manifests: [],
    ...partial,
  };
}

/** What a host itself says about the state it holds, after the plan ran. */
export type HostCheck = { ok: true; witness: string } | { ok: false; reason: string };

/** One host red-dev reconciles RedSkills into, and how. */
export interface HostAdapter {
  /** Key in the registry, and the name in a log line. */
  name: string;
  /** The command that has to be on PATH for this host to exist. */
  cmd: string;
  /** What this adapter would do, given the set and this machine. */
  plan: (ctx: AdapterContext) => HostPlan;
  /**
   * Ground truth only this host can answer for.
   *
   * Owned paths and fields are verified generically below; this is for the
   * facts that live inside an application's own store, where the file
   * exists either way and only its contents say whether the host agrees.
   */
  check?: (ctx: AdapterContext, plan: HostPlan) => Promise<HostCheck>;
  /** The commands that take this host's own state back out. */
  remove: (ctx: AdapterContext) => HostStep[];
}

// ------------------------------------------------------------ the adapters

/** The marketplace name both installers register under. */
const MARKETPLACE = "red-skills";

/**
 * A generator inside the installed tree, addressed by path.
 *
 * The path is the whole contract. Each script resolves its own repo root
 * from where it sits, so naming it under `source` is what hands it the
 * tree — there is no second flag saying which set to render, and inventing
 * one here would be a place for the two to disagree.
 */
function generator(source: string, script: string): string {
  return join(source, "scripts", script);
}

/** Where a generator writes down what it created, in the two usual places. */
function manifestCandidates(ctx: AdapterContext, host: string): string[] {
  return [
    join(ctx.config, host, "redskills-install-manifest.txt"),
    join(ctx.home, `.${host}`, "redskills-install-manifest.txt"),
  ];
}

/** Where the activated plugin's payload sits inside the set. */
function pluginDir(ctx: AdapterContext, name: string): string {
  return join(ctx.source, "plugins", name);
}

/**
 * OpenCode and RedCode, which are the same generator with a `--host`.
 *
 * RedCode is an OpenCode-compatible host: same generated surface, a
 * different config directory. The shared installer expresses that as one
 * function called twice, and so does this — a second table row spelling
 * the same three flags out again is a place for them to drift.
 */
function opencodeCompatible(host: string): HostAdapter {
  const script = (source: string) => generator(source, "install-opencode.sh");
  return {
    name: host,
    cmd: host,
    plan: (ctx) => {
      if (!existsSync(script(ctx.source))) {
        return plan({ mode: "generator", blocked: "the package set carries no install-opencode.sh" });
      }
      // A `.sh` cannot be executed on Windows: there is no shebang
      // handling, so the spawn fails with EFTYPE and the whole
      // reconciliation is reported as failed — which then holds the
      // adoption, which refuses to remove anything until every surface
      // verifies. One host that cannot work on this platform was
      // stopping every other host's cleanup.
      //
      // Blocked rather than failed, which is the difference between "not
      // supported here" and "broken here". Making it work is the
      // publishing side's: the generator would have to be a `.mjs` the
      // way install-hermes-skills.mjs already is, or a `.ps1` beside the
      // shell one. Running it through Git Bash is not the answer — the
      // paths it writes into the config would be the ones Git Bash sees,
      // not the ones a Windows program reads.
      if (ctx.os === "windows") {
        return plan({
          mode: "generator",
          blocked: `${host}: its generator is a shell script and this is Windows`,
          permanent: true,
        });
      }
      return plan({
        mode: "generator",
        steps: [must(script(ctx.source), "--global", "--host", host)],
        manifests: manifestCandidates(ctx, host),
      });
    },
    remove: (ctx) => [must(script(ctx.source), "--uninstall", "--global", "--host", host)],
  };
}

/**
 * Claude and Codex: the two hosts with a marketplace, driven by their CLIs.
 *
 * Both spellings were read off the installed CLIs rather than assumed:
 *
 *   claude  `plugin marketplace update <name>`  then `plugin update <p>`
 *   codex   `plugin marketplace upgrade <name>` then `plugin add <p>`
 *
 * Codex has no `plugin update` at all, so reconciling there is a remove
 * followed by an add: the add reinstalls from the marketplace snapshot the
 * line above it just upgraded. The remove is optional because a plugin
 * that is not installed yet makes it exit non-zero, and that is not a
 * broken host. The upgrade is optional too: `marketplace upgrade` only
 * knows Git marketplaces, and where red-dev owns the registration the
 * marketplace is a directory — the add reads the tree as it stands.
 *
 * Neither is verified by its exit code. What is read back is the entry the
 * host itself wrote down, in the file the standalone installer's own
 * healing reads: a machine can be told to update and record a registration
 * still pointing at GitHub, and that is precisely the state a record must
 * not describe as converged.
 */
const claude: HostAdapter = {
  name: "claude",
  cmd: "claude",
  plan: (ctx) =>
    plan({
      mode: "marketplace",
      steps: [
        must("claude", "plugin", "marketplace", "update", MARKETPLACE),
        ...ctx.plugins.map((p) => must("claude", "plugin", "update", `${p}@${MARKETPLACE}`)),
      ],
      // Claude's own store, in JSON, so a registration the CLI failed to
      // take out can still be removed without rewriting the file.
      expect: [
        { kind: "field", file: claudeMarketplaceFile(ctx), pointer: [MARKETPLACE] },
      ],
    }),
  check: async (ctx) => {
    const { claudeRegistration, registrationIsOurs } = await import("./red-skills-registration.ts");
    const registration = await claudeRegistration(ctx.home);
    if (!registrationIsOurs(registration, ctx.current)) {
      return { ok: false, reason: `the marketplace is registered from ${registration?.source ?? "nothing"}` };
    }
    return { ok: true, witness: JSON.stringify(registration) };
  },
  remove: (ctx) => [
    // `--keep-data`, matching the shared installer: removing a host is not
    // a request to delete whatever the plugin stored for you.
    ...ctx.plugins.map((p) => may("claude", "plugin", "remove", "--keep-data", p)),
    may("claude", "plugin", "marketplace", "remove", MARKETPLACE),
  ],
};

function claudeMarketplaceFile(ctx: AdapterContext): string {
  return join(ctx.home, ".claude", "plugins", "known_marketplaces.json");
}

const codex: HostAdapter = {
  name: "codex",
  cmd: "codex",
  plan: (ctx) =>
    plan({
      mode: "marketplace",
      steps: [
        may("codex", "plugin", "marketplace", "upgrade", MARKETPLACE),
        ...ctx.plugins.flatMap((p) => [
          may("codex", "plugin", "remove", `${p}@${MARKETPLACE}`),
          must("codex", "plugin", "add", `${p}@${MARKETPLACE}`),
        ]),
      ],
      // Codex keeps its registration in TOML, which red-dev does not edit:
      // the CLI that wrote it is the thing that takes it out again, and
      // the record says so rather than pretending to a path it may remove.
      expect: [{ kind: "host", what: `codex marketplace ${MARKETPLACE}` }],
    }),
  check: async (ctx) => {
    const { codexRegistration, registrationIsOurs } = await import("./red-skills-registration.ts");
    const registration = await codexRegistration(ctx.home);
    if (!registrationIsOurs(registration, ctx.current)) {
      return { ok: false, reason: `the marketplace is registered from ${registration?.source ?? "nothing"}` };
    }
    return { ok: true, witness: JSON.stringify(registration) };
  },
  remove: (ctx) => [
    ...ctx.plugins.map((p) => may("codex", "plugin", "remove", `${p}@${MARKETPLACE}`)),
    may("codex", "plugin", "marketplace", "remove", MARKETPLACE),
  ],
};

/**
 * pi, whose generator ships in the tree like OpenCode's.
 *
 * It takes `--source-dir` as well as the path, because it can install its
 * packages from npm instead and the local set is what pins every host on
 * this machine to one version.
 */
const pi: HostAdapter = {
  name: "pi",
  cmd: "pi",
  plan: (ctx) => {
    const script = generator(ctx.source, "install-pi.sh");
    if (!existsSync(script)) {
      return plan({ mode: "generator", blocked: "the package set carries no install-pi.sh" });
    }
    return plan({
      mode: "generator",
      steps: [must(script, "--source-dir", ctx.source, "--user")],
      manifests: manifestCandidates(ctx, "pi"),
    });
  },
  remove: (ctx) => [must(generator(ctx.source, "install-pi.sh"), "--uninstall", "--user")],
};

/**
 * One skill of the activated plugin, as the set describes it.
 *
 * Name and description come out of the front matter the skill already
 * carries, because a projection that restated them would be a second place
 * for a skill's own description to be written down.
 */
interface SetSkill {
  name: string;
  description: string;
  path: string;
}

function frontMatter(text: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text.split(/^---\s*$/m)[1] ?? "");
  return match?.[1]?.trim() ?? null;
}

/** Every skill the activated plugins carry, in a stable order. */
function setSkills(ctx: AdapterContext): SetSkill[] {
  const out: SetSkill[] = [];
  for (const plugin of ctx.plugins) {
    const root = join(pluginDir(ctx, plugin), "skills");
    if (!existsSync(root)) continue;
    for (const dir of skillDirs(pluginDir(ctx, plugin), root)) {
      const file = join(dir, "SKILL.md");
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      out.push({
        name: frontMatter(text, "name") ?? basename(dir),
        description: frontMatter(text, "description") ?? "",
        path: dir,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Which skill directories a plugin ships, asked of the plugin.
 *
 * `plugin.json` lists them (`"skills": ["./skills/engineering/afk", …]`),
 * which is the publisher saying what this plugin *is* — and it is the
 * only thing that knows which drafts are drafts: red-skills keeps an
 * `in-progress/` bucket that ships in the tree and appears in no
 * declaration.
 *
 * The fallback is the old behaviour, one level under `skills/`, for a
 * plugin that declares nothing. That single level was all there ever
 * was, and red-skills has organised its skills into buckets —
 * `skills/engineering/<name>/SKILL.md` — for as long as this has
 * existed, so the scan found zero every time and Gemini and Hermes were
 * blocked with "the package set carries no skills to project" on every
 * machine. 48 skills in the dev plugin alone, none of them projected.
 */
export function setSkillsIn(pluginRoot: string): SetSkill[] {
  const root = join(pluginRoot, "skills");
  if (!existsSync(root)) return [];
  const out: SetSkill[] = [];
  for (const dir of skillDirs(pluginRoot, root)) {
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    out.push({
      name: frontMatter(text, "name") ?? basename(dir),
      description: frontMatter(text, "description") ?? "",
      path: dir,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function skillDirs(pluginRoot: string, skillsRoot: string): string[] {
  const declared = declaredSkillPaths(pluginRoot);
  if (declared.length > 0) return declared;

  // No declaration to read, so look — one level for the flat layout
  // this used to assume, and one deeper for the buckets red-skills
  // actually ships (`skills/engineering/<name>/SKILL.md`). `in-progress`
  // is skipped by name: it is the bucket red-skills documents as drafts
  // and declares nowhere, and a fallback that projected it would put
  // unfinished skills in front of people.
  const out: string[] = [];
  for (const entry of listing(skillsRoot)) {
    if (entry === "in-progress") continue;
    const dir = join(skillsRoot, entry);
    if (existsSync(join(dir, "SKILL.md"))) {
      out.push(dir);
      continue;
    }
    for (const nested of listing(dir)) {
      const inner = join(dir, nested);
      if (existsSync(join(inner, "SKILL.md"))) out.push(inner);
    }
  }
  return out;
}

function declaredSkillPaths(pluginRoot: string): string[] {
  for (const manifest of [
    join(pluginRoot, ".claude-plugin", "plugin.json"),
    join(pluginRoot, ".codex-plugin", "plugin.json"),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { skills?: unknown };
      if (!Array.isArray(parsed.skills)) continue;
      const paths = parsed.skills
        .filter((entry): entry is string => typeof entry === "string")
        // Relative to the plugin, as declared. `resolve` rather than
        // `join` so a declaration that is already absolute is left alone.
        .map((entry) => resolve(pluginRoot, entry))
        .filter((path) => existsSync(path));
      if (paths.length > 0) return paths;
    } catch {
      // An unreadable or absent manifest is not a plugin without
      // skills; the caller falls back to looking.
    }
  }
  return [];
}

/**
 * The MCP the package set declares for a plugin, and never one we invented.
 *
 * A Claude-Code plugin declares its servers in `.mcp.json` at its root, and
 * that file is the only thing consulted here. A set that declares none
 * gives a host with no MCP surface, which is the honest outcome: a made-up
 * command would be a server every host fails to start, reported as a
 * feature every host has.
 */
function declaredMcp(ctx: AdapterContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const plugin of ctx.plugins) {
    for (const [name, value] of Object.entries(pluginMcp(pluginDir(ctx, plugin)))) {
      out[`${MARKETPLACE}-${name}`] = value;
    }
  }
  return out;
}

/** One plugin's servers, under the names the plugin itself gave them. */
function pluginMcp(root: string): Record<string, unknown> {
  const file = join(root, ".mcp.json");
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const servers = (parsed["mcpServers"] ?? parsed) as Record<string, unknown>;
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return {};
    return servers;
  } catch {
    // A payload we cannot read is a payload we do not project. The host
    // is reported as unconverged rather than given half a config.
    log.warn(`red-skills: ${file} is not JSON — no MCP projected from it`);
    return {};
  }
}

/**
 * The commands one plugin's `hooks/hooks.json` declares, flattened.
 *
 * Shape rather than schema: the file nests matchers inside event names and
 * hooks inside matchers, and everything read out of it here is the one
 * field that names something on disk. A file this cannot parse declares no
 * hook, which is the same answer as a plugin that ships none — the host
 * that has no hook runner is told the truth either way.
 */
function pluginHooks(root: string): string[] {
  const file = join(root, "hooks", "hooks.json");
  if (!existsSync(file)) return [];
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const command = record["command"];
    if (typeof command === "string") out.push(command);
    for (const value of Object.values(record)) walk(value);
  };
  try {
    walk(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    log.warn(`red-skills: ${file} is not JSON — no hook read out of it`);
    return [];
  }
  return out;
}

/** One file the activated payload names, and what named it. */
interface DeclaredPath {
  /** The declaration it came out of, for the sentence a person reads. */
  what: string;
  /** Where it resolves to inside the package set. */
  path: string;
}

/**
 * The file a token in a declared command names, or null if it names none.
 *
 * A command is `bun`, `node`, a plugin-root path or an argument that is
 * not a path at all, and only the third of those is checkable: a bare
 * program name resolves off PATH and a bare filename resolves against a
 * cwd nothing here owns, so treating either as a dangling path would be a
 * check that fails on every correct set. A token still carrying a
 * variable after expansion belongs to the host that expands it.
 */
function declaredPathIn(root: string, token: string): string | null {
  // A function replacement, so a `$&` in the resolved path stays literal.
  const expanded = token.replace(/\$\{(?:CLAUDE|CODEX)_PLUGIN_ROOT\}/g, () => root);
  if (expanded.includes("$")) return null;
  if (!expanded.includes("/") && !expanded.includes("\\")) return null;
  return isAbsolute(expanded) ? expanded : join(root, expanded);
}

/**
 * Every file the activated payload names, so a dangling one can be caught.
 *
 * A package set composed halfway declares a server and a hook whose
 * scripts are not in the tarball. Installing that projects a config whose
 * every entry fails the moment the host tries to use it — an MCP server
 * that dies at launch, a hook that is not there — and a host recorded as
 * converged against it is the worst of the two ways to be wrong. So the
 * declarations are resolved against the set before anything is written.
 */
function declaredPaths(ctx: AdapterContext): DeclaredPath[] {
  const out: DeclaredPath[] = [];
  for (const plugin of ctx.plugins) {
    const root = pluginDir(ctx, plugin);
    for (const command of pluginHooks(root)) {
      for (const token of command.split(/\s+/)) {
        const path = declaredPathIn(root, token);
        if (path !== null) out.push({ what: `${plugin} hook`, path });
      }
    }
    for (const [name, server] of Object.entries(pluginMcp(root))) {
      for (const token of serverTokens(server)) {
        const path = declaredPathIn(root, token);
        if (path !== null) out.push({ what: `${plugin} MCP server ${name}`, path });
      }
    }
  }
  return out;
}

/** The command and arguments of one declared server, as flat strings. */
function serverTokens(server: unknown): string[] {
  if (server === null || typeof server !== "object") return [];
  const record = server as Record<string, unknown>;
  const command = typeof record["command"] === "string" ? [record["command"]] : [];
  const args = Array.isArray(record["args"]) ? record["args"].filter((a) => typeof a === "string") : [];
  return [...command, ...(args as string[])];
}

/**
 * Gemini, which takes an extension directory and one field of its settings.
 *
 * Gemini has no marketplace and the package set ships no generator for it
 * yet, so red-dev projects the activated plugin into `~/.gemini/extensions`
 * — a directory it owns outright, which is the include shape: nothing the
 * operator wrote is inside it, and removing it removes exactly what was
 * added. The extension carries its own context file, which is how a skill
 * the set ships becomes something Gemini reads.
 *
 * Its MCP servers are the one thing that cannot live in an owned directory,
 * because Gemini resolves them from `settings.json`. Those go in as one
 * named field each, spliced into the operator's file without touching a
 * byte of the rest of it, and recorded so that removing them leaves the
 * file they had. A set that declares no MCP touches `settings.json` at all.
 */
const gemini: HostAdapter = {
  name: "gemini",
  cmd: "gemini",
  plan: (ctx) => {
    const script = generator(ctx.source, "install-gemini.sh");
    if (existsSync(script)) {
      // The day RedSkills ships one, it wins: a generator lives beside the
      // skills it renders, and this projection does not.
      return plan({
        mode: "generator",
        steps: [must(script, "--source-dir", ctx.source, "--user")],
        manifests: manifestCandidates(ctx, "gemini"),
      });
    }

    const skills = setSkills(ctx);
    if (skills.length === 0) {
      return plan({ mode: "extension", blocked: "the package set carries no skills to project" });
    }

    // Before a byte is written, because the alternative is a config whose
    // every entry fails the first time Gemini uses it and a home directory
    // holding half an extension nothing recorded.
    const dangling = declaredPaths(ctx).find((declared) => !existsSync(declared.path));
    if (dangling !== undefined) {
      return plan({
        mode: "extension",
        blocked: `the ${dangling.what} names ${dangling.path}, which the package set does not carry`,
      });
    }

    const dir = geminiExtensionDir(ctx);
    const mcp = declaredMcp(ctx);
    const hooks = ctx.plugins.flatMap((p) => pluginHooks(pluginDir(ctx, p)));
    const settings = geminiSettingsFile(ctx);
    return plan({
      mode: "extension",
      writes: [
        {
          path: join(dir, "gemini-extension.json"),
          bytes: `${JSON.stringify(
            { name: MARKETPLACE, version: ctx.setVersion, contextFileName: "REDSKILLS.md" },
            null,
            2,
          )}\n`,
        },
        { path: join(dir, "REDSKILLS.md"), bytes: contextFile(ctx, skills, mcp, hooks) },
      ],
      copies: skills.map((skill) => ({ from: skill.path, to: join(dir, "skills", skill.name) })),
      merges: Object.entries(mcp).map(([name, value]) => ({
        file: settings,
        pointer: ["mcpServers", name],
        value,
      })),
      // The directory itself, not only what is in it: red-dev made it, so
      // removing RedSkills has to leave `~/.gemini/extensions` the way it
      // found it rather than with our empty shell still sitting in it.
      expect: [{ kind: "path", path: dir }],
      capabilities: [
        { name: "skills", state: "projected" },
        Object.keys(mcp).length > 0
          ? { name: "mcp", state: "projected" }
          : { name: "mcp", state: "absent", reason: "the package set declares no MCP server" },
        // Not a gap in the projection: Gemini has no hook runner to give
        // them to, so a set that carries hooks reaches this host without
        // them and doctor says which capability was left behind.
        hooks.length > 0
          ? {
              name: "hooks",
              state: "unsupported",
              reason: `Gemini runs no hook of its own, so the ${hooks.length} the set declares are not projected`,
            }
          : { name: "hooks", state: "absent", reason: "the package set declares no hook" },
      ],
    });
  },
  check: (ctx, desired) => geminiCheck(ctx, desired),
  remove: (ctx) => {
    const script = generator(ctx.source, "install-gemini.sh");
    return existsSync(script) ? [must(script, "--uninstall", "--user")] : [];
  },
};

/** The directory red-dev owns outright under Gemini's extensions. */
function geminiExtensionDir(ctx: AdapterContext): string {
  return join(ctx.home, ".gemini", "extensions", MARKETPLACE);
}

/** The file Gemini resolves its MCP servers from, and the operator owns. */
function geminiSettingsFile(ctx: AdapterContext): string {
  return join(ctx.home, ".gemini", "settings.json");
}

/**
 * What Gemini itself says it has, read back the way Gemini reads it.
 *
 * The exit code proves nothing here — nothing was spawned. What can be
 * wrong is everything between the plan and the load: a manifest Gemini's
 * parser rejects, a `contextFileName` pointing at a file that is not
 * beside it, a skills directory that was copied and then emptied, a server
 * a second tool took back out of `settings.json`. Each of those leaves a
 * host that looks installed from the outside and loads nothing, and each
 * of them is a reason to reconcile rather than a reason to record.
 *
 * The declared paths are resolved again at the end rather than only at
 * plan time, because this is also what a skipped converge asks: a set
 * edited in place under a recorded host can lose the script its server
 * runs, and the host has to stop being current the moment it does.
 *
 * A generator in the tree answers for its own tree — its install manifest
 * is what verification reads, generically — so this stands down for it.
 */
async function geminiCheck(ctx: AdapterContext, desired: HostPlan): Promise<HostCheck> {
  if (desired.mode !== "extension") return { ok: true, witness: "" };

  const dir = geminiExtensionDir(ctx);
  const manifest = join(dir, "gemini-extension.json");
  if (!existsSync(manifest)) return { ok: false, reason: `${manifest} is not there` };

  let loaded: Record<string, unknown>;
  try {
    loaded = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: `${manifest} is not JSON Gemini can load` };
  }
  if (loaded["name"] !== MARKETPLACE) {
    return { ok: false, reason: `${manifest} declares the extension as ${String(loaded["name"])}` };
  }
  const contextFileName = loaded["contextFileName"];
  if (typeof contextFileName !== "string" || !existsSync(join(dir, contextFileName))) {
    return { ok: false, reason: `${manifest} names a context file Gemini cannot read` };
  }

  for (const skill of setSkills(ctx)) {
    const projected = join(dir, "skills", skill.name, "SKILL.md");
    if (!existsSync(projected)) return { ok: false, reason: `${projected} is not there` };
  }

  const settings = geminiSettingsFile(ctx);
  const text = existsSync(settings) ? readFileSync(settings, "utf8") : "";
  const servers = declaredMcp(ctx);
  for (const [name, value] of Object.entries(servers)) {
    const seen = readOwnedField(text, ["mcpServers", name]);
    if (seen === undefined) return { ok: false, reason: `${settings} declares no mcpServers.${name}` };
    if (JSON.stringify(seen) !== JSON.stringify(value)) {
      return { ok: false, reason: `mcpServers.${name} in ${settings} is not the server the set declares` };
    }
  }

  for (const declared of declaredPaths(ctx)) {
    if (!existsSync(declared.path)) {
      return { ok: false, reason: `the ${declared.what} names ${declared.path}, which is not there` };
    }
  }

  return { ok: true, witness: JSON.stringify({ loaded, servers: Object.keys(servers).sort() }) };
}

/**
 * Hermes, which has skills and nothing else.
 *
 * The skills-only fallback Spec #201 names: no marketplace, no extension
 * manifest, no MCP surface, no hook runner and no agent loader, so the
 * adapter writes the activated plugin's skills into a directory of its own
 * under the host's skills path and stops there. Less than the other six
 * get, and saying so is the point — a mode of `skills` and three
 * `unsupported` capabilities are how doctor reports a host that is
 * genuinely converged and genuinely has less.
 *
 * A skill is a directory rather than a file, and the whole of it is what
 * makes it work: the references a skill cites, the scripts it runs, the
 * templates it renders. So the projection is the tree, verification is
 * every file of that tree read back, and the plan stands down before it
 * writes anything when the set carries a skill whose own payload does not
 * resolve — a half-composed set installs nothing here rather than a skill
 * Hermes loads and then fails partway through.
 *
 * What it cannot take is reported and never blocks. A set that ships hooks,
 * MCP servers or agent definitions is not a broken set for this host and
 * does not make its skills any less installed: those capabilities are named
 * as `unsupported` in the outcome, in the record, in doctor and in the page
 * Hermes itself reads, and the skills are verified on their own terms.
 */
const hermes: HostAdapter = {
  name: "hermes",
  cmd: "hermes",
  plan: (ctx) => {
    const script = generator(ctx.source, "install-hermes.sh");
    if (existsSync(script)) {
      // The day RedSkills ships one, it wins, for the reason Gemini's does:
      // a generator lives beside the skills it renders, and this does not.
      return plan({
        mode: "generator",
        steps: [must(script, "--source-dir", ctx.source, "--user")],
        manifests: manifestCandidates(ctx, "hermes"),
      });
    }

    const skills = setSkills(ctx);
    if (skills.length === 0) {
      return plan({ mode: "skills", blocked: "the package set carries no skills to project" });
    }

    // Before a byte is written: a skill missing the file it tells the model
    // to read is a skill that fails in the middle of somebody's session,
    // and a home holding half of one is worse than a host left unwired.
    const dangling = danglingAsset(skills);
    if (dangling !== undefined) {
      return plan({
        mode: "skills",
        blocked: `the ${dangling.what} names ${dangling.path}, which the package set does not carry`,
      });
    }

    const dir = hermesSkillsDir(ctx);
    const capabilities = hermesCapabilities(ctx);
    return plan({
      mode: "skills",
      // The one file red-dev writes rather than copies: what this host has
      // and, as importantly, what it does not. A model told it has skills
      // and nothing else stops waiting for a hook that will never fire.
      writes: [{ path: join(dir, "REDSKILLS.md"), bytes: hermesContext(ctx, skills, capabilities) }],
      copies: skills.map((skill) => ({ from: skill.path, to: join(dir, skill.name) })),
      // The directory itself, not only what is in it: red-dev made it, so
      // removing RedSkills has to leave `~/.hermes/skills` the way it found
      // it rather than with our empty shell still sitting in it.
      expect: [{ kind: "path", path: dir }],
      capabilities,
    });
  },
  check: (ctx, desired) => hermesCheck(ctx, desired),
  remove: (ctx) => {
    const script = generator(ctx.source, "install-hermes.sh");
    return existsSync(script) ? [must(script, "--uninstall", "--user")] : [];
  },
};

/** The directory red-dev owns outright under Hermes's skills path. */
function hermesSkillsDir(ctx: AdapterContext): string {
  return join(ctx.home, ".hermes", "skills", MARKETPLACE);
}

/**
 * What the set carries, and what a skills-only host does with each of it.
 *
 * Three of the four are the same shape — carried by the set, refused by the
 * host — and the distinction that matters in every one of them is between
 * a capability this host cannot be given and one nobody was given, because
 * only the second is fixed by shipping a better set.
 */
function hermesCapabilities(ctx: AdapterContext): HostCapability[] {
  return [
    { name: "skills", state: "projected" },
    beyondHermes(
      "mcp",
      Object.keys(declaredMcp(ctx)).length,
      "Hermes starts no MCP server of its own",
      "the package set declares no MCP server",
    ),
    beyondHermes(
      "hooks",
      ctx.plugins.flatMap((p) => pluginHooks(pluginDir(ctx, p))).length,
      "Hermes runs no hook of its own",
      "the package set declares no hook",
    ),
    beyondHermes(
      "agents",
      setAgents(ctx).length,
      "Hermes loads no agent of its own",
      "the package set carries no agent",
    ),
  ];
}

/** One capability this host cannot take: unsupported if carried, absent if not. */
function beyondHermes(name: string, carried: number, cannot: string, none: string): HostCapability {
  if (carried === 0) return { name, state: "absent", reason: none };
  const what = carried === 1 ? "the one the set carries is" : `the ${carried} the set carries are`;
  return { name, state: "unsupported", reason: `${cannot}, so ${what} not projected` };
}

/** Every agent definition the activated plugins carry, in a stable order. */
function setAgents(ctx: AdapterContext): string[] {
  const out: string[] = [];
  for (const plugin of ctx.plugins) {
    for (const name of listing(join(pluginDir(ctx, plugin), "agents"))) {
      if (name.endsWith(".md")) out.push(`${plugin}/${name}`);
    }
  }
  return out.sort();
}

/**
 * Every file one skill carries, relative to it, in a stable order.
 *
 * A skill is its whole directory: `SKILL.md` is the entry point and the
 * references, scripts and templates beside it are what the entry point
 * sends a model to. Listing them is how a projection can be checked for
 * being complete rather than for having started.
 *
 * A link with nothing behind it is listed rather than followed. It is a
 * file as far as the copy is concerned — it arrives on the machine, still
 * pointing at nothing — and that is exactly the thing worth catching.
 */
function carriedAssets(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of listing(root)) {
    const path = join(root, name);
    const relative = prefix === "" ? name : `${prefix}/${name}`;
    if (existsSync(path) && statSync(path).isDirectory()) {
      out.push(...carriedAssets(path, relative));
      continue;
    }
    out.push(relative);
  }
  return out;
}

/** The first file an activated skill carries that resolves to nothing. */
function danglingAsset(skills: readonly SetSkill[]): DeclaredPath | undefined {
  for (const skill of skills) {
    for (const asset of carriedAssets(skill.path)) {
      const path = join(skill.path, asset);
      if (!existsSync(path)) return { what: `${skill.name} skill`, path };
    }
  }
  return undefined;
}

/**
 * What Hermes has, read back the way Hermes reads it.
 *
 * Nothing was spawned, so there is no exit code to believe. What can be
 * wrong is everything between the plan and the load: a copy that ran out
 * of disk partway through a tree, a skill an operator deleted out of the
 * projected directory, a reference the set carries that never arrived.
 * Each of those is a skill Hermes lists and cannot complete, and each is a
 * reason to reconcile rather than a reason to record — which is also what
 * a skipped converge asks, so a projection that lost a file stops being
 * current the moment it does.
 *
 * A generator in the tree answers for its own tree, so this stands down
 * for it: its install manifest is what verification reads, generically.
 */
async function hermesCheck(ctx: AdapterContext, desired: HostPlan): Promise<HostCheck> {
  if (desired.mode !== "skills") return { ok: true, witness: "" };

  const dir = hermesSkillsDir(ctx);
  const index = join(dir, "REDSKILLS.md");
  if (!existsSync(index)) return { ok: false, reason: `${index} is not there` };

  const projected: string[] = [];
  for (const skill of setSkills(ctx)) {
    const into = join(dir, skill.name);
    const entry = join(into, "SKILL.md");
    if (!existsSync(entry)) return { ok: false, reason: `${entry} is not there` };
    for (const asset of carriedAssets(skill.path)) {
      const path = join(into, asset);
      if (!existsSync(path)) {
        return { ok: false, reason: `${path} is not there, and the ${skill.name} skill carries it` };
      }
    }
    projected.push(skill.name);
  }

  return { ok: true, witness: JSON.stringify({ skills: projected }) };
}

/**
 * The page Hermes reads beside the skills: the set, and this host's limits.
 *
 * The limits are the record's own sentences rather than a second wording of
 * them, because a host describing itself one way to a person and another
 * way to the model reading its skills path is two answers to one question.
 */
function hermesContext(
  ctx: AdapterContext,
  skills: readonly SetSkill[],
  capabilities: readonly HostCapability[],
): string {
  const limits = missingCapabilities(capabilities);
  const lines = [
    `# RedSkills ${ctx.setVersion}`,
    "",
    `Projected by red-dev from ${ctx.current}. Do not edit: this file is`,
    "rewritten whenever the package set moves.",
    "",
    "## Skills",
    "",
    ...skills.map((skill) =>
      skill.description ? `- **${skill.name}** — ${skill.description}` : `- **${skill.name}**`
    ),
    "",
    "## What this host does not have",
    "",
    ...(limits.length > 0
      ? limits.map((limit) => `- ${limit}`)
      : ["Everything the package set carries reached this host."]),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * What Gemini reads when it loads the extension: the set, as one page.
 *
 * The servers and the missing hook runner are on it as well as the skills,
 * because a model told what it has is also being told what it does not:
 * a session that believes a hook fires on its behalf is a session waiting
 * for something nothing on this host will ever run.
 */
function contextFile(
  ctx: AdapterContext,
  skills: readonly SetSkill[],
  servers: Readonly<Record<string, unknown>>,
  hooks: readonly string[],
): string {
  const names = Object.keys(servers).sort();
  const lines = [
    `# RedSkills ${ctx.setVersion}`,
    "",
    `Projected by red-dev from ${ctx.current}. Do not edit: this file is`,
    "rewritten whenever the package set moves.",
    "",
    "## Skills",
    "",
    ...skills.map((skill) =>
      skill.description ? `- **${skill.name}** — ${skill.description}` : `- **${skill.name}**`
    ),
    "",
    "## MCP servers",
    "",
    ...(names.length > 0
      ? names.map((name) => `- \`${name}\`, started by Gemini from \`settings.json\`.`)
      : ["The package set declares none."]),
    "",
    "## Hooks",
    "",
    hooks.length > 0
      ? `The set declares ${hooks.length}, and Gemini runs no hook of its own: none of them fires here.`
      : "The package set declares none.",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The seven hosts, in the order a converge walks them.
 *
 * Spec #201 settles the set: OpenCode stays managed alongside RedCode, and
 * Gemini and Hermes are required adapters rather than best-effort ones —
 * seven-host success cannot be reported while either is blocked, which it
 * cannot be if neither is in the table.
 */
export const HOST_ADAPTERS: readonly HostAdapter[] = [
  claude,
  codex,
  opencodeCompatible("opencode"),
  opencodeCompatible("redcode"),
  gemini,
  pi,
  hermes,
];

// ------------------------------------------------------------- the registry

/** What one host was last observed to have. */
export interface HostRecord {
  /** The whole-set digest of the package set it was reconciled against. */
  setDigest: string;
  /** That set's version, for a line a person reads. */
  setVersion: string;
  /** The mechanism the adapter used. */
  mode: AdapterMode;
  /** The plugins activated in this host. */
  plugins: string[];
  /**
   * What the set carried and what this host got of it.
   *
   * Optional because it arrived after schema 2 shipped, and a record
   * written before it is not wrong — it is a record from a converge that
   * did not have the vocabulary. It reads as no capability reported, and
   * the next converge that touches the host writes the real answer.
   */
  capabilities?: HostCapability[];
  /** The digest of the owned state, as it was on disk when verified. */
  stateDigest: string;
  /** Whether a session running at the time still has to be restarted. */
  reload: ReloadState;
  /** Everything this reconciliation is responsible for, for removal. */
  owned: OwnedEntry[];
  /** When the verification that wrote this record ran. */
  verifiedAt: string;
}

/**
 * The registry, at the path the stamp used to live at.
 *
 * The old file was a bare `host -> path` map with no schema field, so it
 * reads here as no registry at all and every host is reconciled once on the
 * converge after the upgrade. That is the correct migration: the old file
 * recorded an attempt, and there is nothing in it worth believing.
 */
export interface HostRegistry {
  schema: 2;
  hosts: Record<string, HostRecord>;
}

/** Computed rather than a constant: the tests move home between cases. */
export function hostRegistryPath(home: string): string {
  return `${home.replace(/\\/g, "/")}/.local/share/red-dev/red-skills-hosts.json`;
}

export function readHostRegistry(home: string): HostRegistry {
  const path = hostRegistryPath(home);
  if (!existsSync(path)) return { schema: 2, hosts: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HostRegistry>;
    if (parsed?.schema !== 2 || typeof parsed.hosts !== "object" || parsed.hosts === null) {
      return { schema: 2, hosts: {} };
    }
    return { schema: 2, hosts: parsed.hosts };
  } catch {
    // A registry we cannot read means reconcile, which is the safe way to
    // be wrong: the cost is one extra walk, not a permanently stale host.
    return { schema: 2, hosts: {} };
  }
}

async function writeHostRegistry(home: string, registry: HostRegistry): Promise<void> {
  const path = hostRegistryPath(home);
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(registry, null, 2)}\n`);
}

// ------------------------------------------------------------ the ownership

function listing(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

// -------------------------------------------------------------- the outcome

/** What happened to one host, in the vocabulary a caller has to distinguish. */
export type HostStatus = "reconciled" | "current" | "absent" | "blocked" | "failed";

export interface HostOutcome {
  /** The host's name in HOST_ADAPTERS. */
  host: string;
  status: HostStatus;
  /** The mechanism used, where one was chosen. */
  mode?: AdapterMode;
  /** Why, for everything that is not `reconciled`. */
  reason?: string;
  /** Present when this converge verified the host. */
  reload?: ReloadState;
  /**
   * What the set carries and this host did not get, in sentences.
   *
   * Reported on the skipped converge as well as the reconciling one, out
   * of the record — a host is no richer on the day nothing happened to it.
   */
  missing?: string[];
  /**
   * True when this host cannot converge on this machine at all, ever.
   *
   * Not "not yet": a platform this host has no implementation for. It
   * is reported the same way and excluded from the verdict, so one
   * impossible surface does not make a converged machine look broken.
   */
  permanent?: boolean;
}

/**
 * Whether every host that *could* converge did.
 *
 * `blocked` used to count as a failure, and for most of the reasons a
 * host is blocked that is right: the set carries no generator, the CLI
 * is mid-install, something is missing that should be there. But it is
 * also the answer for a host that cannot work on this platform at all —
 * opencode's generator is a shell script and Windows has no shebang —
 * and that is a permanent condition. Counting it as failure made every
 * `red-dev update` on Windows end "partial" forever, and held the Spec
 * #185 adoption, which removes nothing until every surface verifies, on
 * a machine where one surface can never verify.
 *
 * So a permanent block is not a failure; a blocking condition that a
 * later run could clear still is. The distinction is the adapter's to
 * declare, because only it knows which of its own blocks are which.
 */
export function reconciliationFailed(outcomes: readonly HostOutcome[]): boolean {
  return stuckHosts(outcomes).length > 0;
}

/**
 * The hosts standing between this machine and a converged one.
 *
 * One predicate, exported, because there were four: this module's
 * verdict, the warning agents.ts prints, the surface staged-update.ts
 * reports and the gate red-skills-adopt.ts opens on. Each spelled
 * `blocked || failed` by hand, so teaching one of them that a permanent
 * block is not a failure taught only that one — the machine then said
 * "hosts: 6 on the active revision" and "not reconciled into opencode"
 * in the same breath, and the adoption stayed shut.
 */
export function stuckHosts(outcomes: readonly HostOutcome[]): HostOutcome[] {
  return outcomes.filter(
    (o) => o.status === "failed" || (o.status === "blocked" && o.permanent !== true),
  );
}

/**
 * Everything the walk needs from outside itself.
 *
 * All of it has a real default and exists for the tests: reconciling is a
 * sequence of commands issued to CLIs that may not be installed, against a
 * set that may not exist, and the thing worth pinning is which commands ran
 * and what was on disk afterwards.
 */
export interface HostReconcileOptions {
  /** Defaults to this user's home. The registry lives under it. */
  home?: string;
  /** Defaults to `$XDG_CONFIG_HOME`, then `<home>/.config`. */
  config?: string;
  /** Defaults to this machine's. See AdapterContext.os. */
  os?: AdapterContext["os"];
  /** The resolved package set. Defaults to `resolvedSource()`. */
  source?: string | null;
  /** The pointer the marketplace hosts register. Defaults to `~/.red/skills/current`. */
  current?: string;
  /** The set's whole-set digest. Defaults to the recorded or computed one. */
  setDigest?: string;
  /** The set's version. Defaults to the recorded one, or the directory name. */
  setVersion?: string;
  /** The activation set. Defaults to `dev`, out of what the manifest declares. */
  plugins?: readonly string[];
  /** The manifest to derive the plugin set from. Defaults to TOOLS. */
  tools?: readonly Tool[];
  /** The hosts to walk. Defaults to HOST_ADAPTERS. */
  adapters?: readonly HostAdapter[];
  /** Is this host's command on PATH? Defaults to `commandPath`. */
  present?: (cmd: string) => boolean;
  /** Is a session of it running right now? Defaults to a `pgrep` probe. */
  running?: (cmd: string) => boolean;
  /** Runs one argv and answers its exit code. Defaults to spawnLogged. */
  run?: (cmd: string[]) => Promise<number>;
  /** The time a record is stamped with. Defaults to now. */
  now?: () => string;
}

function homeOf(): string {
  const h = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  return h.replace(/\\/g, "/");
}

/** What `process.platform` says, narrowed to the three this branches on. */
function platformOs(): AdapterContext["os"] {
  if (process.platform === "win32") return "windows";
  return process.platform === "darwin" ? "darwin" : "linux";
}

function configOf(home: string): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  return xdg ? xdg.replace(/\\/g, "/") : `${home}/.config`;
}

/** `v3.4.0` out of the resolved path, for a log line a person reads. */
function versionOf(source: string): string {
  return source.split("/").pop() ?? source;
}

/**
 * The identity of the set this machine resolves.
 *
 * A revision the converge installed is immutable and already carries a
 * recorded digest, so it is read rather than recomputed — hashing 25 MB on
 * every converge to learn what a file already says would be the cost this
 * gate exists to avoid. Anything else is hashed, and that is the case that
 * matters: a development checkout is edited in place, keeps its path and
 * has no recorded identity, so the only way to notice it moved is to look.
 */
async function setIdentity(home: string, source: string): Promise<{ digest: string; version: string }> {
  try {
    const { readPackageSetState } = await import("./red-skills-set.ts");
    const state = readPackageSetState(home);
    const active = state.revisions.find((r) => r.key === state.active);
    if (active && samePath(active.path, source)) {
      return { digest: active.digest, version: active.version };
    }
  } catch {
    // No state, or one we cannot read: hash the tree and carry on.
  }
  const { treeDigest } = await import("./red-skills-set.ts");
  return { digest: treeDigest(source), version: versionOf(source) };
}

function samePath(left: string, right: string): boolean {
  const clean = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return clean(left) === clean(right);
}

// ----------------------------------------------------------------- the walk

/**
 * Reconcile every host whose observed state is not the one the set implies.
 *
 * Answers one outcome per host in table order, including the hosts it left
 * alone — "absent", "already current", "blocked" and "failed" are four
 * different facts and a caller that wants to report them has to be able to
 * tell them apart.
 *
 * With no set at all there is nothing to reconcile against, and that is not
 * a failure: it is the ordinary state of a machine before the mise entry
 * has installed the core. It answers with no outcomes at all.
 */
export async function reconcileSkillHosts(
  p: Platform,
  opts: HostReconcileOptions = {},
): Promise<HostOutcome[]> {
  const home = opts.home ?? homeOf();
  const adapters = opts.adapters ?? HOST_ADAPTERS;

  const source = opts.source !== undefined ? opts.source : await currentSource();
  if (source === null) {
    log.skip("red-skills: not installed, no host to reconcile");
    return [];
  }

  const identity = opts.setDigest !== undefined && opts.setVersion !== undefined
    ? { digest: opts.setDigest, version: opts.setVersion }
    : await setIdentity(home, source);
  const plugins = opts.plugins ?? activatedPlugins(await declaredPlugins(p, opts.tools));
  const present = opts.present ?? (await presenceProbe());
  const running = opts.running ?? runningProbe;
  const run = opts.run ?? (await defaultRunner());
  const now = opts.now ?? (() => new Date().toISOString());

  const ctx: AdapterContext = {
    plugins,
    source,
    setDigest: opts.setDigest ?? identity.digest,
    setVersion: opts.setVersion ?? identity.version,
    current: opts.current ?? redSkillsCurrentPosix(home),
    home,
    config: opts.config ?? configOf(home),
    os: opts.os ?? platformOs(),
  };

  const registry = readHostRegistry(home);
  const out: HostOutcome[] = [];

  for (const adapter of adapters) {
    if (!present(adapter.cmd)) {
      // Deliberately not recorded: a host that arrives next week has to be
      // reconciled then, and recording it now would say it already was.
      out.push({ host: adapter.name, status: "absent", reason: `${adapter.cmd} is not installed` });
      continue;
    }

    const desired = adapter.plan(ctx);
    if (desired.blocked !== undefined) {
      log.warn(`${adapter.name}: ${desired.blocked}`);
      out.push({
        host: adapter.name,
        status: "blocked",
        mode: desired.mode,
        reason: desired.blocked,
        ...(desired.permanent === true ? { permanent: true } : {}),
      });
      continue;
    }

    const recorded = registry.hosts[adapter.name];
    if (recorded && (await isCurrent(recorded, ctx, desired, adapter))) {
      log.skip(`${adapter.name}: red-skills already at ${ctx.setVersion}`);
      out.push({
        host: adapter.name,
        status: "current",
        mode: recorded.mode,
        reason: `already reconciled at ${ctx.setVersion}`,
        reload: recorded.reload,
        missing: missingCapabilities(recorded.capabilities),
      });
      continue;
    }

    log.step(`${adapter.name}: reconciling red-skills against ${ctx.setVersion}`);
    const applied = await applyPlan(desired, run);
    if (applied.failure !== null) {
      // Reported and survived. The record keeps whatever it held, so the
      // next converge asks this host again.
      log.warn(`${adapter.name}: ${applied.failure}`);
      out.push({ host: adapter.name, status: "failed", mode: desired.mode, reason: applied.failure });
      continue;
    }

    const verified = await verifyPlan(adapter, ctx, desired, applied.owned);
    if (!verified.ok) {
      log.warn(`${adapter.name}: ${verified.reason}`);
      out.push({ host: adapter.name, status: "failed", mode: desired.mode, reason: verified.reason });
      continue;
    }

    // Never a signal, never a kill: a session that is up keeps its
    // process and is told, in the record and in doctor, that what is on
    // disk under it is newer than what it loaded.
    const reload: ReloadState = running(adapter.cmd) ? "restart-needed" : "current";
    registry.hosts[adapter.name] = {
      setDigest: ctx.setDigest,
      setVersion: ctx.setVersion,
      mode: desired.mode,
      plugins: [...plugins],
      capabilities: desired.capabilities,
      stateDigest: verified.stateDigest,
      reload,
      owned: verified.owned,
      verifiedAt: now(),
    };
    await writeHostRegistry(home, registry);
    log.ok(`${adapter.name}: red-skills reconciled to ${ctx.setVersion}`);
    out.push({
      host: adapter.name,
      status: "reconciled",
      mode: desired.mode,
      reload,
      missing: missingCapabilities(desired.capabilities),
    });
  }

  return out;
}

/**
 * Whether a recorded host still has what the record says it has.
 *
 * Four questions, and any one of them answering no is a reconciliation. The
 * set's digest, so an in-place edit to a checkout is caught where a path
 * never moves. The activation set and the mode, so opting a plugin in or a
 * generator arriving in the tree both take effect. And the observed digest
 * of the owned state itself, which is the one the stamp could never ask:
 * a cleared cache, a deleted generated directory or a config a second tool
 * rewrote all show up here and nowhere else.
 */
async function isCurrent(
  record: HostRecord,
  ctx: AdapterContext,
  desired: HostPlan,
  adapter: HostAdapter,
): Promise<boolean> {
  if (record.setDigest !== ctx.setDigest) return false;
  if (record.mode !== desired.mode) return false;
  if (record.plugins.join("\0") !== ctx.plugins.join("\0")) return false;

  const witness = adapter.check ? await adapter.check(ctx, desired) : ({ ok: true, witness: "" } as HostCheck);
  if (!witness.ok) return false;
  return (await stateDigestOf(record.owned, witness.witness)) === record.stateDigest;
}

/**
 * Run one host's plan, and find out what a generator inside it wrote.
 *
 * The commands, files, copies and fields are src/owned-state.ts's job.
 * What is left here is the half only a host has: a generator records the
 * paths it created in its own manifest, and reading that back is how
 * removal takes those paths and not a guess made in this repo.
 */
async function applyPlan(desired: HostPlan, run: (cmd: string[]) => Promise<number>): Promise<Applied> {
  const applied = await applyOwned(desired, run);
  if (applied.failure !== null) return applied;

  const owned = [...applied.owned];
  for (const manifest of desired.manifests) {
    if (!existsSync(manifest)) continue;
    owned.push({ kind: "path", path: manifest });
    for (const path of hostManifestPaths(manifest)) owned.push({ kind: "path", path });
  }
  return { failure: null, owned: dedupeOwned(owned) };
}

/**
 * Every path a generator recorded — and only the paths.
 *
 * The manifests describe themselves at the top:
 *
 *     # RedSkills OpenCode install manifest
 *     # One absolute path per line. Used by ... --uninstall.
 *     /home/me/.config/opencode/plugins/redskills-dev-pre-tool-use.ts
 *
 * Every non-empty line used to be taken as a path, so those two comments
 * were recorded as owned files, `missingOwned` then found nothing at
 * `# RedSkills OpenCode install manifest`, and the verification failed
 * with that sentence followed by "was not written". Which read like the
 * generator had not run — it had, perfectly, every single time.
 *
 * The cost was not cosmetic: opencode and redcode could never verify,
 * on any machine, ever. `red-dev update` therefore always ended
 * "partial", the CLIs were never recorded as holding the new revision,
 * and the Spec #185 adoption — which refuses to remove anything until
 * every surface verifies — was held permanently on every workstation.
 *
 * Comments are skipped, and so is anything that is not an absolute path
 * on this platform: the header says absolute, and a line that is not one
 * is documentation rather than something red-dev owns and will later
 * remove. Read strictly, because the failure mode of reading it loosely
 * is a machine that can never converge.
 */
export function hostManifestPaths(manifest: string): string[] {
  try {
    return readFileSync(manifest, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && isAbsolute(line));
  } catch {
    return [];
  }
}


interface Verified {
  ok: boolean;
  reason?: string;
  stateDigest: string;
  owned: OwnedEntry[];
}

/**
 * Read the result back, and refuse to record anything less than all of it.
 *
 * A generator that recorded no manifest is unverifiable rather than done —
 * there is no list of what it wrote, so there is nothing to observe now and
 * nothing to remove later, and a record claiming otherwise would be the
 * stamp again under a longer name.
 */
async function verifyPlan(
  adapter: HostAdapter,
  ctx: AdapterContext,
  desired: HostPlan,
  owned: readonly OwnedEntry[],
): Promise<Verified> {
  const empty = { ok: false, stateDigest: "", owned: [...owned] };

  if (desired.manifests.length > 0 && !desired.manifests.some((m) => existsSync(m))) {
    return { ...empty, reason: "the generator recorded no install manifest" };
  }

  const check = adapter.check ? await adapter.check(ctx, desired) : ({ ok: true, witness: "" } as HostCheck);
  if (!check.ok) return { ...empty, reason: check.reason };

  const missing = missingOwned(owned);
  if (missing !== null) return { ...empty, reason: missing };

  return {
    ok: true,
    stateDigest: await stateDigestOf(owned, check.witness),
    owned: [...owned],
  };
}

// -------------------------------------------------------------- the removal

/** What one host did on the way out, or the reason it did nothing. */
export interface HostRemoveOutcome {
  /** The host's name in HOST_ADAPTERS. */
  host: string;
  /** True only when every recorded piece of state is gone. */
  removed: boolean;
  /** Why not, present exactly when `removed` is false. */
  reason?: string;
  /** What was taken out, as owned keys, for a caller that wants to say. */
  took?: string[];
}

/**
 * Take RedSkills back out of every host, using the record as the manifest.
 *
 * The record is what makes this defensible. A host's config directory holds
 * files nobody here put there, and the only list of what red-dev added is
 * the one it wrote when it added them — so removal is that list, replayed,
 * and never a guess about which paths under `~/.gemini` look like ours.
 *
 * The host's own commands run first where the package set is still on the
 * machine, because a generator's `--uninstall` and a CLI's `marketplace
 * remove` know things about their own stores that no path list does. But
 * they are not required: a set that has already been pruned leaves the
 * record standing, and everything red-dev owns still comes out.
 */
export async function removeSkillHosts(
  p: Platform,
  opts: HostReconcileOptions = {},
): Promise<HostRemoveOutcome[]> {
  const home = opts.home ?? homeOf();
  const adapters = opts.adapters ?? HOST_ADAPTERS;
  const source = opts.source !== undefined ? opts.source : await currentSource();
  const plugins = opts.plugins ?? activatedPlugins(await declaredPlugins(p, opts.tools));
  const present = opts.present ?? (await presenceProbe());
  const run = opts.run ?? (await defaultRunner());

  const registry = readHostRegistry(home);
  const out: HostRemoveOutcome[] = [];

  for (const adapter of adapters) {
    const record = registry.hosts[adapter.name];
    if (!record) {
      out.push({ host: adapter.name, removed: false, reason: "nothing was recorded for it" });
      continue;
    }

    log.step(`${adapter.name}: removing red-skills`);
    if (source !== null && present(adapter.cmd)) {
      const ctx: AdapterContext = {
        plugins,
        source,
        setDigest: record.setDigest,
        setVersion: record.setVersion,
        current: opts.current ?? redSkillsCurrentPosix(home),
        home,
        config: opts.config ?? configOf(home),
        os: opts.os ?? platformOs(),
      };
      const failure = await runSteps(adapter.remove(ctx), run);
      if (failure !== null) {
        log.warn(`${adapter.name}: ${failure}`);
        out.push({ host: adapter.name, removed: false, reason: failure });
        continue;
      }
    }

    const took = removeOwned(record.owned);
    delete registry.hosts[adapter.name];
    await writeHostRegistry(home, registry);
    log.ok(`${adapter.name}: red-skills removed`);
    out.push({ host: adapter.name, removed: true, took });
  }

  return out;
}

/**
 * Remove exactly what a record names, deepest first.
 *
 * Fields before their parents, and a parent only while nothing else is left
 * in it — which is `onlyWhenEmpty`, and the only version of "take the block
 * we made" with a safe answer. `host` entries name state inside an
 * application's own store; the commands above are what removes those, and
 * listing them here is how a caller can say what was asked for.
 */
function removeOwned(owned: readonly OwnedEntry[]): string[] {
  const took: string[] = [];
  const fields = owned.filter((e) => e.kind === "field");
  const ordered = [
    ...owned.filter((e) => e.kind === "path"),
    ...fields.filter((e) => e.onlyWhenEmpty !== true),
    ...fields.filter((e) => e.onlyWhenEmpty === true),
  ];

  for (const entry of ordered) {
    if (entry.kind === "path") {
      if (!existsSync(entry.path)) continue;
      rmSync(entry.path, { recursive: true, force: true });
      took.push(ownedKey(entry));
      continue;
    }
    if (!existsSync(entry.file)) continue;
    const before = readFileSync(entry.file, "utf8");
    const after = dropOwnedField(before, entry.pointer, { onlyWhenEmpty: entry.onlyWhenEmpty === true });
    if (after === before) continue;
    mkdirSync(dirname(entry.file), { recursive: true });
    writeFileSync(entry.file, after);
    took.push(ownedKey(entry));
  }

  for (const entry of owned) if (entry.kind === "host") took.push(ownedKey(entry));
  return took;
}

// ---------------------------------------------------------------- the report

/** What doctor says about one host, as data. */
export interface HostDoctorRow {
  host: string;
  mode: AdapterMode;
  /** The package set it was reconciled against. */
  setDigest: string;
  setVersion: string;
  /** The state that reconciliation owns, as observed when it verified. */
  stateDigest: string;
  plugins: string[];
  /** What the set carried and what this host got of it. */
  capabilities: HostCapability[];
  reload: ReloadState;
  verifiedAt: string;
}

export interface HostDoctorReport {
  hosts: HostDoctorRow[];
  /** Adapters with no record at all, in table order. */
  unrecorded: string[];
}

/**
 * What the registry says, as JSON rather than as lines.
 *
 * The facts a person needs when two machines disagree — which set each host
 * observed, through which mechanism, over what state, and whether anything
 * still has to be restarted — are also the facts a script needs, and
 * rendering them twice is how the two answers start to differ.
 */
export function redSkillsHostReport(
  home: string,
  adapters: readonly HostAdapter[] = HOST_ADAPTERS,
): HostDoctorReport {
  const registry = readHostRegistry(home);
  const hosts: HostDoctorRow[] = [];
  const unrecorded: string[] = [];
  for (const adapter of adapters) {
    const record = registry.hosts[adapter.name];
    if (!record) {
      unrecorded.push(adapter.name);
      continue;
    }
    hosts.push({
      host: adapter.name,
      mode: record.mode,
      setDigest: record.setDigest,
      setVersion: record.setVersion,
      stateDigest: record.stateDigest,
      plugins: record.plugins,
      capabilities: record.capabilities ?? [],
      reload: record.reload,
      verifiedAt: record.verifiedAt,
    });
  }
  return { hosts, unrecorded };
}

export interface HostDoctorLine {
  status: "ok" | "warn" | "n/a";
  detail: string;
}

/** The report as the lines doctor prints. */
export function redSkillsHostRows(report: HostDoctorReport): HostDoctorLine[] {
  const rows: HostDoctorLine[] = report.hosts.map((row) => {
    // Said on the same line as the digests, because "converged" and "has
    // less than its neighbour" are both true of this host at once and
    // reading one without the other is how a machine is misdescribed.
    const missing = missingCapabilities(row.capabilities);
    return {
      status: row.reload === "restart-needed" ? "warn" : "ok",
      detail:
        `${row.host} (${row.mode}) — ${row.setVersion} ${row.setDigest.slice(0, 12)}, ` +
        `state ${row.stateDigest.slice(0, 12)}, ${row.plugins.join(", ") || "no plugin"} activated` +
        (missing.length > 0 ? ` — ${missing.join("; ")}` : "") +
        (row.reload === "restart-needed" ? " — restart needed to load it" : ""),
    };
  });
  if (report.unrecorded.length > 0) {
    rows.push({
      status: "n/a",
      detail: `no observed record yet: ${report.unrecorded.join(", ")}`,
    });
  }
  return rows;
}

// ------------------------------------------------------------- the defaults

async function currentSource(): Promise<string | null> {
  const { resolvedSource } = await import("./red-skills-ext.ts");
  return resolvedSource();
}

async function declaredPlugins(p: Platform, tools?: readonly Tool[]): Promise<string[]> {
  const { redSkillsPluginNames } = await import("./red-skills-plugins.ts");
  return redSkillsPluginNames(p, tools);
}

async function presenceProbe(): Promise<(cmd: string) => boolean> {
  const { commandPath } = await import("./agents.ts");
  return (cmd: string) => commandPath(cmd) !== null;
}

async function defaultRunner(): Promise<(cmd: string[]) => Promise<number>> {
  const { spawnLogged } = await import("./providers.ts");
  return (cmd: string[]) => spawnLogged(cmd);
}

/**
 * Is a session of this host up right now?
 *
 * Only ever used to say "restart needed" — nothing here signals or waits
 * for anything, because plugin freshness does not justify interrupting
 * somebody's work. A probe that cannot run answers no, which reports one
 * fewer restart than the machine needs rather than inventing one it does
 * not.
 */
function runningProbe(cmd: string): boolean {
  try {
    const probe = Bun.spawnSync(["pgrep", "-x", cmd], { stdout: "ignore", stderr: "ignore" });
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}
