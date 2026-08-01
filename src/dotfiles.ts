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
import zellijSh from "../config/bash/zellij.sh" with { type: "text" };
import inputrc from "../config/bash/inputrc.conf" with { type: "text" };
import zellijBase from "../config/zellij/config.kdl" with { type: "text" };

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
  "zellij.sh": zellijSh,
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
 * Every version of this file red-dev has shipped.
 *
 * A config that hashes to one of these is ours and has not been touched,
 * so replacing it loses nothing that anyone chose. Anything else is the
 * user's, and the most a converge may do to it is say so.
 */
const SHIPPED_ZELLIJ_CONFIGS = new Set([
  // 0.9.x through 0.10.2: zellij's own keybindings, no locked mode.
  // Harmless while zellij was something you launched; hostile once
  // config/bash/zellij.sh made it the session, because those bindings
  // take Ctrl-p, Ctrl-n, Ctrl-t, Ctrl-o and Ctrl-s from the shell.
  "a9e80a2b4a25075a6e594fec7aa1806b4b7b569f406aaa6361673f918a048ee3",
  // 0.11.0 through 0.14.0: locked mode and the cleared keybindings, but
  // no copy_command — so zellij still reported copying through OSC 52
  // and the clipboard never changed. Without this entry the machines
  // that took 0.11.0 could never be given one, because "written once"
  // has no exception for a file that is still exactly ours.
  "df96577497a13f992edf36e3ffcb89717472e83c841809eea1a789bed20ae34b",
]);

/**
 * The zellij config for this machine, which is the shipped one plus the
 * one line that cannot be shipped.
 *
 * Without a copy_command zellij copies through OSC 52 — it asks the
 * terminal to set the clipboard and reports success either way. On
 * Windows that ask goes unanswered often enough that selecting text
 * shows "Copied!" and pastes the previous contents, which is worse than
 * failing. clip.exe is the Windows clipboard itself, reachable from WSL
 * through interop and from Git Bash as a normal program; verified from
 * this side with a round trip through Get-Clipboard.
 *
 * Per platform rather than shipped, because a copy_command naming a
 * program that does not exist is the same silent failure pointed the
 * other way.
 */
export function zellijConfigFor(p: Platform): string {
  const command =
    p.os === "windows" || p.env === "wsl"
      ? "clip.exe"
      : p.env === "desktop"
        ? "wl-copy"
        : null;

  if (!command) return zellijBase;

  return `${zellijBase}
// Generated for this target by red-dev.
//
// The clipboard zellij should write to. Without it zellij uses OSC 52,
// which asks the terminal to do the copying and cannot tell whether it
// did — so a selection reports success and the clipboard keeps whatever
// was in it.
copy_command "${command}"
`;
}

export type ZellijConfigAction = "write" | "upgrade" | "keep";

/**
 * A config.kdl that holds nothing but the generated theme pointer.
 *
 * This is what a fresh machine actually got, and it was not a shipped
 * version of anything: applyZellij creates config.kdl to point at the
 * theme it just wrote, installZellijConfig then found a file already
 * there and left it alone, and the result was two lines where the
 * config should have been. Every setting in it — the scrollback, the
 * clipboard, session serialization — was silently absent.
 *
 * Recognised by content rather than by hash because the stub is
 * whatever applyZellij last wrote, and that string has changed before.
 */
function isThemeStub(text: string): boolean {
  const meaningful = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"));
  // "red-dev" specifically, not any theme: someone whose whole config is
  // `theme "gruvbox"` wrote that themselves, and it is not ours to
  // replace with a file that would change their theme.
  return meaningful.length === 1 && /^theme\s+"red-dev"$/.test(meaningful[0] ?? "");
}

/**
 * What to do about the zellij config already on disk.
 *
 * Separated from doing it because the decision is the part that can be
 * wrong in a way nobody notices: keep a stale config and the terminal
 * silently eats the shell's keys, replace an edited one and someone's
 * keybindings are gone.
 */
export function zellijConfigAction(
  current: string | null,
  shipped: string,
): ZellijConfigAction {
  if (current === null) return "write";
  if (current === shipped) return "keep";
  if (isThemeStub(current)) return "upgrade";
  const digest = new Bun.CryptoHasher("sha256").update(current).digest("hex");
  return SHIPPED_ZELLIJ_CONFIGS.has(digest) ? "upgrade" : "keep";
}

/**
 * Written once and then the user's — except when it is still ours.
 *
 * The theme file next to it is regenerated on every switch; keybindings
 * and layout are not, because someone may have changed them. The
 * exception is a file that is byte-for-byte a version red-dev shipped,
 * which nobody has changed by definition, and which after 0.11.0 would
 * otherwise leave zellij holding keys the shell needs.
 */
async function installZellijConfig(p: Platform): Promise<void> {
  // configHome, not home().
  //
  // These two steps disagreed, and the disagreement was invisible: the
  // theme went to the shared root because applyZellij asks configHome,
  // the config went to ~/.config because this asked home(), and
  // shared.sh exports ZELLIJ_CONFIG_DIR pointing at the share. So zellij
  // read a config red-dev had never written to, and the one it had
  // written sat locally being read by nobody.
  const { configHome } = await import("./shared-root.ts");
  const dir = `${configHome(p, "zellij")}/zellij`;
  const path = `${dir}/config.kdl`;
  mkdirSync(dir, { recursive: true });

  // The config first, the theme it references second.
  //
  // The other order is what shipped, and it quietly cost every fresh
  // machine its zellij config: applyZellij creates config.kdl in order
  // to point at the theme it just wrote, the check below then found a
  // file already sitting there and left it alone, and the result was two
  // lines where the config should have been. Nothing was missing, so
  // re-running install never fixed it.
  const shipped = zellijConfigFor(p);
  const current = existsSync(path) ? await Bun.file(path).text() : null;
  switch (zellijConfigAction(current, shipped)) {
    case "keep":
      log.skip("zellij config exists — left alone");
      // Saying nothing here is how someone ends up with a terminal that
      // swallows Ctrl-p and no idea why.
      if (current && !/default_mode\s+"locked"/.test(current)) {
        log.warn(
          "your zellij config predates the always-on session and does not set " +
            'default_mode "locked", so zellij will hold Ctrl-p, Ctrl-n, Ctrl-t, ' +
            "Ctrl-o and Ctrl-s. Delete it to take red-dev's, or set RED_ZELLIJ=0.",
        );
      }
      break;
    case "upgrade":
      await Bun.write(path, shipped);
      log.ok("zellij config upgraded — the one on disk was red-dev's own");
      break;
    case "write":
      await Bun.write(path, shipped);
      log.ok(`zellij config written to ${path}`);
      break;
  }

  // The config references theme "red-dev", so that theme has to exist
  // even when the theme step has not run or failed. Writing a default
  // here means the reference always resolves; a later theme switch
  // overwrites this file with the chosen palette. Now that config.kdl
  // already says `theme "red-dev"`, applyZellij leaves it untouched.
  const { THEMES, DEFAULT_THEME } = await import("./themes.ts");
  const fallback = THEMES[DEFAULT_THEME];
  if (fallback && !existsSync(`${dir}/themes/red-dev.kdl`)) {
    const { applyZellij } = await import("./theme-apply.ts");
    await applyZellij(fallback, p);
  }
}
