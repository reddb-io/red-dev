/**
 * The workstation companions, converged out of the package set itself.
 *
 * Five surfaces here are RedSkills and are not an agent host: the shared
 * runtimes on PATH, the `redskilled` daemon, the herdr plugin, the VS Code
 * extension and zellij's dashboard layout. Until now each arrived its own
 * way — the runtimes through whatever mise shimmed, the extension and the
 * plugin through a GitHub release resolved at converge time, zellij not at
 * all — which is the drift Spec #201 is a correction to: one machine could
 * hold agent hosts on set 3.19.5 and an editor extension from whatever tag
 * GitHub answered with that afternoon, and nothing on the machine could
 * say so.
 *
 * So every companion is installed from the artifact inside the selected
 * package set, and from nowhere else. Reconciliation never resolves a
 * release, never reads npm and never downloads anything: `~/.red/skills/
 * current` is followed, the artifact is found inside it or it is not, and
 * a set that does not carry one yet is reported `unavailable` rather than
 * fetched from somewhere the digest cannot speak for. That is what makes
 * the record meaningful — a companion's row names the set digest it came
 * from *and* the version of the artifact itself, and those two facts
 * together are the thing an operator comparing two machines needs.
 *
 * ## The one thing that is not in the set
 *
 * A `.vsix` needs an editor to install it into, and Spec #201 promises a
 * clean workstation gets one. So the extension adapter is the single
 * place here allowed to reach a package manager, and only when the
 * machine carries no compatible editor at all: VS Code is installed, once,
 * and every compatible editor already present — VSCodium, Cursor — then
 * receives the same revision out of the same set. Nothing about the
 * extension itself is ever fetched.
 *
 * ## What a failure costs, and what it must not
 *
 * A companion that cannot be installed fails the reconciliation and
 * writes no record, exactly as a host does. What it must never do is take
 * the working artifact with it: nothing here removes the previous
 * revision, and pruning runs after the walk and keeps everything the
 * active and previous sets still need. An operator whose new extension
 * refused to install keeps the one they had, plus a line saying why.
 *
 * ## Configuration the operator wrote is not ours
 *
 * herdr's config.toml and zellij's config.kdl both hold keys people chose
 * themselves. Neither is rewritten: herdr gets one block delimited by a
 * header red-dev wrote (src/owned-state.ts), and zellij gets a fragment
 * composed between red-dev's base and the operator's own `config.user.kdl`
 * — which still wins over both, because it is the one file on this machine
 * red-dev never writes twice.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { log } from "./log.ts";
import { redSkillsCurrentPosix } from "./red-skills-root.ts";
import {
  applyOwned,
  may,
  missingOwned,
  must,
  removeBlock,
  runSteps,
  stateDigestOf,
  type OwnedBlock,
  type OwnedCopy,
  type OwnedEntry,
  type OwnedMerge,
  type OwnedWrite,
  type Step,
} from "./owned-state.ts";
import { readPackageSetState } from "./red-skills-set.ts";
import { ZELLIJ_COMPANION_FILE } from "./zellij-layer.ts";
import type { Platform } from "./platform.ts";

/** The five surfaces, and the order a converge walks them. */
export type CompanionName = "runtimes" | "redskilled" | "herdr" | "vscode" | "zellij";

/** What every companion adapter is a function of. */
export interface CompanionContext {
  platform: Platform;
  /** The resolved package set: `~/.red/skills/current`, followed. */
  source: string;
  /** That set's whole-set digest, which is what a record is keyed on. */
  setDigest: string;
  /** Its version, for a line a person reads. */
  setVersion: string;
  /** The stable pointer a launcher resolves through, so it follows the set. */
  current: string;
  home: string;
  /** `$XDG_CONFIG_HOME`, or `~/.config`. */
  config: string;
  /**
   * Where herdr and zellij actually read from, which is not always under
   * `config`: both are asked of the same resolver the rest of red-dev
   * uses, so a Windows machine with a shared root and a Linux one with
   * XDG both land where the application looks. Null for herdr on a
   * Windows account with no APPDATA, which is the one case with nowhere
   * to write.
   */
  herdrDir: string | null;
  zellijDir: string;
  /** Where user-global launchers go, ahead of mise's shims on PATH. */
  bin: string;
  /** The VS Code-family CLIs this machine has. */
  editors: readonly string[];
  /** What one editor says it carries. Only a live machine can answer it. */
  extensionsOf: (cli: string) => Promise<string[]>;
  /** Recompose zellij's config.kdl over the fragment just written. */
  compose: (p: Platform) => Promise<void>;
}

/** Everything an adapter would do, computed before anything is touched. */
export interface CompanionPlan {
  /** The version of the artifact itself, which is not the set's version. */
  version: string;
  steps: Step[];
  writes: OwnedWrite[];
  copies: OwnedCopy[];
  merges: OwnedMerge[];
  blocks: OwnedBlock[];
  /** State that must exist afterwards for this companion to count as done. */
  expect: OwnedEntry[];
  /** The set carries no artifact for this companion. Reported, not fetched. */
  unavailable?: string;
  /** This machine cannot take it. Reported, and the reconciliation fails. */
  blocked?: string;
}

/** A plan with every empty part spelled out once, here instead of five times. */
function plan(partial: Partial<CompanionPlan> & { version: string }): CompanionPlan {
  return {
    steps: [],
    writes: [],
    copies: [],
    merges: [],
    blocks: [],
    expect: [],
    ...partial,
  };
}

/** What a companion itself says about the state it holds, after the plan ran. */
export type CompanionCheck = { ok: true; witness: string } | { ok: false; reason: string };

/** One companion red-dev installs out of the package set, and how. */
export interface CompanionAdapter {
  name: CompanionName;
  /**
   * The command that has to be on PATH for this companion to have a home.
   *
   * Absent for the two that are themselves what gets installed: the
   * runtimes and the daemon are launchers red-dev writes, and waiting for
   * them to already exist would mean never writing them.
   */
  cmd?: string;
  plan: (ctx: CompanionContext) => CompanionPlan;
  /** Ground truth only the application itself can answer for. */
  check?: (ctx: CompanionContext) => Promise<CompanionCheck>;
  /**
   * Run after the plan and before verification.
   *
   * One companion needs it: zellij's config.kdl is composed rather than
   * written, so the fragment landing on disk is only half of installing
   * it. Answers a reason it could not, or null.
   */
  settle?: (ctx: CompanionContext) => Promise<string | null>;
  /** The commands that take this companion's own state back out. */
  remove: (ctx: CompanionContext, record: CompanionRecord) => Step[];
}

// ------------------------------------------------------------ the artifacts

/**
 * Where a set publishes an artifact that is not a plugin payload.
 *
 * `dist/` is what the npm core carries today — the runtime bundles are
 * there and so is the daemon's — and `companions/` is where a set that
 * groups them per surface puts them. Both are searched, in that order,
 * because the first is ground truth now and the second is where the
 * complete workstation distribution Spec #201 describes is heading.
 */
export const COMPANION_ROOTS: readonly string[] = ["dist", "companions"];

/** The first of these that exists, or null. */
function firstPath(...candidates: string[]): string | null {
  return candidates.find((path) => existsSync(path)) ?? null;
}

function listing(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** The set's own version, out of the core package.json it was composed from. */
export function setPackageVersion(source: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as {
      version?: string;
    };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** The `bin` map the core declares: launcher name to path inside the set. */
export function setBinMap(source: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };
    const bin = parsed.bin ?? {};
    const out: Record<string, string> = {};
    for (const [name, rel] of Object.entries(bin)) {
      if (typeof rel === "string" && existsSync(join(source, rel))) out[name] = rel;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The published extension inside the set, whose name carries its version.
 *
 * A glob and not a filename, for the reason the release path had before
 * it: the asset carries a version, and reconstructing it from the set's
 * own is exactly the guess that lets a machine name a file that is not
 * there. The per-surface directories are searched first, so a set that
 * groups its companions wins over one that leaves them flat in `dist/`.
 */
export function setVsix(source: string): string | null {
  const roots = [
    ...COMPANION_ROOTS.map((root) => join(source, root, "vscode")),
    ...COMPANION_ROOTS.map((root) => join(source, root)),
  ];
  for (const root of roots) {
    const file = listing(root).find((name) => /^vscode-extension-red-skills-.*\.vsix$/.test(name));
    if (file) return join(root, file);
  }
  return null;
}

/** `3.19.5` out of `vscode-extension-red-skills-3.19.5.vsix`. PURE. */
export function vsixVersion(path: string): string | null {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  return /^vscode-extension-red-skills-(.+)\.vsix$/.exec(name)?.[1] ?? null;
}

/** The herdr plugin directory inside the set: the one with a manifest in it. */
export function setHerdrPlugin(source: string): string | null {
  return firstPath(
    ...COMPANION_ROOTS.map((root) => join(source, root, "herdr")),
    join(source, "apps", "herdr-plugin-red-skills"),
    join(source, "apps", "herdr-plugin"),
  );
}

/** `version = "0.1.0"` out of a herdr plugin manifest. PURE over the file. */
export function herdrPluginVersion(dir: string): string | null {
  try {
    const toml = readFileSync(join(dir, HERDR_MANIFEST), "utf8");
    return /^\s*version\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The zellij surface inside the set: a config fragment, layouts, or both. */
export function setZellijDir(source: string): string | null {
  return firstPath(...COMPANION_ROOTS.map((root) => join(source, root, "zellij")), join(source, "zellij"));
}

// -------------------------------------------------------------- the names

/** What herdr calls the plugin, and the file that declares it one. */
export const PLUGIN_ID = "reddb-io.red-skills";
export const HERDR_MANIFEST = "herdr-plugin.toml";

/**
 * What the editors call the extension.
 *
 * Two spellings, because the app was renamed: a machine converged before
 * the rename carries `vscode-redskilled` and one converged after carries
 * `vscode-extension-red-skills`. Both count as "installed" when deciding
 * what an editor already has.
 */
export const EXTENSION_ID = "reddb-io.vscode-extension-red-skills";
export const LEGACY_EXTENSION_ID = "reddb-io.vscode-redskilled";

/** Every VS Code-family CLI, in the order a machine that has several is asked. */
export const EDITOR_CLIS: readonly string[] = ["code", "codium", "cursor"];

/** The editor a clean workstation is guaranteed, and how each target gets it. */
export const GUARANTEED_EDITOR = "code";
export const VSCODE_WINGET_ID = "Microsoft.VisualStudioCode";
export const VSCODE_APT_REPO = {
  pkgs: ["code"],
  keyUrl: "https://packages.microsoft.com/keys/microsoft.asc",
  keyring: "/etc/apt/keyrings/packages.microsoft.gpg",
  entry:
    "deb [arch=amd64,arm64,armhf signed-by=/etc/apt/keyrings/packages.microsoft.gpg] " +
    "https://packages.microsoft.com/repos/code stable main",
} as const;

/** The daemon's launchers, which the runtimes adapter leaves to the daemon's. */
const DAEMON_BINS: Record<string, string> = {
  "red-skills-redskilled": "redskilled",
  "red-skills-redskilled-mcp": "redskilled-mcp",
};

/** The bundle a daemon launcher is worth nothing without. */
const DAEMON_BUNDLE = "redskilled.bundle.min.mjs";

/** Where the set's zellij fragment lands, which zellij-layer.ts composes. */
export { ZELLIJ_COMPANION_FILE } from "./zellij-layer.ts";

// ----------------------------------------------------------- the launchers

/**
 * What a launcher on PATH is, and why it is a file rather than a link.
 *
 * The shims inside the set resolve `../dist/<bundle>.mjs` from their own
 * real path, so what has to be preserved is that they are executed *in
 * place*. A one-line launcher does that on every target: Windows needs a
 * `.cmd` because a `.mjs` is not executable there and a symlink needs a
 * privilege an ordinary account does not have, and POSIX needs the
 * executable bit, which is the whole reason OwnedWrite carries a mode.
 *
 * `current` and not the revision directory, deliberately: the pointer is
 * what moves when a set is activated, so the launchers follow it without
 * being rewritten, and a rollback moves them back with it.
 */
export function launcherFor(
  p: Platform,
  ctx: { bin: string; current: string },
  name: string,
  rel: string,
): OwnedWrite {
  if (p.os === "windows") {
    const target = `${ctx.current}/${rel}`.replace(/\//g, "\\");
    return {
      path: `${ctx.bin}/${name}.cmd`,
      bytes: `@echo off\r\nREM ${LAUNCHER_NOTE}\r\nnode "${target}" %*\r\n`,
    };
  }
  return {
    path: `${ctx.bin}/${name}`,
    bytes: `#!/usr/bin/env bash\n# ${LAUNCHER_NOTE}\nexec "${ctx.current}/${rel}" "$@"\n`,
    mode: 0o755,
  };
}

const LAUNCHER_NOTE =
  "Generated by red-dev from the RedSkills package set. Rewritten whenever the set moves.";

// ------------------------------------------------------------ the adapters

/**
 * The shared runtimes: everything the core declares a command for, minus
 * the daemon's two, which have a record of their own.
 *
 * Written by red-dev rather than left to whatever put a shim on PATH,
 * because that is the only way the runtime an operator types resolves the
 * same set the agent hosts read. A machine can carry a mise shim for the
 * npm package and a set composed from it, and before this they were two
 * different trees with one name.
 */
const runtimes: CompanionAdapter = {
  name: "runtimes",
  plan: (ctx) => {
    const version = setPackageVersion(ctx.source);
    const bins = setBinMap(ctx.source);
    const shared = Object.entries(bins).filter(([name]) => !(name in DAEMON_BINS));
    if (version === null || shared.length === 0) {
      return plan({ version: ctx.setVersion, unavailable: "the package set declares no runtime commands" });
    }
    return plan({
      version,
      writes: shared.map(([name, rel]) => launcherFor(ctx.platform, ctx, name, rel)),
    });
  },
  remove: () => [],
};

/**
 * The `redskilled` daemon.
 *
 * Its own record rather than a sixth runtime, because it is the one
 * companion with a process: an update that lands under a running daemon
 * converges on disk and says `restart needed`, and never signals it. A
 * daemon killed mid-run is somebody's autonomous work killed mid-run.
 */
const redskilled: CompanionAdapter = {
  name: "redskilled",
  plan: (ctx) => {
    const version = setPackageVersion(ctx.source);
    const bins = setBinMap(ctx.source);
    const mine = Object.entries(DAEMON_BINS).filter(([bin]) => bin in bins);
    const bundle = firstPath(...COMPANION_ROOTS.map((root) => join(ctx.source, root, DAEMON_BUNDLE)));
    if (version === null || mine.length === 0 || bundle === null) {
      return plan({ version: ctx.setVersion, unavailable: `the package set carries no ${DAEMON_BUNDLE}` });
    }
    return plan({
      version,
      writes: mine.map(([bin, name]) => launcherFor(ctx.platform, ctx, name, bins[bin] as string)),
      expect: [{ kind: "path", path: bundle }],
    });
  },
  remove: () => [],
};

/**
 * The herdr plugin, linked from inside the set.
 *
 * `herdr plugin link` and not `install`: install fetches a directory from
 * GitHub, which is the acquisition path this whole spec removes, and link
 * registers the one already on disk. The unlink before it is optional
 * because a plugin that was never linked exits non-zero, and a machine
 * being converged for the first time is exactly that case.
 *
 * The prefix+d binding comes with it. A plugin herdr gives no shortcut to
 * is one nobody opens, and the block it is written in is red-dev's alone —
 * everything else in that file is the operator's keys.
 */
const herdr: CompanionAdapter = {
  name: "herdr",
  cmd: "herdr",
  plan: (ctx) => {
    const dir = setHerdrPlugin(ctx.source);
    if (dir === null || !existsSync(join(dir, HERDR_MANIFEST))) {
      return plan({ version: ctx.setVersion, unavailable: `the package set carries no ${HERDR_MANIFEST}` });
    }
    const config = ctx.herdrDir === null ? null : join(ctx.herdrDir, "config.toml");
    return plan({
      version: herdrPluginVersion(dir) ?? ctx.setVersion,
      steps: [
        may("herdr", "plugin", "unlink", PLUGIN_ID),
        must("herdr", "plugin", "link", dir, "--enabled"),
      ],
      blocks: config === null ? [] : [herdrDashboardBinding(ctx.platform, config)],
      expect: [{ kind: "host", what: PLUGIN_ID }],
    });
  },
  check: async (ctx) => {
    const dir = setHerdrPlugin(ctx.source);
    const linked = herdrLinkedRoot(ctx);
    if (linked === null) return { ok: false, reason: `herdr does not list ${PLUGIN_ID}` };
    if (dir !== null && !samePath(linked, dir)) {
      return { ok: false, reason: `herdr links ${PLUGIN_ID} from ${linked}` };
    }
    return { ok: true, witness: linked };
  },
  remove: () => [
    { argv: ["herdr", "plugin", "unlink", PLUGIN_ID] },
    may("herdr", "server", "reload-config"),
  ],
};

/**
 * The VS Code extension, out of the set and into every compatible editor.
 *
 * Every editor found, and the same revision into each: a machine with VS
 * Code and VSCodium wants it in the one being used, and asking which is a
 * question with no good default. The editor that guarantees there is at
 * least one is installed by the walk before this plan is asked for.
 */
const vscode: CompanionAdapter = {
  name: "vscode",
  plan: (ctx) => {
    const vsix = setVsix(ctx.source);
    if (vsix === null) {
      return plan({ version: ctx.setVersion, unavailable: "the package set carries no .vsix" });
    }
    if (ctx.editors.length === 0) {
      return plan({ version: vsixVersion(vsix) ?? ctx.setVersion, blocked: "no compatible editor could be installed" });
    }
    return plan({
      version: vsixVersion(vsix) ?? ctx.setVersion,
      steps: ctx.editors.map((cli) => must(cli, "--install-extension", vsix, "--force")),
      expect: ctx.editors.map((cli) => ({ kind: "host", what: `${EXTENSION_ID} (${cli})` }) as const),
    });
  },
  check: async (ctx) => {
    const seen: string[] = [];
    for (const cli of ctx.editors) {
      const ids = await ctx.extensionsOf(cli);
      const id = ids.find((known) => known === EXTENSION_ID || known === LEGACY_EXTENSION_ID);
      if (id === undefined) return { ok: false, reason: `${cli} does not list ${EXTENSION_ID}` };
      seen.push(`${cli}:${id}`);
    }
    return { ok: true, witness: seen.sort().join(",") };
  },
  remove: (ctx, record) =>
    (record.targets ?? ctx.editors).map((cli) => ({
      argv: [cli, "--uninstall-extension", EXTENSION_ID],
    })),
};

/**
 * zellij's dashboard: the layouts the set carries, and the keys that open
 * them.
 *
 * The layouts are written file by file rather than as a directory copy,
 * and that is the whole difference between installing them and taking
 * somebody's layout collection with them — `~/.config/zellij/layouts` is a
 * directory the operator also puts files in.
 *
 * The config half is a fragment, not a write: zellij has no include
 * mechanism, so red-dev composes config.kdl from its own base, this
 * fragment and the operator's `config.user.kdl`, in that order. The
 * operator's file is last and therefore wins over both — see .red/adr/0007.
 */
const zellij: CompanionAdapter = {
  name: "zellij",
  cmd: "zellij",
  plan: (ctx) => {
    const dir = setZellijDir(ctx.source);
    if (dir === null) {
      return plan({ version: ctx.setVersion, unavailable: "the package set carries no zellij surface" });
    }
    const writes: OwnedWrite[] = [];
    const fragment = join(dir, "config.kdl");
    if (existsSync(fragment)) {
      writes.push({
        path: join(ctx.zellijDir, ZELLIJ_COMPANION_FILE),
        bytes: readFileSync(fragment, "utf8"),
      });
    }
    for (const name of listing(join(dir, "layouts"))) {
      if (!name.endsWith(".kdl")) continue;
      writes.push({
        path: join(ctx.zellijDir, "layouts", name),
        bytes: readFileSync(join(dir, "layouts", name), "utf8"),
      });
    }
    if (writes.length === 0) {
      return plan({ version: ctx.setVersion, unavailable: "the package set carries no zellij layout" });
    }
    return plan({ version: ctx.setVersion, writes });
  },
  settle: async (ctx) => {
    try {
      await ctx.compose(ctx.platform);
      return null;
    } catch (error) {
      return `zellij config could not be composed: ${(error as Error).message}`;
    }
  },
  check: async (ctx) => {
    // Composed or the operator's own, and both are fine. What is not fine
    // is not knowing which: an operator whose config.kdl predates the
    // composition keeps it, and the witness says so rather than reporting
    // a binding that is not in the file they actually load.
    const path = join(ctx.zellijDir, "config.kdl");
    if (!existsSync(path)) return { ok: true, witness: "no zellij config yet" };
    const { isComposedZellijConfig } = await import("./zellij-layer.ts");
    const text = readFileSync(path, "utf8");
    return { ok: true, witness: isComposedZellijConfig(text) ? "composed" : "operator-owned" };
  },
  remove: () => [],
};

/**
 * Where a runtime launcher lives, and why it is not `~/.local/bin`.
 *
 * config/bash/path.sh puts mise's shims ahead of `~/.local/bin`, so a
 * launcher written there would lose to the shim mise made for the same
 * npm package — and the whole point of writing one is that the runtime an
 * operator types resolves the package set their agent hosts read. This
 * directory is red-dev's outright and is prepended ahead of both, which
 * also means nothing here can ever overwrite a file somebody else put on
 * PATH.
 */
export function runtimeBinDir(home: string): string {
  return `${home.replace(/\\/g, "/")}/.local/share/red-dev/red-skills/bin`;
}

/** The five, in the order a converge walks them. */
export const COMPANION_ADAPTERS: readonly CompanionAdapter[] = [
  runtimes,
  redskilled,
  herdr,
  vscode,
  zellij,
];

// ------------------------------------------------------------- herdr state

/** The one block red-dev owns in herdr's config, as this plan would write it. */
function herdrDashboardBinding(p: Platform, file: string): OwnedBlock {
  const action = p.os === "windows" ? "toggle-dashboard-windows" : "toggle-dashboard";
  const marker = "# Generated by red-dev. Delete or rebind this block to change it.";
  return {
    file,
    marker,
    bytes: `${marker}
[[keys.command]]
key = "prefix+d"
type = "shell"
command = "herdr plugin action invoke ${action} --plugin ${PLUGIN_ID}"
`,
    guard: /^\s*key\s*=\s*"prefix\+d"/m,
  };
}

/** Where herdr says it linked the plugin from, or null when it has not. */
function herdrLinkedRoot(ctx: CompanionContext): string | null {
  if (ctx.herdrDir === null) return null;
  const path = join(ctx.herdrDir, "plugins.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      plugin_id?: string;
      plugin_root?: string;
    }[];
    const mine = parsed.find((entry) => entry.plugin_id === PLUGIN_ID);
    return typeof mine?.plugin_root === "string" ? mine.plugin_root : null;
  } catch {
    return null;
  }
}

function samePath(left: string, right: string): boolean {
  const clean = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return clean(left) === clean(right);
}

// ------------------------------------------------------------- the registry

/** What one companion was last observed to have. */
export interface CompanionRecord {
  /** The whole-set digest of the package set it was installed from. */
  setDigest: string;
  /** That set's version, for a line a person reads. */
  setVersion: string;
  /**
   * The version of the artifact itself.
   *
   * Recorded beside the set digest and not derived from it: a `.vsix` and
   * a herdr plugin carry their own versions, and "which extension is on
   * this machine" is not a question the set's version answers.
   */
  version: string;
  /** The digest of the owned state, as it was on disk when verified. */
  stateDigest: string;
  /** Whether a process running at the time still has to be restarted. */
  reload: ReloadState;
  /** Everything this installation is responsible for, for removal. */
  owned: OwnedEntry[];
  /** For the extension: the editors that took it. */
  targets?: string[];
  /** When the verification that wrote this record ran. */
  verifiedAt: string;
}

/** Whether a running process has yet to see what converged underneath it. */
export type ReloadState = "current" | "restart-needed";

export interface CompanionRegistry {
  schema: 1;
  companions: Record<string, CompanionRecord>;
}

/** Computed rather than a constant: the tests move home between cases. */
export function companionRegistryPath(home: string): string {
  return `${home.replace(/\\/g, "/")}/.local/share/red-dev/red-skills-companions.json`;
}

export function readCompanionRegistry(home: string): CompanionRegistry {
  const path = companionRegistryPath(home);
  if (!existsSync(path)) return { schema: 1, companions: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CompanionRegistry>;
    if (parsed?.schema !== 1 || typeof parsed.companions !== "object" || parsed.companions === null) {
      return { schema: 1, companions: {} };
    }
    return { schema: 1, companions: parsed.companions };
  } catch {
    // A registry we cannot read means install again, which is the safe way
    // to be wrong: the cost is one extra converge, not a companion frozen
    // on an old revision with a file claiming it is current.
    return { schema: 1, companions: {} };
  }
}

async function writeCompanionRegistry(home: string, registry: CompanionRegistry): Promise<void> {
  const path = companionRegistryPath(home);
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Bun.write(path, `${JSON.stringify(registry, null, 2)}\n`);
}

// -------------------------------------------------------------- the outcome

/**
 * What happened to one companion.
 *
 * `unavailable` is the one word this vocabulary has that the hosts' does
 * not, and it earns its place: a set that does not carry a `.vsix` is not
 * a broken machine and not a failed install, it is a set published before
 * the artifact was part of it. The remedy is a newer set, so it is said
 * once and the reconciliation still succeeds.
 */
export type CompanionStatus =
  | "reconciled"
  | "current"
  | "absent"
  | "unavailable"
  | "blocked"
  | "failed";

export interface CompanionOutcome {
  companion: CompanionName;
  status: CompanionStatus;
  /** The artifact version, where one was resolved. */
  version?: string;
  /** Why, for everything that is not `reconciled`. */
  reason?: string;
  /** Present when this converge verified the companion. */
  reload?: ReloadState;
}

/** Whether every companion this machine can hold converged. */
export function companionReconciliationFailed(outcomes: readonly CompanionOutcome[]): boolean {
  return stuckCompanions(outcomes).length > 0;
}

/**
 * The companions standing between this machine and a converged one.
 *
 * Exported for the same reason `stuckHosts` is: three callers were
 * spelling this by hand, which is how the host side ended up with four
 * predicates that could disagree. One place to change if a companion
 * ever gains a block that no run can clear.
 */
export function stuckCompanions(outcomes: readonly CompanionOutcome[]): CompanionOutcome[] {
  return outcomes.filter((o) => o.status === "blocked" || o.status === "failed");
}

// ---------------------------------------------------------------- the walk

/**
 * Everything the walk needs from outside itself.
 *
 * All of it has a real default and exists for the tests: installing a
 * companion is a sequence of commands issued to applications that may not
 * be installed, against a set that may not carry the artifact, and the
 * things worth pinning are which commands ran and what was on disk after.
 */
export interface CompanionReconcileOptions {
  home?: string;
  config?: string;
  /** The resolved package set. Defaults to `resolvedSource()`. */
  source?: string | null;
  /** The pointer launchers resolve through. Defaults to `~/.red/skills/current`. */
  current?: string;
  setDigest?: string;
  setVersion?: string;
  /** Where launchers go. Defaults to red-dev's own RedSkills bin. */
  bin?: string;
  /** herdr's config directory. Defaults to `herdrConfigDir`. */
  herdrDir?: string | null;
  /** zellij's config directory. Defaults to the one dotfiles writes. */
  zellijDir?: string;
  adapters?: readonly CompanionAdapter[];
  /** Is this command on PATH? Defaults to `commandPath`. */
  present?: (cmd: string) => boolean;
  /** Is a process of it running right now? Defaults to a `pgrep` probe. */
  running?: (cmd: string) => boolean;
  /** Runs one argv and answers its exit code. Defaults to spawnLogged. */
  run?: (cmd: string[]) => Promise<number>;
  /** The VS Code-family CLIs present. Defaults to probing PATH. */
  editors?: () => string[];
  /** Installs the guaranteed editor, and answers what is present after. */
  installEditor?: (p: Platform) => Promise<string[]>;
  /** What one editor lists. Defaults to `<cli> --list-extensions`. */
  extensions?: (cli: string) => Promise<string[]>;
  /** Recomposes zellij's config. Defaults to `installZellijConfig`. */
  compose?: (p: Platform) => Promise<void>;
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

/**
 * Install every companion whose observed state is not the one the set
 * implies.
 *
 * Answers one outcome per companion in table order, including the ones it
 * left alone. With no set at all there is nothing to install from, and
 * that is not a failure: it is the ordinary state of a machine before the
 * mise entry has installed the core.
 */
export async function reconcileCompanions(
  p: Platform,
  opts: CompanionReconcileOptions = {},
): Promise<CompanionOutcome[]> {
  const home = opts.home ?? homeOf();
  const adapters = opts.adapters ?? COMPANION_ADAPTERS;

  const source = opts.source !== undefined ? opts.source : await currentSource();
  if (source === null) {
    log.skip("red-skills: not installed, no companion to converge");
    return [];
  }

  const identity =
    opts.setDigest !== undefined && opts.setVersion !== undefined
      ? { digest: opts.setDigest, version: opts.setVersion }
      : await setIdentity(home, source);
  const present = opts.present ?? (await presenceProbe());
  const running = opts.running ?? runningProbe;
  const run = opts.run ?? (await defaultRunner());
  const now = opts.now ?? (() => new Date().toISOString());
  const editorsOf = opts.editors ?? (() => EDITOR_CLIS.filter((cli) => present(cli)));

  const ctx: CompanionContext = {
    platform: p,
    source,
    setDigest: opts.setDigest ?? identity.digest,
    setVersion: opts.setVersion ?? identity.version,
    current: opts.current ?? redSkillsCurrentPosix(home),
    home,
    config: opts.config ?? configOf(home),
    herdrDir: opts.herdrDir !== undefined ? opts.herdrDir : await herdrDirOf(p),
    zellijDir: opts.zellijDir ?? (await zellijDirOf(p)),
    bin: opts.bin ?? runtimeBinDir(home),
    editors: editorsOf(),
    extensionsOf: opts.extensions ?? (await extensionProbe()),
    compose: opts.compose ?? (await composer()),
  };

  // The one guarantee that reaches a package manager, and only where it
  // has to: an extension in the set and nowhere to put it is the clean
  // workstation Spec #201 promises an editor to. Nothing about the
  // extension itself is fetched — it is already on this disk.
  if (
    adapters.some((a) => a.name === "vscode") &&
    ctx.editors.length === 0 &&
    setVsix(source) !== null
  ) {
    const installer = opts.installEditor ?? (await editorInstaller());
    ctx.editors = await installer(p);
  }

  const registry = readCompanionRegistry(home);
  const out: CompanionOutcome[] = [];

  for (const adapter of adapters) {
    if (adapter.cmd !== undefined && !present(adapter.cmd)) {
      // Deliberately not recorded: an application that arrives next week
      // has to be converged then, and recording it now would say it
      // already was.
      out.push({
        companion: adapter.name,
        status: "absent",
        reason: `${adapter.cmd} is not installed`,
      });
      continue;
    }

    const desired = adapter.plan(ctx);
    if (desired.unavailable !== undefined) {
      log.skip(`${adapter.name}: ${desired.unavailable}`);
      out.push({ companion: adapter.name, status: "unavailable", reason: desired.unavailable });
      continue;
    }
    if (desired.blocked !== undefined) {
      log.warn(`${adapter.name}: ${desired.blocked}`);
      out.push({ companion: adapter.name, status: "blocked", reason: desired.blocked });
      continue;
    }

    const recorded = registry.companions[adapter.name];
    if (recorded && (await isCurrent(recorded, ctx, desired, adapter))) {
      log.skip(`${adapter.name}: red-skills ${desired.version} already installed`);
      out.push({
        companion: adapter.name,
        status: "current",
        version: recorded.version,
        reason: `already installed at ${recorded.version}`,
        reload: recorded.reload,
      });
      continue;
    }

    log.step(`${adapter.name}: installing red-skills ${desired.version} from ${ctx.setVersion}`);
    const applied = await applyOwned(desired, run);
    if (applied.failure !== null) {
      // Reported and survived, and nothing was taken away: the record
      // keeps whatever it held, the artifact this machine was using is
      // where it was, and the next converge asks this companion again.
      log.warn(`${adapter.name}: ${applied.failure}`);
      out.push({ companion: adapter.name, status: "failed", reason: applied.failure });
      continue;
    }

    const settled = adapter.settle ? await adapter.settle(ctx) : null;
    if (settled !== null) {
      log.warn(`${adapter.name}: ${settled}`);
      out.push({ companion: adapter.name, status: "failed", reason: settled });
      continue;
    }

    const check = adapter.check ? await adapter.check(ctx) : ({ ok: true, witness: "" } as CompanionCheck);
    if (!check.ok) {
      log.warn(`${adapter.name}: ${check.reason}`);
      out.push({ companion: adapter.name, status: "failed", reason: check.reason });
      continue;
    }
    const missing = missingOwned(applied.owned);
    if (missing !== null) {
      log.warn(`${adapter.name}: ${missing}`);
      out.push({ companion: adapter.name, status: "failed", reason: missing });
      continue;
    }

    const reload: ReloadState = restartNeeded(adapter, running) ? "restart-needed" : "current";
    registry.companions[adapter.name] = {
      setDigest: ctx.setDigest,
      setVersion: ctx.setVersion,
      version: desired.version,
      stateDigest: await stateDigestOf(applied.owned, check.witness),
      reload,
      owned: applied.owned,
      ...(adapter.name === "vscode" ? { targets: [...ctx.editors] } : {}),
      verifiedAt: now(),
    };
    await writeCompanionRegistry(home, registry);
    log.ok(`${adapter.name}: red-skills ${desired.version} installed`);
    out.push({ companion: adapter.name, status: "reconciled", version: desired.version, reload });
  }

  // Last, and only over what nothing needs any more. Pruning before the
  // walk would be pruning the artifact a companion is about to fail to
  // replace.
  pruneCompanionAssets(home, retainedVersions(home));

  return out;
}

/**
 * Whether a recorded companion still has what the record says it has.
 *
 * The set digest, so an in-place edit to a development checkout is caught
 * where a path never moves. The artifact version, so a set that carries a
 * newer extension under the same digest still reinstalls. And the observed
 * digest of the owned state itself: a launcher somebody deleted, an
 * extension an editor dropped on upgrade, a herdr config rewritten by
 * hand — all of them show up here and nowhere else.
 */
async function isCurrent(
  record: CompanionRecord,
  ctx: CompanionContext,
  desired: CompanionPlan,
  adapter: CompanionAdapter,
): Promise<boolean> {
  if (record.setDigest !== ctx.setDigest) return false;
  if (record.version !== desired.version) return false;
  if (adapter.name === "vscode" && (record.targets ?? []).join("\0") !== ctx.editors.join("\0")) {
    return false;
  }

  const witness = adapter.check ? await adapter.check(ctx) : ({ ok: true, witness: "" } as CompanionCheck);
  if (!witness.ok) return false;
  return (await stateDigestOf(record.owned, witness.witness)) === record.stateDigest;
}

/**
 * Never a signal, never a kill.
 *
 * A daemon that is up keeps its process and is told, in the record and in
 * doctor, that what is on disk under it is newer than what it loaded.
 */
function restartNeeded(adapter: CompanionAdapter, running: (cmd: string) => boolean): boolean {
  if (adapter.name === "redskilled") return running("redskilled");
  if (adapter.name === "herdr") return running("herdr");
  return false;
}

// ------------------------------------------------------------- the retention

/**
 * The cache the release path used to fill, and the versions still entitled
 * to a place in it.
 *
 * Companion artifacts now live inside the set directories, which
 * src/red-skills-set.ts already retains two of. What is left over is the
 * download cache every converge before this one appended a `.vsix` to and
 * nothing ever swept — so the rule Spec #201 asks for is applied to it:
 * keep what the active and previous revisions could still need, delete the
 * rest.
 */
export function companionAssetCache(home: string): string {
  return `${home.replace(/\\/g, "/")}/.local/share/red-dev/red-skills-assets`;
}

/** The versions of the sets this machine still holds, newest first. */
export function retainedVersions(home: string): string[] {
  // The state file alone. A machine with none answers with no versions,
  // and nothing is then entitled to a place in the cache.
  return readPackageSetState(home).revisions.map((r) => r.version);
}

/** Delete every cached artifact no retained revision could still want. */
export function pruneCompanionAssets(home: string, keep: readonly string[]): string[] {
  const dir = companionAssetCache(home);
  const dropped: string[] = [];
  for (const name of listing(dir)) {
    const version = vsixVersion(name);
    if (version !== null && keep.includes(version)) continue;
    const path = join(dir, name);
    try {
      rmSync(path, { recursive: true, force: true });
      dropped.push(path);
    } catch {
      // A file we cannot remove is one more converge's worth of disk, not
      // a reason to fail a reconciliation that already succeeded.
    }
  }
  if (dropped.length > 0) log.ok(`red-skills: ${dropped.length} stale companion artifact(s) removed`);
  return dropped;
}

// -------------------------------------------------------------- the removal

/** What one companion did on the way out, or the reason it did nothing. */
export interface CompanionRemoveOutcome {
  companion: CompanionName;
  removed: boolean;
  reason?: string;
  /** Everything that is gone, as the record named it. */
  took: string[];
}

/**
 * Take back exactly what was recorded, and nothing beside it.
 *
 * Driven by the ownership record rather than by a probe, which is the same
 * rule the host removal follows: a machine red-dev never installed these
 * on has nothing removed from it, and a config file the operator owns
 * loses one block rather than being rewritten.
 */
export async function removeCompanions(
  p: Platform,
  opts: CompanionReconcileOptions = {},
): Promise<CompanionRemoveOutcome[]> {
  const home = opts.home ?? homeOf();
  const adapters = opts.adapters ?? COMPANION_ADAPTERS;
  const run = opts.run ?? (await defaultRunner());
  const registry = readCompanionRegistry(home);
  const source = opts.source !== undefined ? opts.source : await currentSource();

  const ctx: CompanionContext = {
    platform: p,
    source: source ?? "",
    setDigest: opts.setDigest ?? "",
    setVersion: opts.setVersion ?? "",
    current: opts.current ?? redSkillsCurrentPosix(home),
    home,
    config: opts.config ?? configOf(home),
    herdrDir: opts.herdrDir !== undefined ? opts.herdrDir : await herdrDirOf(p),
    zellijDir: opts.zellijDir ?? (await zellijDirOf(p)),
    bin: opts.bin ?? runtimeBinDir(home),
    editors: (opts.editors ?? (() => []))(),
    extensionsOf: opts.extensions ?? (async () => []),
    compose: opts.compose ?? (async () => {}),
  };

  const out: CompanionRemoveOutcome[] = [];
  for (const adapter of adapters) {
    const record = registry.companions[adapter.name];
    if (!record) {
      out.push({ companion: adapter.name, removed: false, reason: "nothing recorded", took: [] });
      continue;
    }

    const failure = await runSteps(adapter.remove(ctx, record), run);
    const took: string[] = [];
    for (const entry of record.owned) {
      if (entry.kind === "path") {
        rmSync(entry.path, { recursive: true, force: true });
        took.push(entry.path);
        continue;
      }
      if (entry.kind === "block") {
        if (await removeBlock(entry.file, entry.marker)) took.push(`${entry.file} (block)`);
        continue;
      }
      if (entry.kind === "host") took.push(entry.what);
    }

    delete registry.companions[adapter.name];
    await writeCompanionRegistry(home, registry);
    out.push({
      companion: adapter.name,
      removed: failure === null,
      ...(failure === null ? {} : { reason: failure }),
      took,
    });
  }
  return out;
}

// ---------------------------------------------------------------- the report

/** What doctor says about one companion, as data. */
export interface CompanionDoctorRow {
  companion: string;
  setDigest: string;
  setVersion: string;
  version: string;
  stateDigest: string;
  reload: ReloadState;
  targets?: string[];
  verifiedAt: string;
}

export interface CompanionDoctorReport {
  companions: CompanionDoctorRow[];
  /** Adapters with no record at all, in table order. */
  unrecorded: string[];
}

/**
 * What the registry says, as JSON rather than as lines.
 *
 * The facts a person needs when two machines disagree — which set each
 * companion came out of, which version of the artifact that produced, and
 * whether anything still has to be restarted — are also the facts a script
 * needs, and rendering them twice is how the two answers start to differ.
 */
export function redSkillsCompanionReport(
  home: string,
  adapters: readonly CompanionAdapter[] = COMPANION_ADAPTERS,
): CompanionDoctorReport {
  const registry = readCompanionRegistry(home);
  const companions: CompanionDoctorRow[] = [];
  const unrecorded: string[] = [];
  for (const adapter of adapters) {
    const record = registry.companions[adapter.name];
    if (!record) {
      unrecorded.push(adapter.name);
      continue;
    }
    companions.push({
      companion: adapter.name,
      setDigest: record.setDigest,
      setVersion: record.setVersion,
      version: record.version,
      stateDigest: record.stateDigest,
      reload: record.reload,
      ...(record.targets ? { targets: record.targets } : {}),
      verifiedAt: record.verifiedAt,
    });
  }
  return { companions, unrecorded };
}

export interface CompanionDoctorLine {
  status: "ok" | "warn" | "n/a";
  detail: string;
}

/** The report as the lines doctor prints. */
export function redSkillsCompanionRows(report: CompanionDoctorReport): CompanionDoctorLine[] {
  const rows: CompanionDoctorLine[] = report.companions.map((row) => ({
    status: row.reload === "restart-needed" ? "warn" : "ok",
    detail:
      `${row.companion} ${row.version} — from ${row.setVersion} ${row.setDigest.slice(0, 12)}, ` +
      `state ${row.stateDigest.slice(0, 12)}` +
      (row.targets && row.targets.length > 0 ? `, in ${row.targets.join(", ")}` : "") +
      (row.reload === "restart-needed" ? " — restart needed to load it" : ""),
  }));
  if (report.unrecorded.length > 0) {
    rows.push({ status: "n/a", detail: `no observed record yet: ${report.unrecorded.join(", ")}` });
  }
  return rows;
}

// ------------------------------------------------------------- the defaults

async function currentSource(): Promise<string | null> {
  const { resolvedSource } = await import("./red-skills-ext.ts");
  return resolvedSource();
}

async function presenceProbe(): Promise<(cmd: string) => boolean> {
  const { commandPath } = await import("./agents.ts");
  return (cmd: string) => commandPath(cmd) !== null;
}

async function defaultRunner(): Promise<(cmd: string[]) => Promise<number>> {
  const { spawnLogged } = await import("./providers.ts");
  return (cmd: string[]) => spawnLogged(cmd);
}

async function extensionProbe(): Promise<(cli: string) => Promise<string[]>> {
  return async (cli: string) => {
    try {
      const proc = Bun.spawn([cli, "--list-extensions"], {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
      });
      const out = await new Response(proc.stdout).text();
      if ((await proc.exited) !== 0) return [];
      return out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  };
}

async function herdrDirOf(p: Platform): Promise<string | null> {
  const { herdrConfigDir } = await import("./herdr.ts");
  return herdrConfigDir(p);
}

async function zellijDirOf(p: Platform): Promise<string> {
  const { configHome } = await import("./shared-root.ts");
  return `${configHome(p, "zellij")}/zellij`;
}

async function composer(): Promise<(p: Platform) => Promise<void>> {
  const { installZellijConfig } = await import("./dotfiles.ts");
  return (p: Platform) => installZellijConfig(p);
}

/**
 * Install the one editor a clean workstation is guaranteed.
 *
 * Microsoft's repository on Ubuntu and winget on Windows, which is how
 * every other application on this machine arrives; nothing here downloads
 * a `.deb` by hand. Answers the editors present afterwards, which is empty
 * when the install did not take — and an empty answer is what makes the
 * extension adapter report `blocked` rather than pretend.
 */
async function editorInstaller(): Promise<(p: Platform) => Promise<string[]>> {
  return async (p: Platform) => {
    const { commandPath } = await import("./agents.ts");
    try {
      if (p.os === "windows") {
        const { wingetInstall } = await import("./providers.ts");
        await wingetInstall(VSCODE_WINGET_ID);
      } else {
        const { aptRepoInstall } = await import("./providers.ts");
        await aptRepoInstall({ ...VSCODE_APT_REPO, pkgs: [...VSCODE_APT_REPO.pkgs] }, p.codename ?? "stable");
      }
    } catch (error) {
      log.warn(`vscode: ${(error as Error).message}`);
      return [];
    }
    return EDITOR_CLIS.filter((cli) => commandPath(cli) !== null);
  };
}

/**
 * The identity of the set this machine resolves.
 *
 * A revision the converge installed is immutable and already carries a
 * recorded digest, so it is read rather than recomputed. Anything else is
 * hashed, and that is the case that matters: a development checkout is
 * edited in place, keeps its path and has no recorded identity, so the
 * only way to notice it moved is to look.
 */
async function setIdentity(home: string, source: string): Promise<{ digest: string; version: string }> {
  const { treeDigest } = await import("./red-skills-set.ts");
  try {
    const state = readPackageSetState(home);
    const active = state.revisions.find((r) => r.key === state.active);
    if (active && samePathText(active.path, source)) {
      return { digest: active.digest, version: active.version };
    }
  } catch {
    // No state, or one we cannot read: hash the tree and carry on.
  }
  return { digest: treeDigest(source), version: source.split("/").pop() ?? source };
}

function samePathText(left: string, right: string): boolean {
  const clean = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return clean(left) === clean(right);
}

/**
 * Is a process of this companion up right now?
 *
 * Only ever used to say "restart needed" — nothing here signals or waits
 * for anything. A probe that cannot run answers no, which reports one
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
