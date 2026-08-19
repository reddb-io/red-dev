/**
 * What is left of the release-driven companion install.
 *
 * The VS Code extension and the herdr plugin were resolved here from the
 * newest GitHub release and installed with it — a converge asked GitHub
 * what the current tag was, downloaded the asset and handed it to an
 * editor. ADR 0014 ends that: both artifacts come out of the package set
 * the agent hosts are reconciled against (src/red-skills-companions.ts),
 * because a release resolved at converge time is precisely how a machine
 * ends up with hosts on one revision and an editor extension on another,
 * and because nothing resolved over the network can be installed on an
 * air-gapped target.
 *
 * Two things stayed. `resolvedSource` answers where the set is, which is
 * the question this module has always owned and which half the repo asks
 * it. And the uninstall reads the record the old path wrote, so a machine
 * converged before ADR 0014 can still have exactly what red-dev installed
 * on it taken back off — driven by that record and by nothing weaker,
 * because both tools are `managed` and an uninstall on the evidence that
 * an extension exists would be removing somebody else's.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";
import {
  companionAssetCache,
  EXTENSION_ID,
  LEGACY_EXTENSION_ID,
  PLUGIN_ID,
} from "./red-skills-companions.ts";
import { redSkillsCurrentPosix } from "./red-skills-root.ts";

export { EXTENSION_ID, LEGACY_EXTENSION_ID, PLUGIN_ID };

function home(): string {
  const h = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!h) throw new RedError("neither HOME nor USERPROFILE is set");
  return h.replace(/\\/g, "/");
}

/** The red-skills checkout, or null when red-skills was never installed. */
export function sourceRoot(): string | null {
  const root = redSkillsCurrentPosix(home());
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

/**
 * Where the release path's downloads landed.
 *
 * Named once, in the module that now sweeps it: the companion walk prunes
 * everything in there that no retained revision could still want, and an
 * uninstall driven by the old record takes the rest.
 */
export function assetCache(): string {
  return companionAssetCache(home());
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
 * The one thing here that still leaves the process.
 *
 * An object rather than a module-level function, so a test can assert
 * what an uninstall *does* — which commands ran, what the record says
 * afterwards — without an editor or a herdr on the machine.
 */
export interface ExtIo {
  /** Run a command and hand back its exit code, never a throw. */
  run(cmd: string[]): Promise<number>;
}

export function defaultIo(): ExtIo {
  return {
    async run(cmd: string[]): Promise<number> {
      const { spawnLogged } = await import("./providers.ts");
      return await spawnLogged(cmd);
    },
  };
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
