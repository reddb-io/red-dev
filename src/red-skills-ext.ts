/**
 * The two RedSkills artifacts that are not npm packages.
 *
 * The core and the plugins arrive through mise as `npm:` entries. The VS
 * Code extension and the herdr plugin cannot: one is a `.vsix` an editor
 * installs, the other a directory herdr registers. Both were therefore
 * built here, out of the checkout at ~/.red-skills/current — a pnpm
 * install of a 19-package turbo workspace, to produce a `.vsix` CI had
 * already produced and attached to the release.
 *
 * That build is now impossible as well as wasteful. The published
 * artifact stopped carrying monorepo source (red-skills ADR 0146), so
 * the tree this used to build from is the one thing a converged machine
 * no longer has. Both artifacts are resolved from the release instead:
 *
 *   vscode-extension-red-skills-<version>.vsix   installed into each editor
 *   herdr-plugin-red-skills.bundle.min.mjs       the plugin's own entry
 *
 * The herdr half is worth stating exactly, because it is the one place
 * where "install from the release" is not a download. herdr fetches the
 * plugin directory itself, and that directory's build hook writes the
 * released bundle over its entry — so what red-dev resolves is the
 * release *tag*, and it pins the fetch to it. Asking for the bundle by
 * name is what proves the release published one; without that, an
 * unpinned install reads whatever the default branch says today and can
 * name an asset no release has.
 *
 * Nothing here is fatal. A release that cannot be reached is a machine
 * with an older extension on it, which is a far better outcome than a
 * converge that stops before the steps after this one.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";
import type { GhRelease } from "./providers.ts";

function home(): string {
  const h = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!h) throw new RedError("neither HOME nor USERPROFILE is set");
  return h.replace(/\\/g, "/");
}

/** The red-skills checkout, or null when red-skills was never installed. */
export function sourceRoot(): string | null {
  const root = `${home()}/.red-skills/current`;
  return existsSync(`${root}/package.json`) ? root : null;
}

/**
 * The version directory `current` points at.
 *
 * Nothing here builds from it any more, but the layout it names is still
 * how the rest of the machine resolves RedSkills, so the question keeps
 * its answer in the module that has always owned it.
 */
export function resolvedSource(): string | null {
  const root = sourceRoot();
  return root === null ? null : realpathSync(root);
}

// ------------------------------------------------------------ the release

export const REDSKILLS_REPO = "reddb-io/red-skills";

/**
 * The published extension.
 *
 * A glob and not a filename: the asset carries the release version, and
 * reconstructing it from a version we already hold is exactly the guess
 * `resolveGhRelease` exists to stop anyone making.
 */
export const VSIX_ASSET = "vscode-extension-red-skills-*.vsix";

/** The published herdr entry bundle, whose name does not move. */
export const HERDR_BUNDLE_ASSET = "herdr-plugin-red-skills.bundle.min.mjs";

/** The plugin directory herdr fetches, pinned to the resolved tag. */
export const HERDR_PLUGIN_SOURCE = "reddb-io/red-skills/apps/herdr-plugin-red-skills";

/**
 * What the editors call the extension.
 *
 * Two spellings, because the app was renamed: a machine converged before
 * the rename carries `vscode-redskilled` and one converged after carries
 * `vscode-extension-red-skills`. Both count as "installed" when deciding
 * what to refresh — a probe that knew only the new one would report every
 * machine with the old extension as not having it, and leave it behind
 * forever.
 */
export const EXTENSION_ID = "reddb-io.vscode-extension-red-skills";
export const LEGACY_EXTENSION_ID = "reddb-io.vscode-redskilled";

/** What herdr calls the plugin. */
export const PLUGIN_ID = "reddb-io.red-skills";

// ------------------------------------------------------------- the record

/**
 * What this path installed, and out of which release.
 *
 * Neither artifact can be asked. The extension reports its own version
 * to the editor and herdr reports the plugin's, and neither is the
 * release they came from — the old build recorded the checkout it read
 * for the same reason. The record is also the only thing that means "we
 * did this": both tools are `managed`, so nothing probes for them, and
 * an uninstall driven by anything weaker would be removing an artifact
 * on the evidence that it exists.
 */
export interface InstalledArtifact {
  /** The release tag it was resolved from. */
  tag: string;
  /** For the extension: the editor CLIs that accepted it. */
  editors?: string[];
  /** For the extension: the identifier those editors know it by. */
  id?: string;
}

export interface ExtensionRecord {
  vscode?: InstalledArtifact;
  herdr?: InstalledArtifact;
}

/** Computed rather than a constant: the tests move HOME between cases. */
function recordPath(): string {
  return `${home()}/.local/share/red-dev/red-skills-extensions.json`;
}

/** Where a downloaded asset lands. Ours, so an uninstall may delete it. */
export function assetCache(): string {
  return `${home()}/.local/share/red-dev/red-skills-assets`;
}

export function readRecord(): ExtensionRecord {
  const path = recordPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ExtensionRecord;
  } catch {
    // A record we cannot read means "install again", which is the safe
    // way to be wrong: the cost is one download, not an editor pinned to
    // a release nobody can name.
    return {};
  }
}

export async function writeRecord(patch: ExtensionRecord): Promise<void> {
  const path = recordPath();
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Bun.write(path, `${JSON.stringify({ ...readRecord(), ...patch }, null, 2)}\n`);
}

/** Forget one artifact, or drop the record entirely once both are gone. */
export async function forgetRecord(which: keyof ExtensionRecord): Promise<void> {
  const rest = { ...readRecord() };
  delete rest[which];
  const path = recordPath();
  if (Object.keys(rest).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  await Bun.write(path, `${JSON.stringify(rest, null, 2)}\n`);
}

// ---------------------------------------------------------------- the seam

/**
 * Everything here that leaves the process.
 *
 * One object rather than module-level functions, so a test can assert
 * what a converge *does* — which release was asked for, which commands
 * ran, what the record says afterwards — without a network, an editor or
 * a herdr. The production implementation below is the only place that
 * knows any of those exist.
 */
export interface ExtIo {
  /** Every VS Code-family CLI on this machine. */
  clis(): string[];
  /** Those of them that already carry the extension, under either id. */
  editorsWithExtension(): Promise<string[]>;
  /** Is herdr on PATH at all? */
  hasHerdr(): boolean;
  /** Does herdr already know the plugin? */
  herdrHasPlugin(): Promise<boolean>;
  /** The newest release carrying an asset matching `glob`. Throws if none. */
  resolve(glob: string): Promise<GhRelease>;
  /** Fetch one resolved asset; the path it landed at. */
  download(release: GhRelease): Promise<string>;
  /** Run a command and hand back its exit code, never a throw. */
  run(cmd: string[]): Promise<number>;
}

/** Every VS Code-family CLI on this machine. */
export function vscodeClis(): string[] {
  return ["code", "codium", "cursor"].filter((c) => Bun.which(c));
}

/** Run a command and hand back its stdout, empty when it fails. */
async function capture(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : "";
  } catch {
    return "";
  }
}

export function defaultIo(): ExtIo {
  return {
    clis: vscodeClis,

    async editorsWithExtension(): Promise<string[]> {
      const found: string[] = [];
      for (const cli of vscodeClis()) {
        const listed = await capture([cli, "--list-extensions"]);
        if (listed.includes(EXTENSION_ID) || listed.includes(LEGACY_EXTENSION_ID)) found.push(cli);
      }
      return found;
    },

    hasHerdr: () => Boolean(Bun.which("herdr")),

    async herdrHasPlugin(): Promise<boolean> {
      if (!Bun.which("herdr")) return false;
      return (await capture(["herdr", "plugin", "list"])).includes(PLUGIN_ID);
    },

    async resolve(glob: string): Promise<GhRelease> {
      const { resolveGhRelease } = await import("./providers.ts");
      return await resolveGhRelease(REDSKILLS_REPO, glob);
    },

    async download(release: GhRelease): Promise<string> {
      const dir = assetCache();
      mkdirSync(dir, { recursive: true });
      const dest = `${dir}/${release.file}`;
      const { downloadVerified } = await import("./providers.ts");
      await downloadVerified(release.url, dest, { checksumUrl: release.checksumUrl ?? undefined });
      // Handed over with every link resolved.
      //
      // These editors are Windows programs even when invoked from a
      // distro: they translate the path to \\wsl.localhost\... and open
      // it over 9P, where a symlink anywhere above the file does not
      // survive. VS Code has WSL integration and coped; VSCodium
      // reported ENOENT on a file that plainly existed.
      return realpathSync(dest);
    },

    async run(cmd: string[]): Promise<number> {
      const { spawnLogged } = await import("./providers.ts");
      return await spawnLogged(cmd);
    },
  };
}

/**
 * Resolve one asset, or say why not and let the caller stand down.
 *
 * The whole reason this returns null instead of throwing: a rate-limited
 * GitHub, an offline machine or a release that has not published yet are
 * all reasons to leave an artifact exactly as it is, and none of them is
 * a reason to abandon the dotfiles, themes and agents that converge
 * after this one.
 */
async function resolveOrWarn(io: ExtIo, glob: string, what: string): Promise<GhRelease | null> {
  try {
    return await io.resolve(glob);
  } catch (err) {
    log.warn(`${what}: ${(err as Error).message}`);
    log.skip(`${what}: left as it is — the rest of the converge continues`);
    return null;
  }
}

// -------------------------------------------------------------- installing

/**
 * Install the published extension into every editor present.
 *
 * Every editor found, because a machine with both VS Code and VSCodium
 * wants it in the one being used, and asking which is a question with no
 * good default.
 */
export async function installVscodeExtension(
  io: ExtIo = defaultIo(),
  resolved?: GhRelease,
): Promise<void> {
  const clis = io.clis();
  if (clis.length === 0) {
    log.skip("vscode extension: no VS Code-family editor installed");
    return;
  }

  const release = resolved ?? (await resolveOrWarn(io, VSIX_ASSET, "vscode extension"));
  if (!release) return;

  let vsix: string;
  try {
    vsix = await io.download(release);
  } catch (err) {
    log.warn(`vscode extension: ${(err as Error).message}`);
    log.skip("vscode extension: left as it is — the rest of the converge continues");
    return;
  }

  const editors: string[] = [];
  for (const cli of clis) {
    if ((await io.run([cli, "--install-extension", vsix, "--force"])) === 0) {
      log.ok(`vscode extension ${release.tag} installed into ${cli}`);
      editors.push(cli);
    } else {
      log.warn(`${cli} refused the extension`);
    }
  }

  // Only when something took it: recording a refused install would
  // report the editor as current and never retry.
  if (editors.length > 0) {
    await writeRecord({ vscode: { tag: release.tag, editors, id: EXTENSION_ID } });
  }
}

/**
 * Install the published herdr plugin.
 *
 * herdr fetches the plugin directory and its build hook materializes the
 * released bundle over the entry, so nothing local is needed and nothing
 * is built. The tag is pinned rather than left implicit: unpinned, herdr
 * reads the default branch, whose manifest can name a bundle no release
 * has published yet.
 *
 * It ends with a key bound to it. An installed plugin herdr gives no
 * shortcut to is one nobody opens.
 */
export async function installHerdrPlugin(
  p: Platform,
  io: ExtIo = defaultIo(),
  resolved?: GhRelease,
): Promise<void> {
  if (!io.hasHerdr()) {
    log.skip("herdr plugin: herdr is not installed");
    return;
  }

  const release = resolved ?? (await resolveOrWarn(io, HERDR_BUNDLE_ASSET, "herdr plugin"));
  if (!release) return;

  log.step(`herdr plugin: installing ${release.tag} from the published release`);
  const code = await io.run([
    "herdr",
    "plugin",
    "install",
    HERDR_PLUGIN_SOURCE,
    "--ref",
    release.tag,
    "--yes",
  ]);
  if (code !== 0) {
    log.warn(`herdr plugin: herdr refused the install (exit ${code})`);
    log.skip("herdr plugin: left as it is — the rest of the converge continues");
    return;
  }

  log.ok(`herdr plugin ${release.tag} installed`);
  await writeRecord({ herdr: { tag: release.tag } });
  await bindDashboard(p, io);
}

/**
 * Advance whichever of the two is installed and behind the release.
 *
 * Only what is already there. Both are optional, and `update` advancing
 * a machine into software it never asked for would be a worse bug than
 * the staleness this fixes — so absence is left alone and presence is
 * kept current.
 *
 * The comparison is against the release tag, not against a checkout.
 * That is the whole difference this slice makes: a machine with no
 * source tree is now a machine that can still answer "is it current?".
 */
export async function refreshRedSkillsExtensions(
  p: Platform,
  io: ExtIo = defaultIo(),
): Promise<void> {
  const record = readRecord();

  if ((await io.editorsWithExtension()).length === 0) {
    log.skip("vscode extension: not installed, left alone");
  } else {
    const release = await resolveOrWarn(io, VSIX_ASSET, "vscode extension");
    if (release && record.vscode?.tag === release.tag) {
      log.skip(`vscode extension already at ${release.tag}`);
    } else if (release) {
      log.step(`vscode extension: installing ${release.tag}`);
      await installVscodeExtension(io, release);
    }
  }

  if (!(await io.herdrHasPlugin())) {
    log.skip("herdr plugin: not installed, left alone");
  } else {
    const release = await resolveOrWarn(io, HERDR_BUNDLE_ASSET, "herdr plugin");
    if (release && record.herdr?.tag === release.tag) {
      log.skip(`herdr plugin already at ${release.tag}`);
    } else if (release) {
      await installHerdrPlugin(p, io, release);
    }
  }
}

/**
 * The binding is a convenience, so it never fails the install — and a
 * running server keeps the old config until it is told otherwise, which
 * is why the reload is asked for rather than left to the next launch.
 */
async function bindDashboard(p: Platform, io: ExtIo): Promise<void> {
  try {
    const { bindHerdrDashboard } = await import("./herdr.ts");
    if (await bindHerdrDashboard(p)) await io.run(["herdr", "server", "reload-config"]);
  } catch (err) {
    log.warn(`herdr keybinding: ${(err as Error).message}`);
  }
}

// ------------------------------------------------------------ uninstalling

/**
 * Take back exactly what this path put there, and nothing beside it.
 *
 * Driven by the record, so a machine red-dev never installed these on
 * has nothing removed from it — the same rule the rest of the uninstall
 * follows, applied to two artifacts no probe can speak for.
 *
 * The generated keybinding goes with the plugin, because it is a block
 * this project wrote and it invokes a plugin that is about to stop
 * existing. Nothing else in herdr's config is touched: that is where the
 * operator's own keys live.
 */
export async function uninstallVscodeExtension(io: ExtIo = defaultIo()): Promise<string[]> {
  const entry = readRecord().vscode;
  if (!entry) return [];

  const id = entry.id ?? EXTENSION_ID;
  const removed: string[] = [];
  for (const cli of entry.editors ?? []) {
    if ((await io.run([cli, "--uninstall-extension", id])) === 0) removed.push(`${id} (${cli})`);
    else log.warn(`${cli} could not remove ${id}`);
  }

  rmSync(assetCache(), { recursive: true, force: true });
  await forgetRecord("vscode");
  return removed;
}

export async function uninstallHerdrPlugin(
  p: Platform,
  io: ExtIo = defaultIo(),
): Promise<string[]> {
  const entry = readRecord().herdr;
  if (!entry) return [];

  const removed: string[] = [];
  if ((await io.run(["herdr", "plugin", "uninstall", PLUGIN_ID])) === 0) removed.push(PLUGIN_ID);
  else log.warn(`herdr could not remove ${PLUGIN_ID}`);

  try {
    const { unbindHerdrDashboard } = await import("./herdr.ts");
    if (await unbindHerdrDashboard(p)) {
      removed.push("herdr prefix+d binding");
      await io.run(["herdr", "server", "reload-config"]);
    }
  } catch (err) {
    log.warn(`herdr keybinding: ${(err as Error).message}`);
  }

  await forgetRecord("herdr");
  return removed;
}
