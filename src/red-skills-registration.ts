/**
 * Who owns the marketplace registration on a machine that has both installers.
 *
 * The standalone one-liner registers RedSkills from GitHub, and carries a
 * heal step that re-registers a machine it finds registered from a
 * directory. It was right to: a directory registration used to mean a
 * machine frozen at its install-day snapshot, because `marketplace update`
 * re-reads whatever source was registered and nothing on the machine ever
 * moved that directory.
 *
 * mise is a thing that moves it. Once the core is a manifest entry
 * resolved at `latest`, `~/.red/skills/current` advances with every other
 * tool on the machine — so the directory is now the *only* source pinned
 * to the version this machine actually resolved. Registering from GitHub
 * instead would put the hosts back on a version nothing here chose.
 *
 * Both remain true installers, so both would keep acting. Two installers
 * evicting each other's registration is silent and endless — each one
 * finds the other's source, heals it, and reports success — and two
 * marketplace *names* would be worse still, since every plugin would
 * install twice. So there is one declared owner rather than a merge, and
 * where red-dev is present it is red-dev.
 *
 * ## The fact both halves assert against
 *
 * The other half of this lives in reddb-io/red-skills: the standalone
 * installer stands down from healing when it detects red-dev. Two repos
 * cannot share a test, so they share a fact instead — the registration
 * kind the host itself writes down, in the same file the healing reads:
 *
 *   claude  `~/.claude/plugins/known_marketplaces.json`  source.source
 *   codex   `~/.codex/config.toml`                       source_type
 *
 * That is what `claudeRegistration` and `codexRegistration` answer, and
 * what the converge below re-reads after it registers. An outcome derived
 * from the exit code instead would let a machine be reported as converged
 * while the entry on disk still says github — which is precisely the state
 * the arbitration exists to end.
 *
 * ## Registering `current`, not the version behind it
 *
 * `~/.red/skills/current` is the path red-dev repoints when mise installs
 * a newer core. A registration made against `versions/v3.3.0` names a
 * directory that is correct today and never moves again, so it is treated
 * as drift here even though it is directory-sourced.
 *
 * ## And a machine without red-dev is untouched
 *
 * Ownership is claimed from having something to register: with no checkout
 * under `~/.red/skills/current` this does nothing at all — no commands, no
 * files, no marker. The standalone one-liner stays first-class on machines
 * that only have it, which is the whole reason the arbitration is a
 * declaration rather than a fight.
 */

import { existsSync, realpathSync } from "node:fs";

import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import type { Tool } from "./manifest.ts";

/** The one name both installers register under. Two names install twice. */
export const MARKETPLACE_NAME = "red-skills";

/**
 * What a host says its marketplace came from, in the two spellings that matter.
 *
 * Claude's `directory`/`github` and Codex's `local`/`git` are one
 * distinction recorded in two vocabularies, so they are normalised here:
 * the arbitration is about which kind wins, and a caller that had to know
 * which host it was asking would be a caller that can get it wrong.
 */
export type RegistrationKind = "directory" | "github";

export interface MarketplaceRegistration {
  kind: RegistrationKind;
  /** The directory or repo the host recorded, verbatim. */
  source: string | null;
}

function normalise(home: string): string {
  return home.replace(/\\/g, "/");
}

/** Where Claude records what it registered. */
export function claudeRegistrationPath(home: string): string {
  return `${normalise(home)}/.claude/plugins/known_marketplaces.json`;
}

/** Where Codex records what it registered. */
export function codexRegistrationPath(home: string): string {
  return `${normalise(home)}/.codex/config.toml`;
}

/**
 * Claude's entry for the RedSkills marketplace, or null for no opinion.
 *
 * Null covers no file, no entry and an unreadable one. Unreadable is not
 * the same as wrong: re-registering a marketplace on a guess about a file
 * we could not parse is worse than leaving the machine alone, and the next
 * converge asks again.
 */
export async function claudeRegistration(home: string): Promise<MarketplaceRegistration | null> {
  const path = claudeRegistrationPath(home);
  if (!existsSync(path)) return null;
  try {
    const known = JSON.parse(await Bun.file(path).text()) as Record<
      string,
      { source?: { source?: string; path?: string; repo?: string } }
    >;
    const source = known[MARKETPLACE_NAME]?.source;
    if (source?.source === "directory") return { kind: "directory", source: source.path ?? null };
    if (source?.source === "github") return { kind: "github", source: source.repo ?? null };
    return null;
  } catch {
    return null;
  }
}

/**
 * One TOML string value, in either of the two spellings TOML has.
 *
 * `"basic"` and `'literal'`. Only the first was read, and Codex writes
 * the second on Windows for exactly the reason TOML has it: the value
 * is a path full of backslashes, and a basic string would need every
 * one of them escaped.
 *
 *     source = '\\?\C:\Users\me\.red\skills\sets\4.0.1+41a32e805372'
 *
 * Read as basic-only, that line answered null, the registration looked
 * like a source of nothing, and the check reported "the marketplace is
 * registered from nothing" about a marketplace Codex had just recorded
 * correctly. Codex on Windows could therefore never verify — which held
 * the adoption and left `red-dev update` permanently partial there.
 *
 * A literal string is literal: no escape processing, which is what makes
 * it the right container for a Windows path and means the value is used
 * exactly as written.
 */
function tomlStringValue(line: string, key: string): string | null {
  const basic = line.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`));
  if (basic) return basic[1] ?? null;
  const literal = line.match(new RegExp(`^\\s*${key}\\s*=\\s*'([^']*)'\\s*$`));
  return literal?.[1] ?? null;
}

/** Codex's entry for the same marketplace, read out of its config table. */
export async function codexRegistration(home: string): Promise<MarketplaceRegistration | null> {
  const path = codexRegistrationPath(home);
  if (!existsSync(path)) return null;
  try {
    let inTable = false;
    let kind: RegistrationKind | null = null;
    let source: string | null = null;
    for (const line of (await Bun.file(path).text()).split(/\r?\n/)) {
      const table = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (table) {
        if (inTable) break;
        inTable = table[1] === `marketplaces.${MARKETPLACE_NAME}`;
        continue;
      }
      if (!inTable) continue;
      const sourceType = tomlStringValue(line, "source_type");
      if (sourceType !== null) kind = sourceType === "git" ? "github" : "directory";
      const value = tomlStringValue(line, "source");
      if (value !== null) source = value;
    }
    return kind === null ? null : { kind, source };
  } catch {
    return null;
  }
}

/**
 * One host whose registration red-dev declares, and how it is declared.
 *
 * There is no `marketplace set-source` in either CLI, so re-registering is
 * remove-then-add — the same steps anyone doing this by hand runs. The
 * remove is allowed to fail: a machine with nothing registered yet is the
 * ordinary first converge, not a broken host.
 *
 * The plugins are reinstalled because they came from a marketplace that no
 * longer exists under that name. Which plugins is the manifest's answer,
 * never this table's: a machine that opted `brain` out has no entry for
 * it, and naming it here would reinstall exactly what the operator removed.
 */
export interface RegistrationHost {
  /** The name that appears in an outcome and a log line. */
  name: string;
  /** The command that has to be on PATH for this host to exist. */
  cmd: string;
  /** What this host has written down, read at its own boundary. */
  read: (home: string) => Promise<MarketplaceRegistration | null>;
  /** Remove, add from `source`, reinstall `plugins` — in that order. */
  register: (source: string, plugins: readonly string[]) => string[][];
}

export const REGISTRATION_HOSTS: readonly RegistrationHost[] = [
  {
    name: "claude",
    cmd: "claude",
    read: claudeRegistration,
    register: (source, plugins) => [
      ["claude", "plugin", "marketplace", "remove", MARKETPLACE_NAME],
      ["claude", "plugin", "marketplace", "add", source],
      ...plugins.map((p) => ["claude", "plugin", "install", `${p}@${MARKETPLACE_NAME}`]),
    ],
  },
  {
    name: "codex",
    cmd: "codex",
    read: codexRegistration,
    register: (source, plugins) => [
      ["codex", "plugin", "marketplace", "remove", MARKETPLACE_NAME],
      ["codex", "plugin", "marketplace", "add", source],
      ...plugins.map((p) => ["codex", "plugin", "add", `${p}@${MARKETPLACE_NAME}`]),
    ],
  },
];

/**
 * Is this the registration red-dev declares, on the path that moves?
 *
 * Directory-sourced is not enough on its own. A host registered against
 * `versions/v3.3.0` is directory-sourced and pinned to a directory that is
 * correct today and never moves again, which is the original frozen
 * machine wearing the right kind. Only `current` follows mise.
 *
 * One definition, because two callers ask it: the converge, to decide it
 * has nothing to do, and the drift check, to decide the machine is well.
 */
export function registrationIsOurs(
  registration: MarketplaceRegistration | null,
  source: string,
): boolean {
  return registration?.kind === "directory" && samePath(registration.source, source);
}

/** What one host was left registered against, or the reason nothing happened. */
export interface RegistrationOutcome {
  /** The host's name in REGISTRATION_HOSTS. */
  host: string;
  /** True only when this converge re-registered it and the host agrees. */
  registered: boolean;
  /** What the host records now, read back rather than assumed. */
  kind: RegistrationKind | null;
  /** Why not, present exactly when `registered` is false. */
  reason?: string;
}

/**
 * Everything the converge needs from outside itself.
 *
 * All of it has a real default and exists for the tests: registering a
 * marketplace is a sequence of commands issued to CLIs that may not be
 * installed, against a checkout that may not exist, and what is worth
 * pinning is which commands ran and what the host recorded afterwards.
 */
export interface RegistrationOptions {
  /** Defaults to this user's home. The host boundaries live under it. */
  home?: string;
  /** The path to register. Defaults to `~/.red/skills/current`, or null. */
  source?: string | null;
  /** The plugin set. Defaults to whatever the manifest declares. */
  plugins?: readonly string[];
  /** The manifest to derive the plugin set from. Defaults to TOOLS. */
  tools?: readonly Tool[];
  /** The hosts to declare against. Defaults to REGISTRATION_HOSTS. */
  hosts?: readonly RegistrationHost[];
  /** Is this host's command on PATH? Defaults to `commandPath`. */
  present?: (cmd: string) => boolean;
  /** Runs one argv and answers its exit code. Defaults to spawnLogged. */
  run?: (cmd: string[]) => Promise<number>;
}

/**
 * Declare red-dev's registration on every host that has one.
 *
 * Answers one outcome per host, including the hosts it left alone:
 * "absent", "already ours" and "refused" are three different facts, and a
 * caller reporting them needs to be able to tell them apart.
 *
 * With no checkout there is nothing to register from, and that is not a
 * failure — it is a machine red-dev does not own the wiring of. It answers
 * with no outcomes at all and touches nothing.
 */
export async function convergeMarketplaceOwnership(
  p: Platform,
  opts: RegistrationOptions = {},
): Promise<RegistrationOutcome[]> {
  const home = opts.home ?? homeOf();
  const hosts = opts.hosts ?? REGISTRATION_HOSTS;

  const source = opts.source !== undefined ? opts.source : await currentSource();
  if (source === null) {
    log.skip("red-skills: no managed checkout, leaving the marketplace registration alone");
    return [];
  }

  const plugins = opts.plugins ?? (await declaredPlugins(p, opts.tools));
  const present = opts.present ?? (await presenceProbe());
  const run = opts.run ?? (await defaultRunner());

  const out: RegistrationOutcome[] = [];
  for (const host of hosts) {
    if (!present(host.cmd)) {
      out.push({
        host: host.name,
        registered: false,
        kind: null,
        reason: `${host.cmd} is not installed`,
      });
      continue;
    }

    const before = await host.read(home);
    if (registrationIsOurs(before, source)) {
      log.skip(`${host.name}: red-skills already registered from ${source}`);
      out.push({
        host: host.name,
        registered: false,
        kind: "directory",
        reason: `already registered from ${source}`,
      });
      continue;
    }

    log.step(`${host.name}: registering the red-skills marketplace from ${source}`);
    if (before?.kind === "github") {
      log.plain("     red-dev owns this machine's wiring, and the directory it");
      log.plain("     registers is the version mise resolved. A GitHub source");
      log.plain("     would put this host back on a version nothing here chose.");
    }

    const failure = await runSteps(host.register(source, plugins), run);
    if (failure !== null) {
      log.warn(`${host.name}: ${failure}`);
      out.push({
        host: host.name,
        registered: false,
        kind: (await host.read(home))?.kind ?? null,
        reason: failure,
      });
      continue;
    }

    // Read back, never assumed. The exit code says the command ran; the
    // entry says what the other half of this arbitration will see.
    const after = await host.read(home);
    if (after?.kind !== "directory") {
      const reason = `registered from ${source}, but the host records ${after?.kind ?? "nothing"}`;
      log.warn(`${host.name}: ${reason}`);
      out.push({ host: host.name, registered: false, kind: after?.kind ?? null, reason });
      continue;
    }

    log.ok(`${host.name}: red-skills marketplace registered from ${source}`);
    out.push({ host: host.name, registered: true, kind: "directory" });
  }

  return out;
}

/**
 * Runs one host's steps, and answers the first hard failure or null.
 *
 * Only the remove is allowed to fail, and it is the first step, so the
 * failure this reports is always one that left the host without the
 * registration it was meant to gain.
 */
async function runSteps(
  steps: readonly string[][],
  run: (cmd: string[]) => Promise<number>,
): Promise<string | null> {
  const [remove, ...rest] = steps;
  if (remove) {
    try {
      await run(remove);
    } catch (error) {
      // Nothing registered yet is the ordinary first converge here.
      log.skip(`${remove.join(" ")} could not be run: ${(error as Error).message}`);
    }
  }

  for (const step of rest) {
    const what = step.join(" ");
    let code: number;
    try {
      code = await run(step);
    } catch (error) {
      return `${what} could not be run: ${(error as Error).message}`;
    }
    if (code !== 0) return `${what} exited ${code}`;
  }
  return null;
}

/** Two paths naming one directory, whether or not either resolves today. */
function samePath(a: string | null, b: string): boolean {
  if (a === null) return false;

  // `\\?\` is Windows' extended-length prefix. Codex records it and
  // nothing else on this side writes it, so it comes off *first* —
  // before the text comparison and before `realpathSync`, which keeps
  // whichever form it was given. Stripped only inside the text
  // comparison, the two paths still differed by the prefix once both
  // had been resolved, and a Codex that had just registered the right
  // directory read as registered against somebody else's.
  const bare = (s: string) => s.replace(/^\\\\\?\\/, "");
  const left = bare(a);
  const trim = (s: string) => normalise(s).replace(/\/+$/, "");
  if (trim(left) === trim(b)) return true;
  try {
    return trim(bare(realpathSync(left))) === trim(bare(realpathSync(b)));
  } catch {
    return false;
  }
}

function homeOf(): string {
  return normalise(process.env["HOME"] ?? process.env["USERPROFILE"] ?? "");
}

async function currentSource(): Promise<string | null> {
  const { sourceRoot } = await import("./red-skills-ext.ts");
  return sourceRoot();
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
