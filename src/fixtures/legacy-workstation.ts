/**
 * A workstation as Spec #185 left it, materialised on disk.
 *
 * Every claim the adoption in src/red-skills-adopt.ts makes is a claim
 * about a machine somebody has: one that was provisioned by the
 * standalone `install.sh`, carries the ADR 0008 layout, and has been
 * updated a few times so the history is real rather than a single
 * version sitting alone. There is no such machine in CI, so this builds
 * one — and builds it out of the same paths the production modules
 * read, imported rather than spelled out again, so a layout that moves
 * breaks the fixture instead of quietly leaving it testing nothing.
 *
 * Three shapes, because the acceptance criteria name three:
 *
 *   - `standalone` is the Spec #185 machine whole: extracted version
 *     trees, the tarballs they came out of, a GitHub-sourced marketplace
 *     in Claude and a Git-sourced one in Codex, the generated OpenCode,
 *     RedCode and pi surfaces with the manifests that record them, the
 *     per-version plugin copies each host kept, and the release-driven
 *     companion record.
 *   - `mixed` is the same machine after a package set has been acquired
 *     onto it. Both sources exist at once, which is the state an
 *     adoption actually runs in and the one where "remove the old thing"
 *     is dangerous rather than obvious.
 *   - `interrupted` is `mixed` with a backup already taken and the
 *     cleanup never reached — a run that was killed between the two
 *     halves. Nothing may have been removed, and the criterion is that
 *     the machine is still usable from the previous source.
 *
 * The user-authored files are the other half of the fixture and are the
 * reason the shape returns them: `opencode.json`'s own providers,
 * Codex's own tables, Claude's settings and one hand-written skill are
 * files nobody here wrote, and an adoption that took any of them would
 * pass every test about disk reclaimed while destroying the machine.
 */

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { sha256Hex } from "../checksum.ts";
import { claudeRegistrationPath, codexRegistrationPath } from "../red-skills-registration.ts";
import {
  packageSetStatePath,
  redSkillsCurrentLink,
  redSkillsSetDir,
  revisionKey,
  type PackageSetRevision,
} from "../red-skills-set.ts";

/** The releases the standalone installer left extracted, oldest first. */
export const LEGACY_VERSIONS: readonly string[] = ["3.16.0", "3.17.0", "3.18.0"];

/** The one `~/.red-skills/current` pointed at when Spec #185 stopped. */
export const LEGACY_CURRENT = "3.18.0";

/** The plugins each host kept a per-version copy of. */
export const LEGACY_PLUGINS: readonly string[] = ["dev", "brain"];

/** The package set an adopted machine resolves once it has one. */
export const ADOPTED_SET = {
  version: "3.20.0",
  digest: sha256Hex("red-skills package set 3.20.0"),
  sourceCommit: "626a28473edeee992fcf6425dedbca84448343fd",
};

/** The revision it replaced, which retention is still entitled to keep. */
export const PREVIOUS_SET = {
  version: "3.19.5",
  digest: sha256Hex("red-skills package set 3.19.5"),
  sourceCommit: "3fcba9589ff0a3c4b6f2e1d0c9b8a7f6e5d4c3b2",
};

export type LegacyShape = "standalone" | "mixed" | "interrupted";

export interface LegacyWorkstation {
  home: string;
  /** `$XDG_CONFIG_HOME`, which is where the generators write. */
  config: string;
  /**
   * Files the operator wrote, by path, with the bytes they must still
   * hold afterwards. Asserted rather than described: "preserves
   * user-authored configuration" is only a claim if something reads the
   * file back.
   */
  userAuthored: Record<string, string>;
  /** The generated paths each host's legacy manifest names. */
  generated: Record<string, string[]>;
  /** The package set this machine resolves, or null before one exists. */
  active: PackageSetRevision | null;
}

/**
 * Build one of the three machines under `home`.
 *
 * `home` is created if it is not there, and nothing outside it is
 * touched — the modules under test all take a home, so a fixture that
 * needed a real `$HOME` would be a fixture that could only run on one
 * machine.
 */
export function materialiseLegacyWorkstation(
  home: string,
  shape: LegacyShape = "standalone",
): LegacyWorkstation {
  const config = join(home, ".config");
  const userAuthored: Record<string, string> = {};
  const generated: Record<string, string[]> = {};

  standaloneTrees(home);
  retainedTarballs(home);
  gitRegistrations(home, userAuthored);
  hostPluginCopies(home);
  for (const host of ["opencode", "redcode", "pi"]) {
    generated[host] = generatedHostState(config, host, userAuthored);
  }
  companionRecord(home);
  handWrittenSkill(home, userAuthored);

  const active = shape === "standalone" ? null : adoptedPackageSet(home);
  if (shape === "interrupted") interruptedBackup(home);

  return { home, config, userAuthored, generated, active };
}

// ------------------------------------------------------- the standalone tree

/**
 * `~/.red-skills/versions/<v>` plus the `current` link into the newest.
 *
 * Each tree carries the two markers the standalone installer leaves —
 * the marketplace manifest every host registered against and the
 * `.upstream` stamp — because those are what tell an inventory that a
 * directory under `versions/` came out of a RedSkills tarball rather
 * than out of somebody's afternoon.
 */
function standaloneTrees(home: string): void {
  const versions = join(home, ".red-skills", "versions");
  for (const version of LEGACY_VERSIONS) {
    const tree = join(versions, version);
    mkdirSync(join(tree, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(tree, ".claude-plugin", "marketplace.json"),
      `${JSON.stringify({ name: "red-skills", plugins: LEGACY_PLUGINS }, null, 2)}\n`,
    );
    writeFileSync(join(tree, ".upstream"), "reddb-io/red-skills\n");
    writeFileSync(join(tree, "package.json"), `${JSON.stringify({ version }, null, 2)}\n`);
    mkdirSync(join(tree, "scripts"), { recursive: true });
    writeFileSync(join(tree, "scripts", "install-opencode.sh"), "#!/bin/sh\nexit 0\n");
  }
  symlinkSync(join(versions, LEGACY_CURRENT), redSkillsCurrentLink(home), "dir");
}

/** The tarballs `~/.red-skills/cache` kept after unpacking each one. */
function retainedTarballs(home: string): void {
  const cache = join(home, ".red-skills", "cache");
  mkdirSync(cache, { recursive: true });
  for (const version of LEGACY_VERSIONS) {
    writeFileSync(join(cache, `red-skills-${version}.tar.gz`), `tarball ${version}\n`);
  }
}

// ----------------------------------------------------- the two registrations

/**
 * Claude registered from GitHub, Codex from Git — the two spellings of
 * the same Spec #185 decision.
 *
 * Both files carry state nobody here wrote, and both are returned as
 * user-authored: Claude's `known_marketplaces.json` holds the operator's
 * other marketplace, and Codex's `config.toml` holds their model
 * settings above the table this inventory is about. An adoption that
 * rewrote either file wholesale would be indistinguishable from one that
 * removed the registration correctly, right up until somebody opened it.
 */
function gitRegistrations(home: string, userAuthored: Record<string, string>): void {
  const claude = claudeRegistrationPath(home);
  mkdirSync(dirname(claude), { recursive: true });
  writeFileSync(
    claude,
    `${JSON.stringify(
      {
        "red-skills": { source: { source: "github", repo: "reddb-io/red-skills" } },
        "someone-elses": { source: { source: "github", repo: "example/plugins" } },
      },
      null,
      2,
    )}\n`,
  );

  const codex = codexRegistrationPath(home);
  mkdirSync(dirname(codex), { recursive: true });
  const codexToml = [
    "model = \"gpt-5\"",
    "approval_policy = \"on-request\"",
    "",
    "[marketplaces.red-skills]",
    'source_type = "git"',
    'source = "https://github.com/reddb-io/red-skills.git"',
    "",
    "[marketplaces.someone-elses]",
    'source_type = "git"',
    'source = "https://github.com/example/plugins.git"',
    "",
  ].join("\n");
  writeFileSync(codex, codexToml);
  userAuthored[codex] = codexToml;

  const settings = join(home, ".claude", "settings.json");
  const bytes = `${JSON.stringify({ theme: "dark", statusLine: { type: "command" } }, null, 2)}\n`;
  writeFileSync(settings, bytes);
  userAuthored[settings] = bytes;
}

// ------------------------------------------------------- the host copies

/**
 * The per-version plugin copies each host kept and never collected.
 *
 * Claude also records which of them it is resolving through, in the file
 * src/red-skills-adopt.ts reads back: the copy the host is actually
 * using, which a cleanup that took it would be removing the plugin
 * rather than its history.
 */
function hostPluginCopies(home: string): void {
  const claudeCache = join(home, ".claude", "plugins", "cache", "red-skills");
  const codexCache = join(home, ".codex", "plugins", "cache", "red-skills");
  for (const plugin of LEGACY_PLUGINS) {
    for (const version of LEGACY_VERSIONS) {
      for (const cache of [claudeCache, codexCache]) {
        const dir = join(cache, plugin, version);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "plugin.json"), `${JSON.stringify({ version }, null, 2)}\n`);
      }
    }
  }

  const installed = join(home, ".claude", "plugins", "installed_plugins.json");
  writeFileSync(
    installed,
    `${JSON.stringify(
      {
        plugins: Object.fromEntries(
          LEGACY_PLUGINS.map((plugin) => [
            plugin,
            [{ installPath: join(claudeCache, plugin, LEGACY_CURRENT) }],
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  );
}

// --------------------------------------------------- the generated surfaces

/**
 * One generator's output plus the manifest that records it.
 *
 * The manifest is the whole point. OpenCode, RedCode and pi have no
 * marketplace to ask, so the standalone installer wrote down what it
 * created — and that list, not a guess about which files under a config
 * directory look generated, is what an adoption is allowed to act on.
 * The user's own `opencode.json` sits in the same directory and is
 * deliberately absent from it.
 */
function generatedHostState(
  config: string,
  host: string,
  userAuthored: Record<string, string>,
): string[] {
  const dir = join(config, host);
  mkdirSync(join(dir, "plugin"), { recursive: true });
  mkdirSync(join(dir, "skill"), { recursive: true });

  const paths = [
    join(dir, "plugin", "red-skills.js"),
    join(dir, "skill", "red-skills.md"),
  ];
  for (const path of paths) writeFileSync(path, `generated for ${host} from ${LEGACY_CURRENT}\n`);
  writeFileSync(join(dir, "redskills-install-manifest.txt"), `${paths.join("\n")}\n`);

  const own = join(dir, `${host}.json`);
  const bytes = `${JSON.stringify({ provider: { anthropic: { enabled: true } } }, null, 2)}\n`;
  writeFileSync(own, bytes);
  userAuthored[own] = bytes;
  return paths;
}

/** The release-driven record ADR 0014 replaced, still on disk. */
function companionRecord(home: string): void {
  const path = join(home, ".local", "share", "red-dev", "red-skills-extensions.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        vscode: { tag: `v${LEGACY_CURRENT}`, editors: ["code"], id: "reddb-io.vscode-extension-red-skills" },
        herdr: { tag: `v${LEGACY_CURRENT}` },
      },
      null,
      2,
    )}\n`,
  );

  const assets = join(home, ".local", "share", "red-dev", "red-skills-assets");
  mkdirSync(assets, { recursive: true });
  for (const version of LEGACY_VERSIONS) {
    writeFileSync(join(assets, `red-skills-${version}.vsix`), `vsix ${version}\n`);
  }
}

/** A skill the operator wrote by hand, in a directory RedSkills also uses. */
function handWrittenSkill(home: string, userAuthored: Record<string, string>): void {
  const path = join(home, ".claude", "skills", "mine", "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  const bytes = "---\nname: mine\n---\n\nMy own skill.\n";
  writeFileSync(path, bytes);
  userAuthored[path] = bytes;
}

// ----------------------------------------------------- the new source beside it

/**
 * The package set an adoption has already put on the machine.
 *
 * Two revisions, because "caches beyond active plus previous" is a
 * sentence with no content on a machine that holds one. `current` is
 * repointed at the active set, which is the state the verification gate
 * observes and therefore the only state a cleanup is allowed to run in.
 */
function adoptedPackageSet(home: string): PackageSetRevision {
  const revisions = [ADOPTED_SET, PREVIOUS_SET].map((id): PackageSetRevision => {
    const key = revisionKey(id);
    const path = redSkillsSetDir(home, key);
    mkdirSync(join(path, "tree", "scripts"), { recursive: true });
    writeFileSync(
      join(path, "tree", "package.json"),
      `${JSON.stringify({ version: id.version }, null, 2)}\n`,
    );
    return {
      key,
      version: id.version,
      digest: id.digest,
      sourceCommit: id.sourceCommit,
      kind: "manifest",
      trust: "trusted",
      path,
    };
  });

  const state = {
    schema: 1,
    active: revisions[0]?.key ?? null,
    revisions,
    refused: null,
    staged: null,
  };
  const statePath = packageSetStatePath(home);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  // `current` follows the set, which is what the standalone layout stops
  // owning the moment a package set is active.
  const current = redSkillsCurrentLink(home);
  rmSync(current, { force: true, recursive: true });
  symlinkSync(join(revisions[0]!.path, "tree"), current, "dir");

  // What a verified reconciliation leaves in each host: a copy of the
  // plugins out of the new set, and — for the host that records it —
  // an installed path naming that copy instead of the legacy one. A
  // fixture that skipped this would be asserting the retention rule
  // against a machine whose hosts were still resolving Spec #185.
  reconciledPluginCopies(home, revisions.map((r) => r.version), revisions[0]!.version);
  return revisions[0]!;
}

/** The per-version copies the retained revisions are entitled to. */
function reconciledPluginCopies(
  home: string,
  versions: readonly string[],
  active: string,
): void {
  const claudeCache = join(home, ".claude", "plugins", "cache", "red-skills");
  for (const plugin of LEGACY_PLUGINS) {
    for (const version of versions) {
      for (const cache of [claudeCache, join(home, ".codex", "plugins", "cache", "red-skills")]) {
        const dir = join(cache, plugin, version);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "plugin.json"), `${JSON.stringify({ version }, null, 2)}\n`);
      }
    }
  }

  writeFileSync(
    join(home, ".claude", "plugins", "installed_plugins.json"),
    `${JSON.stringify(
      {
        plugins: Object.fromEntries(
          LEGACY_PLUGINS.map((plugin) => [
            plugin,
            [{ installPath: join(claudeCache, plugin, active) }],
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * A backup from a run that was killed before it verified anything.
 *
 * Written straight to disk rather than by calling the adoption, so the
 * test that asserts an interrupted machine is still usable is not
 * asserting it against the code path it is trying to catch out.
 */
function interruptedBackup(home: string): void {
  const dir = join(home, ".local", "state", "red-dev", "adoption", "2026-08-19T04-00-00Z");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "inventory.json"), `${JSON.stringify({ schema: 1, items: [] }, null, 2)}\n`);
}
