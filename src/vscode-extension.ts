/**
 * A VS Code extension published as a GitHub release asset.
 *
 * red-skills ships its `.vsix` inside the package set, and the vscode
 * companion installs it from there. toon ships its `.vsix` as a release
 * asset instead — `reddb-toon.vsix`, with `SHA256SUMS` beside it — so it
 * needs the download half the companion does not have, and shares the
 * install half it does: the same `caps.gui` rule, the same reachable
 * editors, the same `--install-extension --force`.
 *
 * ## Where it installs, and where it does not
 *
 * Only where there is a display of this machine's own. On WSL the editor
 * that PATH resolves is the *host's*, reached over interop, and handing a
 * Windows `code` a Linux path installs nothing — the exact failure the
 * red-skills companion was caught in. `caps.gui` already draws that line
 * for every other GUI decision; this honours it too, and a half with no
 * display of its own defers to the one that has it.
 *
 * ## What it will not do
 *
 * Reach a package manager. The red-skills companion may install an editor
 * on a clean workstation; this never does. An extension with nowhere to
 * go is a skip naming what a person would do, not an install of a desktop
 * editor to receive it.
 */

import { log } from "./log.ts";
import type { Platform } from "./platform.ts";

/** The repository the toon extension is published from. */
export const TOON_REPO = "reddb-io/toon";
/** The release asset, exactly as the repo names it. */
export const TOON_VSIX_ASSET = "reddb-toon.vsix";
/** What the editors call it once installed. */
export const TOON_EXTENSION_ID = "reddb-io.reddb-toon";

export type VsixOutcome =
  | { outcome: "installed"; editors: string[]; version: string | null }
  | { outcome: "deferred"; reason: string }
  | { outcome: "unreachable"; reason: string }
  | { outcome: "failed"; reason: string };

export interface VsixInstallOptions {
  platform: Platform;
  repo: string;
  asset: string;
  /** The VS Code-family CLIs present, in the editor's own terms. */
  editors: string[];
  /** Why this machine has no display, when it has none. */
  noDisplay: (p: Platform) => string;
  /** Fetch and verify the asset, answering the file path. */
  fetch: (repo: string, asset: string) => Promise<string>;
  /** Resolve one CLI to a runnable path, or null. */
  resolve: (cli: string) => string | null;
  /** Run `<cli> --install-extension <vsix> --force`, answering the code. */
  install: (cliPath: string, vsix: string) => Promise<number>;
}

/**
 * Install the extension into every reachable editor, or say why not.
 *
 * The order of the guards is the argument: no display is not a failure,
 * no editor on a machine that has a display is a deferral, and only an
 * install that was attempted and refused is a failure.
 */
export async function installVsixFromRelease(opts: VsixInstallOptions): Promise<VsixOutcome> {
  if (!opts.platform.caps.gui) {
    return { outcome: "deferred", reason: opts.noDisplay(opts.platform) };
  }
  if (opts.editors.length === 0) {
    return {
      outcome: "deferred",
      reason: "no VS Code-family editor is installed to receive it",
    };
  }

  let vsix: string;
  try {
    vsix = await opts.fetch(opts.repo, opts.asset);
  } catch (err) {
    // A download that could not happen is not a broken machine, the same
    // way an unreachable package set is not — see acquisitionSurface.
    return { outcome: "unreachable", reason: `could not fetch ${opts.asset}: ${(err as Error).message}` };
  }

  const installed: string[] = [];
  const failed: string[] = [];
  for (const cli of opts.editors) {
    const path = opts.resolve(cli) ?? cli;
    const code = await opts.install(path, vsix);
    if (code === 0) installed.push(cli);
    else failed.push(cli);
  }

  if (installed.length === 0) {
    return { outcome: "failed", reason: `every editor refused the extension: ${failed.join(", ")}` };
  }
  return { outcome: "installed", editors: installed, version: vsixTag(opts.asset) };
}

/** The version an asset name carries, when it carries one. PURE. */
export function vsixTag(asset: string): string | null {
  return /-(\d+\.\d+\.\d+[^/]*)\.vsix$/.exec(asset)?.[1] ?? null;
}

/** Say what happened, and only when a person would want to hear it. */
export function announceVsix(label: string, r: VsixOutcome): void {
  switch (r.outcome) {
    case "installed":
      log.ok(`${label}: installed into ${r.editors.join(", ")}`);
      return;
    case "deferred":
      log.skip(`${label}: ${r.reason}`);
      return;
    case "failed":
      log.warn(`${label}: ${r.reason}`);
      return;
    default:
      // unreachable: nothing happened and nothing is wrong.
      return;
  }
}


/** Fetch and verify a release .vsix, answering the local file path. */
export async function fetchReleaseVsix(repo: string, asset: string): Promise<string> {
  const { exactGhReleaseUrl, downloadVerified } = await import("./providers.ts");
  const { tempDir } = await import("./temp.ts");
  const tmp = tempDir(`vsix-${asset}`);
  const dest = `${tmp}/${asset}`;
  await downloadVerified(exactGhReleaseUrl(repo, asset), dest, {
    checksumUrl: exactGhReleaseUrl(repo, "SHA256SUMS"),
  });
  return dest;
}

/**
 * Install the toon extension, resolving every dependency here.
 *
 * The reachable editors, the display rule and the per-editor install all
 * come from the red-skills companion, which already learned each of them
 * the hard way — this is that machinery pointed at a release asset
 * instead of at the package set.
 */
export async function installToonExtension(p: Platform): Promise<VsixOutcome> {
  const { EDITOR_CLIS, noDisplayHere } = await import("./red-skills-companions.ts");
  const { commandPath } = await import("./agents.ts");
  const { spawnLogged } = await import("./providers.ts");

  const editors = EDITOR_CLIS.filter((cli) => commandPath(cli) !== null);
  return await installVsixFromRelease({
    platform: p,
    repo: TOON_REPO,
    asset: TOON_VSIX_ASSET,
    editors: [...editors],
    noDisplay: noDisplayHere,
    fetch: fetchReleaseVsix,
    resolve: (cli) => commandPath(cli),
    install: (cliPath, vsix) =>
      spawnLogged([cliPath, "--install-extension", vsix, "--force"], { timeoutMs: 120_000 }),
  });
}
