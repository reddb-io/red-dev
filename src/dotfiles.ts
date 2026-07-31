/**
 * Shell configuration deployment.
 *
 * This is the layer that actually delivers "same experience" — the
 * aliases that normalise Debian's renames, the prompt, the PATH
 * handling that keeps WSL interop alive. Installing tools without it
 * produces a machine with the right binaries and none of the feel.
 *
 * The files travel inside the binary as text imports rather than being
 * read from a checkout, because the normal way to get red-dev is to
 * download one executable. Verified to survive `bun build --compile`
 * before anything was built on top of it; see scripts/embed-smoke.ts.
 */

import { existsSync, mkdirSync } from "node:fs";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";

import rcSh from "../config/bash/rc.sh" with { type: "text" };
import pathSh from "../config/bash/path.sh" with { type: "text" };
import initSh from "../config/bash/init.sh" with { type: "text" };
import aliasesSh from "../config/bash/aliases.sh" with { type: "text" };
import functionsSh from "../config/bash/functions.sh" with { type: "text" };
import promptSh from "../config/bash/prompt.sh" with { type: "text" };
import sharedSh from "../config/bash/shared.sh" with { type: "text" };
import inputrc from "../config/bash/inputrc.conf" with { type: "text" };
import zellijConfig from "../config/zellij/config.kdl" with { type: "text" };

/** Exported so `doctor` can compare what is deployed against what this
 * binary would deploy — an upgraded red-dev with stale files on disk is
 * invisible otherwise. */
export const FILES: Record<string, string> = {
  "rc.sh": rcSh,
  "path.sh": pathSh,
  "init.sh": initSh,
  "aliases.sh": aliasesSh,
  "functions.sh": functionsSh,
  "prompt.sh": promptSh,
  "shared.sh": sharedSh,
  // Deployed without the .conf suffix: the repo needs an extension for
  // the text import to resolve, readline does not care what it is
  // called, and INPUTRC points straight at it.
  inputrc: inputrc,
};

/** The line we add to the user's shell rc, and the marker we look for. */
const SOURCE_LINE = "source ~/.local/share/red-dev/config/bash/rc.sh";
const MARKER = "red-dev/config/bash/rc.sh";

function home(): string {
  // Native Windows sets USERPROFILE, not HOME. Git Bash then sets HOME
  // to the same place, so deploying against USERPROFILE puts the files
  // exactly where the shell that reads them will look.
  const h = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!h) throw new Error("neither HOME nor USERPROFILE is set");

  // Normalised to forward slashes. Every path built from this is joined
  // with "/", so a Windows HOME produced `C:\Users\filip/.local/...` —
  // which works, because Windows accepts both, but reads as a mistake
  // in every log line. The files are read by Git Bash, whose own paths
  // are POSIX-style, so one separator throughout is also the more
  // correct answer.
  return h.replace(/\\/g, "/");
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  if (existsSync(path)) {
    const current = await Bun.file(path).text();
    if (current === content) return false;
  }
  await Bun.write(path, content);
  return true;
}

/**
 * Append our source line to ~/.bashrc rather than replacing the file.
 *
 * A shell rc is the user's, and it commonly holds work they care about
 * more than anything we are installing. Appending — after a backup, and
 * only when our marker is absent — keeps a re-run harmless and keeps a
 * pre-existing configuration intact.
 */
async function wireShellRc(): Promise<void> {
  const bashrc = `${home()}/.bashrc`;
  const existing = existsSync(bashrc) ? await Bun.file(bashrc).text() : "";

  if (existing.includes(MARKER)) {
    log.skip("~/.bashrc already sources red-dev");
    return;
  }

  if (existing.length > 0) {
    await Bun.write(`${bashrc}.red-dev-backup`, existing);
    log.step(`backed up ~/.bashrc to ~/.bashrc.red-dev-backup`);
  }

  const block = [
    existing.trimEnd(),
    "",
    "# Added by red-dev. Remove this line to opt out; the files stay in",
    "# ~/.local/share/red-dev and nothing else in this file was touched.",
    SOURCE_LINE,
    "",
  ].join("\n");

  await Bun.write(bashrc, block);
  log.ok("~/.bashrc now sources red-dev");
}

export async function installDotfiles(p: Platform): Promise<void> {
  const dest = `${home()}/.local/share/red-dev/config/bash`;
  // node:fs rather than shelling out to mkdir, which native Windows
  // does not have. Git Bash understands the forward-slash HOME it
  // reports, so the path itself needs no translation.
  mkdirSync(dest, { recursive: true });

  let changed = 0;
  for (const [name, content] of Object.entries(FILES)) {
    if (await writeIfChanged(`${dest}/${name}`, content)) changed++;
  }

  if (changed > 0) {
    log.ok(`dotfiles: ${changed} file(s) written to ${dest}`);
  } else {
    log.skip("dotfiles already current");
  }

  await wireShellRc();
  await installZellijConfig(p);
  await wireDelta();
  await primeTldr();
}

/**
 * tealdeer ships no pages: a fresh install answers every query with
 * "Page cache not found". The cache is per-user, so this runs as part
 * of the user's dotfiles rather than at package-install time.
 */
async function primeTldr(): Promise<void> {
  const tldr = Bun.which("tldr");
  if (!tldr) return;

  // --list is cheap and fails when the cache is absent, which is a
  // better test than looking for a directory whose path varies.
  const probe = Bun.spawn([tldr, "--list"], { stdout: "ignore", stderr: "ignore" });
  if ((await probe.exited) === 0) {
    log.skip("tldr pages already cached");
    return;
  }

  log.step("tldr: downloading page cache");
  const update = Bun.spawn([tldr, "--update"], { stdout: "ignore", stderr: "ignore" });
  if ((await update.exited) === 0) log.ok("tldr pages cached");
  else log.warn("tldr cache download failed; run `tldr --update` yourself");
}

async function gitConfig(key: string): Promise<string> {
  const proc = Bun.spawn(["git", "config", "--global", "--get", key], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function setGitConfig(key: string, value: string): Promise<void> {
  const proc = Bun.spawn(["git", "config", "--global", key, value], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

/**
 * Point git at delta.
 *
 * Installing the binary accomplishes nothing on its own: delta is a
 * pager, and git only uses it once told to. The keys are set only when
 * the pager is unset or already delta — someone who has deliberately
 * chosen `less -FRX` or diff-so-fancy keeps it.
 */
async function wireDelta(): Promise<void> {
  if (!Bun.which("delta")) return;

  const pager = await gitConfig("core.pager");
  if (pager && !pager.includes("delta")) {
    log.skip(`git pager is '${pager}' — leaving it alone`);
    return;
  }

  await setGitConfig("core.pager", "delta");
  await setGitConfig("interactive.diffFilter", "delta --color-only");
  await setGitConfig("delta.navigate", "true");
  await setGitConfig("delta.line-numbers", "true");
  // zdiff3 shows the common ancestor in a conflict, which turns most
  // "which side was right" questions into a glance.
  await setGitConfig("merge.conflictStyle", "zdiff3");
  await setGitConfig("diff.colorMoved", "default");
  log.ok("git configured to use delta");
}

/**
 * Written once, never rewritten. The theme file next to it is
 * regenerated on every switch, but keybindings and layout preferences
 * are the user's.
 */
async function installZellijConfig(p: Platform): Promise<void> {
  const dir = `${home()}/.config/zellij`;
  const path = `${dir}/config.kdl`;

  // The config references theme "red-dev", so that theme has to exist
  // even when the theme step has not run or failed. Writing a default
  // here means the reference always resolves; a later theme switch
  // overwrites this file with the chosen palette.
  const { THEMES, DEFAULT_THEME } = await import("./themes.ts");
  const fallback = THEMES[DEFAULT_THEME];
  if (fallback && !existsSync(`${dir}/themes/red-dev.kdl`)) {
    const { applyZellij } = await import("./theme-apply.ts");
    await applyZellij(fallback, p);
  }

  if (existsSync(path)) {
    log.skip("zellij config exists — left alone");
    return;
  }
  mkdirSync(dir, { recursive: true });
  await Bun.write(path, zellijConfig);
  log.ok(`zellij config written to ${path}`);
}
