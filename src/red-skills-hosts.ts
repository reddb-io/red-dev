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
 * Everything red-dev owns is written into the record as an ownership
 * manifest, and removal is that manifest read back. That is the whole of
 * the uninstall contract: a config directory holds files nobody here put
 * there, and the only defensible answer to "what did we leave behind" is a
 * list written at the time rather than a guess made afterwards.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { sha256Hex } from "./checksum.ts";
import { log } from "./log.ts";
import { dropOwnedField, readOwnedField, setOwnedField } from "./owned-config.ts";
import type { Platform } from "./platform.ts";
import type { Tool } from "./manifest.ts";
import { activatedPlugins } from "./red-skills-plugins.ts";

/**
 * One command in a host's reconciliation.
 *
 * `optional` is what `try_run … || true` is in the shared installer, and
 * it is load-bearing rather than decorative: removing a plugin that was
 * never installed exits non-zero, and treating that as a failed host would
 * leave a machine permanently unrecorded and permanently rewalked.
 */
export interface HostStep {
  /** The command, as argv. */
  argv: string[];
  /** A non-zero exit here is reported, and the host carries on. */
  optional?: boolean;
}

/** A command whose failure fails the host. */
function must(...argv: string[]): HostStep {
  return { argv };
}

/** A command whose failure is reported and stepped over. */
function may(...argv: string[]): HostStep {
  return { argv, optional: true };
}

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

/** What every adapter is a function of. */
export interface AdapterContext {
  /** The plugins to activate — `dev` alone. */
  plugins: readonly string[];
  /** The resolved package set: `~/.red-skills/current`, followed. */
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
}

/**
 * One piece of state a reconciliation owns.
 *
 * Three kinds, because there are three ways to be responsible for
 * something. A `path` is a file or directory red-dev created, and removing
 * it is removing it. A `field` is one entry inside a file the user owns,
 * and removing it must leave the rest of that file byte for byte. A `host`
 * entry is state inside an application's own store — a marketplace
 * registration in Codex's TOML — which only that application's CLI can
 * take out, and which red-dev records so it can say what it asked for.
 */
export type OwnedEntry =
  | { kind: "path"; path: string }
  | { kind: "field"; file: string; pointer: string[]; onlyWhenEmpty?: boolean }
  | { kind: "host"; what: string };

/** A file red-dev writes in full. */
export interface OwnedWrite {
  path: string;
  bytes: string;
}

/** A directory red-dev copies out of the package set in full. */
export interface OwnedCopy {
  from: string;
  to: string;
}

/** One field red-dev owns inside a file the user owns. */
export interface OwnedMerge {
  file: string;
  pointer: string[];
  value: unknown;
}

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
}

/** A plan with every empty part spelled out once, here instead of seven times. */
function plan(partial: Partial<HostPlan> & { mode: AdapterMode }): HostPlan {
  return {
    steps: [],
    writes: [],
    copies: [],
    merges: [],
    expect: [],
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
  check?: (ctx: AdapterContext) => Promise<HostCheck>;
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
    for (const name of listing(root)) {
      const file = join(root, name, "SKILL.md");
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      out.push({
        name: frontMatter(text, "name") ?? name,
        description: frontMatter(text, "description") ?? "",
        path: join(root, name),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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
    const file = join(pluginDir(ctx, plugin), ".mcp.json");
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const servers = (parsed["mcpServers"] ?? parsed) as Record<string, unknown>;
      if (servers === null || typeof servers !== "object" || Array.isArray(servers)) continue;
      for (const [name, value] of Object.entries(servers)) out[`${MARKETPLACE}-${name}`] = value;
    } catch {
      // A payload we cannot read is a payload we do not project. The host
      // is reported as unconverged rather than given half a config.
      log.warn(`red-skills: ${file} is not JSON — no MCP projected from it`);
    }
  }
  return out;
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

    const dir = join(ctx.home, ".gemini", "extensions", MARKETPLACE);
    const mcp = declaredMcp(ctx);
    const settings = join(ctx.home, ".gemini", "settings.json");
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
        { path: join(dir, "REDSKILLS.md"), bytes: contextFile(ctx, skills) },
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
    });
  },
  remove: (ctx) => {
    const script = generator(ctx.source, "install-gemini.sh");
    return existsSync(script) ? [must(script, "--uninstall", "--user")] : [];
  },
};

/**
 * Hermes, which has skills and nothing else.
 *
 * The skills-only fallback Spec #201 names: no marketplace, no extension
 * manifest, no MCP surface to project into, so the adapter writes the
 * activated plugin's skills into a directory of its own under the host's
 * skills path and stops there. Less than the other six get, and saying so
 * in the record is the point — a mode of `skills` is how doctor reports a
 * host that is genuinely converged and genuinely has less.
 */
const hermes: HostAdapter = {
  name: "hermes",
  cmd: "hermes",
  plan: (ctx) => {
    const script = generator(ctx.source, "install-hermes.sh");
    if (existsSync(script)) {
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
    const dir = join(ctx.home, ".hermes", "skills", MARKETPLACE);
    return plan({
      mode: "skills",
      copies: skills.map((skill) => ({ from: skill.path, to: join(dir, skill.name) })),
      expect: [{ kind: "path", path: dir }],
    });
  },
  remove: (ctx) => {
    const script = generator(ctx.source, "install-hermes.sh");
    return existsSync(script) ? [must(script, "--uninstall", "--user")] : [];
  },
};

/** What Gemini reads when it loads the extension: the set, as one page. */
function contextFile(ctx: AdapterContext, skills: readonly SetSkill[]): string {
  const lines = [
    `# RedSkills ${ctx.setVersion}`,
    "",
    `Projected by red-dev from ${ctx.current}. Do not edit: this file is`,
    "rewritten whenever the package set moves.",
    "",
    ...skills.map((skill) =>
      skill.description ? `- **${skill.name}** — ${skill.description}` : `- **${skill.name}**`
    ),
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

/** A stable key for one owned entry, so two records can be compared. */
function ownedKey(entry: OwnedEntry): string {
  if (entry.kind === "path") return `path:${entry.path}`;
  if (entry.kind === "field") return `field:${entry.file}#${entry.pointer.join(".")}`;
  return `host:${entry.what}`;
}

function dedupe(entries: readonly OwnedEntry[]): OwnedEntry[] {
  const seen = new Map<string, OwnedEntry>();
  for (const entry of entries) if (!seen.has(ownedKey(entry))) seen.set(ownedKey(entry), entry);
  return [...seen.values()];
}

function listing(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** The digest of one owned entry as it exists now, or `absent`. */
async function observe(entry: OwnedEntry, witness: string): Promise<string> {
  if (entry.kind === "host") return sha256Hex(`${entry.what}\0${witness}`);
  if (entry.kind === "field") {
    if (!existsSync(entry.file)) return "absent";
    const value = readOwnedField(readFileSync(entry.file, "utf8"), entry.pointer);
    return value === undefined ? "absent" : sha256Hex(JSON.stringify(value));
  }
  if (!existsSync(entry.path)) return "absent";
  const stat = statSync(entry.path);
  if (stat.isDirectory()) {
    const { treeDigest } = await import("./red-skills-set.ts");
    return treeDigest(entry.path);
  }
  return sha256Hex(readFileSync(entry.path));
}

/**
 * The digest of everything this host's reconciliation is responsible for.
 *
 * Sorted by owned key, so the same state hashes the same however the plan
 * happened to order it, and every absence is part of the digest rather than
 * invisible to it: a generated directory somebody deleted has to move this
 * number, or the next converge would skip the host that no longer has it.
 */
async function stateDigestOf(entries: readonly OwnedEntry[], witness: string): Promise<string> {
  const lines: string[] = [];
  for (const entry of entries) lines.push(`${ownedKey(entry)}\0${await observe(entry, witness)}`);
  lines.sort();
  return sha256Hex(`${lines.join("\n")}\n`);
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
}

/** Whether every required host converged. */
export function reconciliationFailed(outcomes: readonly HostOutcome[]): boolean {
  return outcomes.some((o) => o.status === "blocked" || o.status === "failed");
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
  /** The resolved package set. Defaults to `resolvedSource()`. */
  source?: string | null;
  /** The pointer the marketplace hosts register. Defaults to `~/.red-skills/current`. */
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
    current: opts.current ?? `${home}/.red-skills/current`,
    home,
    config: opts.config ?? configOf(home),
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
      out.push({ host: adapter.name, status: "blocked", mode: desired.mode, reason: desired.blocked });
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
      stateDigest: verified.stateDigest,
      reload,
      owned: verified.owned,
      verifiedAt: now(),
    };
    await writeHostRegistry(home, registry);
    log.ok(`${adapter.name}: red-skills reconciled to ${ctx.setVersion}`);
    out.push({ host: adapter.name, status: "reconciled", mode: desired.mode, reload });
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

  const witness = adapter.check ? await adapter.check(ctx) : ({ ok: true, witness: "" } as HostCheck);
  if (!witness.ok) return false;
  return (await stateDigestOf(record.owned, witness.witness)) === record.stateDigest;
}

interface Applied {
  /** The first hard failure, or null. */
  failure: string | null;
  /** What the plan turned out to own, discovered as it ran. */
  owned: OwnedEntry[];
}

/** Run one host's plan: its commands, its files, then its owned fields. */
async function applyPlan(desired: HostPlan, run: (cmd: string[]) => Promise<number>): Promise<Applied> {
  const owned: OwnedEntry[] = [];

  const failure = await runSteps(desired.steps, run);
  if (failure !== null) return { failure, owned };

  try {
    for (const write of desired.writes) {
      mkdirSync(dirname(write.path), { recursive: true });
      // Compare-then-write: a converge that rewrites an unchanged file is
      // a converge claiming work, and its mtime is a lie told to whoever
      // reads it next.
      if (!existsSync(write.path) || readFileSync(write.path, "utf8") !== write.bytes) {
        await Bun.write(write.path, write.bytes);
      }
      owned.push({ kind: "path", path: write.path });
    }

    for (const copy of desired.copies) {
      rmSync(copy.to, { recursive: true, force: true });
      mkdirSync(dirname(copy.to), { recursive: true });
      cpSync(copy.from, copy.to, { recursive: true });
      owned.push({ kind: "path", path: copy.to });
    }

    for (const merge of desired.merges) {
      owned.push(...(await applyMerge(merge)));
    }
  } catch (error) {
    return { failure: `${(error as Error).message}`, owned };
  }

  owned.push(...desired.expect);
  for (const manifest of desired.manifests) {
    if (!existsSync(manifest)) continue;
    owned.push({ kind: "path", path: manifest });
    for (const path of manifestPaths(manifest)) owned.push({ kind: "path", path });
  }

  return { failure: null, owned: dedupe(owned) };
}

/**
 * Splice one field into a file the user owns, and record what that cost.
 *
 * The parent object is recorded too, and only when this call had to create
 * it: removing `mcpServers` because our entry was all it ever held is
 * right, and removing it out from under a server the operator added later
 * is the exact failure the ownership manifest exists to prevent.
 */
async function applyMerge(merge: OwnedMerge): Promise<OwnedEntry[]> {
  const before = existsSync(merge.file) ? readFileSync(merge.file, "utf8") : "";
  const parent = merge.pointer.slice(0, -1);
  const madeParent = parent.length > 0 && readOwnedField(before, parent) === undefined;
  const after = setOwnedField(before, merge.pointer, merge.value);
  if (after !== before) {
    mkdirSync(dirname(merge.file), { recursive: true });
    await Bun.write(merge.file, after);
  }
  const entries: OwnedEntry[] = [{ kind: "field", file: merge.file, pointer: [...merge.pointer] }];
  if (madeParent) entries.push({ kind: "field", file: merge.file, pointer: parent, onlyWhenEmpty: true });
  return entries;
}

/** Every path a generator recorded, one per line, blank lines ignored. */
function manifestPaths(manifest: string): string[] {
  try {
    return readFileSync(manifest, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
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

  const check = adapter.check ? await adapter.check(ctx) : ({ ok: true, witness: "" } as HostCheck);
  if (!check.ok) return { ...empty, reason: check.reason };

  for (const entry of owned) {
    if (entry.kind === "path" && !existsSync(entry.path)) {
      return { ...empty, reason: `${entry.path} was not written` };
    }
    if (entry.kind === "field") {
      const text = existsSync(entry.file) ? readFileSync(entry.file, "utf8") : "";
      if (readOwnedField(text, entry.pointer) === undefined) {
        return { ...empty, reason: `${entry.file} has no ${entry.pointer.join(".")}` };
      }
    }
  }

  return {
    ok: true,
    stateDigest: await stateDigestOf(owned, check.witness),
    owned: [...owned],
  };
}

/** Runs one host's commands, and answers the first hard failure or null. */
async function runSteps(
  steps: readonly HostStep[],
  run: (cmd: string[]) => Promise<number>,
): Promise<string | null> {
  for (const step of steps) {
    const what = step.argv.join(" ");
    let code: number;
    try {
      code = await run(step.argv);
    } catch (error) {
      if (step.optional) {
        log.warn(`${what} could not be run: ${(error as Error).message}`);
        continue;
      }
      return `${what} could not be run: ${(error as Error).message}`;
    }
    if (code === 0) continue;
    if (step.optional) {
      log.skip(`${what} exited ${code}, which this step is allowed to do`);
      continue;
    }
    return `${what} exited ${code}`;
  }
  return null;
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
        current: opts.current ?? `${home}/.red-skills/current`,
        home,
        config: opts.config ?? configOf(home),
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
  const rows: HostDoctorLine[] = report.hosts.map((row) => ({
    status: row.reload === "restart-needed" ? "warn" : "ok",
    detail:
      `${row.host} (${row.mode}) — ${row.setVersion} ${row.setDigest.slice(0, 12)}, ` +
      `state ${row.stateDigest.slice(0, 12)}, ${row.plugins.join(", ") || "no plugin"} activated` +
      (row.reload === "restart-needed" ? " — restart needed to load it" : ""),
  }));
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
