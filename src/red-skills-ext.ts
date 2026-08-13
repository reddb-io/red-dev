/**
 * The two red-skills extensions the installer does not touch.
 *
 * `scripts/install.sh` wires Claude, Codex and OpenCode and stops there.
 * The VS Code extension and the herdr plugin live in the same monorepo
 * and are installed by hand, which means in practice they are not
 * installed at all.
 *
 * Both need the source tree that red-skills already keeps at
 * ~/.red-skills/current, and both need its workspace dependencies. That
 * install is a large one — a 165 KB lockfile and a turbo workspace — so
 * it happens only when one of these is actually asked for, never as a
 * side effect of converging something else.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";

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
 * The symlink is the only thing that moves — the versions beneath it
 * are immutable, so the resolved path is the whole freshness question
 * for anything built out of the tree.
 */
export function resolvedSource(): string | null {
  const root = sourceRoot();
  return root === null ? null : realpathSync(root);
}

/**
 * Which checkout each artifact was last built from.
 *
 * Neither artifact carries the red-skills version: the extension's own
 * package.json says 0.1.0 and stayed 0.1.0 across every release, and
 * the herdr plugin's manifest says 0.1.0 too. Asking the editor or
 * herdr what version it has answers a question about the artifact and
 * not about the source it came from, so the build records the source
 * itself. Comparing that to where `current` points now is the only
 * signal that does not lie.
 */
export interface BuildStamp {
  vscode?: string;
  herdr?: string;
}

/** Computed rather than a constant: the tests move HOME between cases. */
function stampPath(): string {
  return `${home()}/.local/share/red-dev/red-skills-built.json`;
}

export function readStamp(): BuildStamp {
  const path = stampPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BuildStamp;
  } catch {
    // A stamp we cannot read means "rebuild", which is the safe way to
    // be wrong: the cost is one rebuild, not a permanently stale editor.
    return {};
  }
}

export async function recordBuild(which: keyof BuildStamp): Promise<void> {
  const source = resolvedSource();
  if (source === null) return;
  const path = stampPath();
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Bun.write(path, `${JSON.stringify({ ...readStamp(), [which]: source }, null, 2)}\n`);
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

const EXTENSION_ID = "reddb-io.vscode-redskilled";
const PLUGIN_ID = "reddb-io.red-skills";

/** Editors that already have the extension, which are the ones to refresh. */
async function editorsWithExtension(): Promise<string[]> {
  const found: string[] = [];
  for (const cli of vscodeClis()) {
    if ((await capture([cli, "--list-extensions"])).includes(EXTENSION_ID)) found.push(cli);
  }
  return found;
}

/** Does herdr already know the plugin? */
async function herdrHasPlugin(): Promise<boolean> {
  if (!Bun.which("herdr")) return false;
  return (await capture(["herdr", "plugin", "list"])).includes(PLUGIN_ID);
}

/**
 * Rebuild whichever of the two is installed and behind the checkout.
 *
 * Only what is already there. Both are optional, and `update` advancing
 * a machine into software it never asked for would
 * be a worse bug than the staleness this fixes — so absence is left
 * alone and presence is kept current.
 */
export async function refreshRedSkillsExtensions(p: Platform): Promise<void> {
  const source = resolvedSource();
  if (source === null) return;
  const stamp = readStamp();
  const version = source.split("/").pop();

  if ((await editorsWithExtension()).length === 0) {
    log.skip("vscode extension: not installed, left alone");
  } else if (stamp.vscode === source) {
    log.skip(`vscode extension already built from ${version}`);
  } else {
    log.step(`vscode extension: rebuilding against ${version}`);
    await installVscodeExtension();
  }

  if (!(await herdrHasPlugin())) {
    log.skip("herdr plugin: not installed, left alone");
  } else if (stamp.herdr === source) {
    log.skip(`herdr plugin already installed from ${version}`);
  } else {
    log.step(`herdr plugin: reinstalling against ${version}`);
    await installHerdrPlugin(p);
  }
}

async function sh(cmd: string[], cwd?: string): Promise<number> {
  const { spawnLogged } = await import("./providers.ts");
  return await spawnLogged(cmd, cwd ? { cwd } : {});
}

/**
 * Make sure the workspace can build.
 *
 * Separated so both callers pay for it once and only when needed. pnpm
 * comes from mise on every target red-dev sets up, so a missing one is a
 * broken converge rather than a reason to install node.
 */
async function prepareWorkspace(root: string): Promise<void> {
  if (existsSync(`${root}/node_modules`)) {
    log.skip("red-skills workspace already prepared");
    return;
  }
  if (!Bun.which("pnpm")) {
    throw new RedError("pnpm is not on PATH — run `red-dev install core` first");
  }
  log.step("red-skills: installing workspace dependencies (this is the slow part)");
  if ((await sh(["pnpm", "install", "--frozen-lockfile"], root)) !== 0) {
    throw new RedError("pnpm install failed in the red-skills workspace");
  }
}

/** Every VS Code-family CLI on this machine. */
export function vscodeClis(): string[] {
  return ["code", "codium", "cursor"].filter((c) => Bun.which(c));
}

/**
 * Build the extension and install it into each editor present.
 *
 * The .vsix is never published — red-skills builds it from
 * src/packaging/vsix.ts rather than pulling in vsce — so there is no
 * download to prefer over this. Installed into every editor found,
 * because a machine with both VS Code and VSCodium wants it in the one
 * being used, and asking which is a question with no good default.
 */
export async function installVscodeExtension(): Promise<void> {
  const clis = vscodeClis();
  if (clis.length === 0) {
    log.skip("vscode extension: no VS Code-family editor installed");
    return;
  }

  const root = sourceRoot();
  if (!root) {
    log.skip("vscode extension: red-skills is not installed");
    return;
  }

  await prepareWorkspace(root);

  const app = `${root}/apps/vscode-redskilled`;
  log.step("vscode extension: building");
  if ((await sh(["pnpm", "-C", app, "build"], root)) !== 0) {
    throw new RedError("the vscode extension failed to build");
  }
  if ((await sh(["pnpm", "-C", app, "package"], root)) !== 0) {
    throw new RedError("the vscode extension failed to package");
  }

  // The repo root, not the app directory. `pnpm -C apps/... package`
  // writes to dist/ at the workspace root — checked rather than assumed,
  // after looking in the obvious place and finding nothing.
  const glob = new Bun.Glob("*.vsix");
  const found = [
    ...glob.scanSync({ cwd: `${root}/dist`, absolute: true }),
    ...(existsSync(`${app}/dist`)
      ? glob.scanSync({ cwd: `${app}/dist`, absolute: true })
      : []),
  ].sort();
  const vsix = found.pop();
  if (!vsix) throw new RedError(`the build wrote no .vsix under ${root}/dist`);

  // Handed over with the symlink resolved.
  //
  // These editors are Windows programs even when invoked from a distro:
  // they translate the path to \\wsl.localhost\... and open it over 9P,
  // where the `current` symlink does not survive. VS Code has WSL
  // integration and coped; VSCodium reported ENOENT on a file that
  // plainly existed. The real path works in both.
  const real = realpathSync(vsix);

  let installed = 0;
  for (const cli of clis) {
    if ((await sh([cli, "--install-extension", real, "--force"])) === 0) {
      log.ok(`vscode extension installed into ${cli}`);
      installed++;
    } else {
      log.warn(`${cli} refused the extension`);
    }
  }
  // Only when something took it: stamping a refused install would
  // report the editor as current and never retry.
  if (installed > 0) await recordBuild("vscode");
}

/**
 * Install the herdr plugin.
 *
 * From GitHub when herdr can do it, which needs nothing local. That path
 * has been seen to fail on a machine whose plugin has to be built after
 * fetching, so the fallback is the one the plugin's own README
 * documents: prepare the workspace and link the directory.
 *
 * Either way it ends with a key bound to it. An installed plugin herdr
 * gives no shortcut to is one nobody opens.
 */
export async function installHerdrPlugin(p: Platform): Promise<void> {
  if (!Bun.which("herdr")) {
    log.skip("herdr plugin: herdr is not installed");
    return;
  }

  log.step("herdr plugin: installing from GitHub");
  const remote = await sh([
    "herdr",
    "plugin",
    "install",
    "reddb-io/red-skills/apps/herdr-plugin",
    "--yes",
  ]);
  if (remote === 0) {
    log.ok("herdr plugin installed from reddb-io/red-skills");
    await recordBuild("herdr");
    await bindDashboard(p);
    return;
  }

  const root = sourceRoot();
  if (!root) {
    log.warn("herdr plugin: remote install failed and red-skills is not installed locally");
    return;
  }

  log.step("herdr plugin: remote install failed — linking the local checkout instead");
  await prepareWorkspace(root);
  if ((await sh(["herdr", "plugin", "link", `${root}/apps/herdr-plugin`])) !== 0) {
    throw new RedError("herdr refused to link the plugin");
  }
  log.ok("herdr plugin linked from the red-skills checkout");
  await recordBuild("herdr");
  await bindDashboard(p);
}

/**
 * The binding is a convenience, so it never fails the install — and a
 * running server keeps the old config until it is told otherwise, which
 * is why the reload is asked for rather than left to the next launch.
 */
async function bindDashboard(p: Platform): Promise<void> {
  try {
    const { bindHerdrDashboard } = await import("./herdr.ts");
    if (await bindHerdrDashboard(p)) await sh(["herdr", "server", "reload-config"]);
  } catch (err) {
    log.warn(`herdr keybinding: ${(err as Error).message}`);
  }
}
