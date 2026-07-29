/**
 * ble.sh — autosuggestions and syntax highlighting for bash.
 *
 * These are the two features people most often say they miss when they
 * leave zsh, and ble.sh is the only credible bash answer. It is not on
 * by default, and the reason is specific rather than cautious:
 *
 * red-dev already ships atuin (which binds Ctrl-R and `?`), fzf (Ctrl-R,
 * Ctrl-T, Alt-C) and carapace (1500-odd completions). ble.sh does not
 * sit alongside bash's line editor — it replaces it. Whether those three
 * survive that replacement is an empirical question, and it can only be
 * answered from a real terminal session. Defaulting it on would mean
 * shipping an unverified change to every user's line editor.
 *
 * So: opt in with RED_BLE=1, confirm Ctrl-R still reaches atuin, and the
 * default flips. That flip is one line in config/bash/rc.sh.
 *
 * Upstream also has no stable tag — the current release is
 * 0.4.0-devel3 — which is worth knowing before making it mandatory.
 */

import { existsSync, mkdirSync } from "node:fs";
import { log, RedError } from "./log.ts";

function home(): string {
  const h = process.env["HOME"];
  if (!h) throw new RedError("HOME is not set");
  return h;
}

export function bleshDir(): string {
  return `${home()}/.local/share/blesh`;
}

export function isInstalled(): boolean {
  return existsSync(`${bleshDir()}/ble.sh`);
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  if ((await proc.exited) !== 0) throw new RedError(`${cmd[0]} failed`);
}

/**
 * Install ble.sh from the upstream release.
 *
 * The asset is .tar.xz and contains a versioned directory, so this does
 * not go through the gh: provider: that provider installs executables
 * into /usr/local/bin, and ble.sh is a tree of shell sources that has to
 * live in the user's own data directory.
 */
export async function installBlesh(): Promise<void> {
  if (isInstalled()) {
    log.skip("ble.sh already installed");
    return;
  }

  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  const token = process.env["GITHUB_TOKEN"];
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(
    "https://api.github.com/repos/akinomyoga/ble.sh/releases/latest",
    { headers },
  );
  if (!res.ok) throw new RedError(`GitHub API ${res.status} for akinomyoga/ble.sh`);

  const body = (await res.json()) as {
    tag_name?: string;
    assets?: { name: string; browser_download_url: string }[];
  };
  // Match the archive, not the .sha or the -2 variant suffix ordering.
  const asset = (body.assets ?? []).find((a) => /^ble-.*\.tar\.xz$/.test(a.name));
  if (!asset) {
    throw new RedError(
      "no ble-*.tar.xz in the latest ble.sh release. Available:\n" +
        (body.assets ?? []).map((a) => `  ${a.name}`).join("\n"),
    );
  }

  log.step(`ble.sh: ${asset.name}`);
  const tmp = `/tmp/red-dev-blesh`;
  await run(["rm", "-rf", tmp]);
  mkdirSync(tmp, { recursive: true });

  const dl = await fetch(asset.browser_download_url);
  if (!dl.ok) throw new RedError(`ble.sh download failed ${dl.status}`);
  await Bun.write(`${tmp}/ble.tar.xz`, dl);

  await run(["tar", "-xJf", `${tmp}/ble.tar.xz`, "-C", tmp]);

  // The archive unpacks to ble-<version>/; find it rather than
  // reconstructing the name from the tag, which carries a -N suffix the
  // directory does not.
  const listing = Bun.spawnSync(["sh", "-c", `find ${tmp} -maxdepth 1 -type d -name 'ble-*'`]);
  const dir = new TextDecoder().decode(listing.stdout).trim().split("\n")[0];
  if (!dir) throw new RedError("ble.sh archive did not contain a ble-* directory");

  const dest = bleshDir();
  await run(["rm", "-rf", dest]);
  mkdirSync(dest, { recursive: true });
  await run(["sh", "-c", `cp -r "${dir}"/* "${dest}/"`]);
  await run(["rm", "-rf", tmp]);

  log.ok(`ble.sh installed to ${dest}`);
  log.plain("     Enable it with: export RED_BLE=1   (then open a new shell)");
  log.plain("     Check that Ctrl-R still reaches atuin before relying on it.");
}
