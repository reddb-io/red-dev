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
// The one removal this file does not write itself, because the three
// things it undoes are one act. ssh-access.ts imports the `Removal` type
// back from here, which is type-only and erased — there is no cycle at
// run time.
import { sshAccessRemoval } from "./ssh-access.ts";

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

    case "mise":
      // mise knows precisely what it installed, so this is the one
      // removal that needs no guessing about paths. Uninstalling the
      // tool leaves the [tools] line in the generated fragment, and the
      // next converge would reinstall it — correct, and the same thing
      // apt does when a package is still in the manifest.
      return {
        tool: tool.name,
        how: `mise uninstall ${pr.alias ?? pr.spec}`,
        run: () => sh(["mise", "uninstall", pr.alias ?? pr.spec]),
      };

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
      // red-dev is in the manifest so that mise keeps it current, not so
      // that it can be ticked out of a list alongside jq. Removing it is
      // what `red-dev uninstall` is, and offering it here would put the
      // whole product one keystroke away inside a menu about tools.
      if (tool.name === "red-dev") continue;
      const removal = removalFor(tool, p);
      if (removal) out.push({ tool, removal });
    }
  }

  // The SSH server, which the loop above cannot reach: it is `managed`,
  // so nothing probes for it, and its provider is a builtin, so
  // `removalFor` has no package to name. It is also the one item here
  // whose removal has three clauses instead of one — the service, the
  // firewall rule and the authorized keys go together, because reverting
  // two of the three leaves a machine still listening for a key that is
  // gone, or still holding a key for a service that is.
  //
  // Offered unconditionally, unlike everything above it: every converge
  // opens this port, so there is no machine red-dev has touched where
  // the question does not apply, and the revert is a no-op on one it has
  // not. See src/ssh-access.ts.
  const ssh = toolsInScope("core").find((tool) => tool.name === "ssh-server");
  if (ssh) out.push({ tool: ssh, removal: sshAccessRemoval(p) });
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
    // Its sibling, and named separately for the same reason: the script
    // that lets red-dev repaint a desktop without flashing a console
    // sits beside the images rather than in them, so removing the
    // directory does not reach it.
    const { removeCustomWallpapers, removeHiddenRunner } = await import("./wallpaper.ts");
    const custom = await removeCustomWallpapers(p);
    if (custom) removed.push(custom);
    const runner = await removeHiddenRunner(p);
    if (runner) removed.push(runner);
  } catch (err) {
    log.warn(`redwall: ${(err as Error).message}`);
  }

  // Before the images and the roots would not be wrong, but after them
  // is: a timer left enabled outlives everything else here, and it fires
  // a binary that is about to stop existing. Isolated for the same
  // reason the images above are — a user manager that cannot be reached
  // is still a machine whose dotfiles must come out.
  try {
    const { removeRedwallSchedule } = await import("./redwall-schedule.ts");
    removed.push(...(await removeRedwallSchedule(p)).removed);
  } catch (err) {
    log.warn(`redwall schedule: ${(err as Error).message}`);
  }

  const targets = [
    `${home}/.local/share/red-dev`,
    `${home}/.config/red-dev`,
    // What Windows answered when it was last asked. Cheap to rebuild and
    // meaningless without red-dev, so it goes with everything else that
    // only this tool ever reads.
    `${home}/.cache/red-dev`,
    `${home}/.config/zellij/themes/red-dev.kdl`,
    // The mise fragment. Generated by red-dev, headed "Do not edit",
    // and listing tools that are about to stop existing — leaving it
    // behind would make `mise upgrade` keep reinstalling a suite the
    // machine no longer has. The user's own ~/.config/mise/config.toml
    // is untouched, here as everywhere else.
    `${home}/.config/mise/conf.d/10-reddb-io.toml`,
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
