/**
 * Removing what red-dev installed.
 *
 * omakub ships 39 uninstall scripts, one per application. This inverts
 * the provider instead: a tool installed by apt is removed by apt, one
 * from a GitHub release is the binary that was placed in
 * /usr/local/bin, one from winget is a winget uninstall. The manifest
 * already knows which is which, so a per-tool script would be 39 copies
 * of information that exists once.
 *
 * Two rules, because this is the only part of the tool that destroys
 * things:
 *
 *  - Nothing runs without an explicit confirmation naming what will go.
 *  - Configuration is never removed as a side effect of removing a
 *    binary. Someone uninstalling zellij to try a different multiplexer
 *    does not want their theme deleted, and there is no undo.
 */

import { existsSync } from "node:fs";
import { log, RedError } from "./log.ts";
import { providerFor, toolsInScope, isPresent, type Tool } from "./manifest.ts";
import type { Platform } from "./platform.ts";

export interface Removal {
  tool: string;
  how: string;
  run: () => Promise<void>;
}

async function sh(cmd: string[], opts: { allowFailure?: boolean } = {}): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  const code = await proc.exited;
  if (code !== 0 && !opts.allowFailure) {
    throw new RedError(`${cmd[0]} exited ${code}`);
  }
}

/**
 * How to undo one tool, or null when this project did not put it there
 * and therefore should not take it away.
 */
export function removalFor(tool: Tool, p: Platform): Removal | null {
  const pr = providerFor(tool, p);

  switch (pr.kind) {
    case "apt":
      return {
        tool: tool.name,
        how: `apt remove ${pr.pkg}`,
        run: () => sh(["sudo", "apt-get", "remove", "-y", pr.pkg]),
      };

    case "aptrepo":
      return {
        tool: tool.name,
        how: `apt remove ${pr.pkgs.join(" ")}`,
        // The repository and its key stay. Removing docker should not
        // silently break an apt update that another package depends on.
        run: () => sh(["sudo", "apt-get", "remove", "-y", ...pr.pkgs]),
      };

    case "ppa":
      return {
        tool: tool.name,
        how: `apt remove ${tool.name}`,
        run: () => sh(["sudo", "apt-get", "remove", "-y", tool.name]),
      };

    case "winget":
      return {
        tool: tool.name,
        how: `winget uninstall ${pr.id}`,
        run: () =>
          sh(
            process.platform === "win32"
              ? ["cmd.exe", "/c", "winget", "uninstall", "--id", pr.id, "--exact", "--silent"]
              : ["winget.exe", "uninstall", "--id", pr.id, "--exact", "--silent"],
          ),
      };

    case "gh": {
      // Installed as a bare binary; the manifest's own command names are
      // what to look for.
      const names = tool.cmd ?? [tool.name];
      const found = names
        .map((n) => `/usr/local/bin/${n}`)
        .filter((path) => existsSync(path));
      if (found.length === 0) return null;
      return {
        tool: tool.name,
        how: `rm ${found.join(" ")}`,
        run: () => sh(["sudo", "rm", "-f", ...found]),
      };
    }

    case "installer":
      // A vendor script owns its own layout and usually ships its own
      // uninstaller. Guessing which files it wrote is how you delete
      // something else.
      return null;

    case "builtin":
    case "skip":
      return null;
  }
}

/** Everything removable, for the selection list. */
export function removableTools(p: Platform): { tool: Tool; removal: Removal }[] {
  const out: { tool: Tool; removal: Removal }[] = [];
  for (const scope of ["core", "desktop", "wsl", "optional"] as const) {
    for (const tool of toolsInScope(scope)) {
      // isPresent, not isInstalled: a tool below its version floor is
      // still on disk, and still the user's to remove.
      if (tool.managed || !isPresent(tool)) continue;
      const removal = removalFor(tool, p);
      if (removal) out.push({ tool, removal });
    }
  }
  return out;
}

/**
 * Remove red-dev's own configuration.
 *
 * Separate from removing tools and never bundled with it: these are the
 * files that carry someone's choices, and the two are different
 * intentions. The shipped dotfiles go; the `.bashrc` line is removed;
 * the pre-red-dev backup is left exactly where it is, because that is
 * the only copy of what was there before.
 *
 * The generated Redwalls go too, and they need the platform to be found
 * at all: on WSL the images live on the Windows disk, so none of the
 * paths below covers them and a machine uninstalled from WSL would keep
 * every 4K PNG it ever generated, under content-addressed names nothing
 * left on the machine could explain.
 */
export async function removeConfiguration(p: Platform): Promise<string[]> {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!home) throw new RedError("neither HOME nor USERPROFILE is set");

  const removed: string[] = [];

  // Before the roots below, not after. Off WSL the Redwall directory
  // sits inside `~/.local/share/red-dev`, and removing the root first
  // would delete the images without ever being able to say it had.
  //
  // Isolated, because finding this directory on WSL asks Windows where
  // LocalAppData is, and a machine where that question fails is still a
  // machine whose dotfiles and shell hook must come out.
  try {
    const { removeRedwall } = await import("./redwall.ts");
    const dir = await removeRedwall(p);
    if (dir) removed.push(dir);
  } catch (err) {
    log.warn(`redwall: ${(err as Error).message}`);
  }

  const targets = [
    `${home}/.local/share/red-dev`,
    `${home}/.config/red-dev`,
    `${home}/.config/zellij/themes/red-dev.kdl`,
  ];

  for (const path of targets) {
    if (existsSync(path)) {
      await sh(["rm", "-rf", path], { allowFailure: true });
      removed.push(path);
    }
  }

  // Unhook the shell without rewriting a file we do not own: drop only
  // the lines this project added.
  const bashrc = `${home}/.bashrc`;
  if (existsSync(bashrc)) {
    const body = await Bun.file(bashrc).text();
    const cleaned = body
      .split("\n")
      .filter((l) => !l.includes("red-dev/config/bash/rc.sh") && !l.includes("Managed by red-dev"))
      .join("\n");
    if (cleaned !== body) {
      await Bun.write(bashrc, cleaned);
      removed.push(`${bashrc} (red-dev lines)`);
    }
  }

  log.plain("");
  log.skip("Left in place: the pre-red-dev backup of your shell config,");
  log.skip("your Alacritty and zellij configs, and every installed tool.");

  return removed;
}
