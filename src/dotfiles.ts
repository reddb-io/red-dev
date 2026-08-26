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
import {
  composeZellijLayers,
  isComposedZellijConfig,
  readZellijCompanionLayer,
  readZellijLayer,
  seedZellijLayer,
  ZELLIJ_LAYER_FILE,
} from "./zellij-layer.ts";

import rcSh from "../config/bash/rc.sh" with { type: "text" };
import pathSh from "../config/bash/path.sh" with { type: "text" };
import initSh from "../config/bash/init.sh" with { type: "text" };
import aliasesSh from "../config/bash/aliases.sh" with { type: "text" };
import functionsSh from "../config/bash/functions.sh" with { type: "text" };
import promptSh from "../config/bash/prompt.sh" with { type: "text" };
import sharedSh from "../config/bash/shared.sh" with { type: "text" };
import zellijSh from "../config/bash/zellij.sh" with { type: "text" };
import redSkillsWatchSh from "../config/bash/red-skills-watch.sh" with { type: "text" };
import windowsClipboardSh from "../config/bash/windows-clipboard.sh" with { type: "text" };
import inputrc from "../config/bash/inputrc.conf" with { type: "text" };
import zellijBase from "../config/zellij/config.kdl" with { type: "text" };
import { workloadPolicy } from "./workload-policy.ts";

/** Exported so `doctor` can compare what is deployed against what this
 * binary would deploy — an upgraded red-dev with stale files on disk is
 * invisible otherwise. */
export const FILES: Record<string, string> = {
  "rc.sh": rcSh,
  "path.sh": pathSh,
  "init.sh": initSh,
  "aliases.sh": aliasesSh,
  "functions.sh": functionsSh,
  "build-resources.sh": workloadPolicy().shell,
  "prompt.sh": promptSh,
  "shared.sh": sharedSh,
  "zellij.sh": zellijSh,
  "red-skills-watch.sh": redSkillsWatchSh,
  "windows-clipboard.sh": windowsClipboardSh,
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
async function wireShellRc(homeDir: string, label: string): Promise<void> {
  const bashrc = `${homeDir}/.bashrc`;
  const existing = existsSync(bashrc) ? await Bun.file(bashrc).text() : "";

  if (existing.includes(MARKER)) {
    log.skip(`${label} .bashrc already sources red-dev`);
    return;
  }

  if (existing.length > 0) {
    await Bun.write(`${bashrc}.red-dev-backup`, existing);
    log.step(`backed up ${label} .bashrc to .bashrc.red-dev-backup`);
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
  log.ok(`${label} .bashrc now sources red-dev`);
}

/**
 * Render the bash config into one home and hook that home's .bashrc.
 *
 * Takes the home rather than asking for it, because there are two. See
 * installDotfiles.
 */
async function deployTo(homeDir: string, label: string): Promise<void> {
  const dest = `${homeDir}/.local/share/red-dev/config/bash`;
  // node:fs rather than shelling out to mkdir, which native Windows
  // does not have. Git Bash understands the forward-slash HOME it
  // reports, so the path itself needs no translation.
  mkdirSync(dest, { recursive: true });

  let changed = 0;
  for (const [name, content] of Object.entries(FILES)) {
    if (await writeIfChanged(`${dest}/${name}`, content)) changed++;
  }

  if (changed > 0) log.ok(`dotfiles: ${changed} file(s) written to ${dest}`);
  else log.skip(`dotfiles already current in ${label}`);

  await wireShellRc(homeDir, label);
}

/**
 * The Windows profile, as this distro reaches it — or null.
 *
 * Null rather than throwing: a distro with interop switched off, or a
 * C: that did not mount, is a machine that simply has no second home to
 * converge. That is not a reason to fail the install of the first one.
 */
async function windowsHomeFromWsl(): Promise<string | null> {
  try {
    const { windowsUserProfile } = await import("./wsl.ts");
    const { localPath } = await import("./shared-root.ts");
    const dir = localPath(await windowsUserProfile(), "wsl");
    return existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Both homes, one converge.
 *
 * A Windows machine running WSL has two of everything, and the shell
 * config is the pair that silently drifts. Converging from inside the
 * distro used to write the distro's copy only, so the Git Bash side kept
 * whatever it had from the last time red-dev happened to run as a native
 * Windows binary — on this machine, dotfiles from eight days earlier,
 * with a prompt.sh still missing the TERM=dumb guard. Nothing failed.
 * The mode you were not in was just quietly older.
 *
 * wsl-sync.ts crosses the same boundary the other way and states the
 * rule this follows: whoever is converging owns the crossing. The files
 * are byte-identical by construction, so the second write is a no-op
 * whenever the two sides already agree — which is the point.
 */
export function deployTargets(
  env: Platform["env"],
  ownHome: string,
  windowsHome: string | null,
): { dir: string; label: string }[] {
  const targets = [{ dir: ownHome, label: "this" }];
  // Only from the distro outwards. Native Windows reaches its distro
  // through wsl-sync, which runs a full install in there rather than
  // reaching into its filesystem, and a Linux desktop has no other side.
  if (env === "wsl" && windowsHome && windowsHome !== ownHome) {
    targets.push({ dir: windowsHome, label: "the Windows profile" });
  }
  return targets;
}

export async function installDotfiles(p: Platform): Promise<void> {
  const winHome = p.env === "wsl" ? await windowsHomeFromWsl() : null;
  const targets = deployTargets(p.env, home(), winHome);

  for (const t of targets) await deployTo(t.dir, t.label);
  if (p.env === "wsl" && targets.length === 1) {
    log.skip("no reachable Windows profile — Git Bash side left as it is");
  }

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
  // 0.15.0 through 0.19.0 on WSL/Windows: the base above plus a
  // generated `copy_command "clip.exe"`. clip.exe decodes redirected
  // stdin with the Windows OEM code page, so UTF-8 became mojibake.
  "2210c40109a5f89c9acb30baa0cc3f67072eed998ac3c7569c19866aa8a2efb8",
  // 0.19.0 on WSL/Windows: the UTF-8-safe PowerShell bridge. Correct in
  // isolation, but Zellij kills copy commands after one second and Windows
  // PowerShell startup can exceed that from WSL, leaving the old clipboard.
  "386a88423e2c91e3af3341ac82f9402d0cf81ae2ed325859236e1dbfa400db12",
  // 0.22.0: `theme "red-dev"` removed. red-dev no longer colours
  // terminals, so the line pointed at a themes/red-dev.kdl that this
  // release deletes — and zellij refuses to start on a theme it cannot
  // resolve. clearZellij() cuts the same two lines out of a config.kdl
  // already on disk, which is the branch that reaches everyone whose
  // file hashes to one of the four above.
  "d1a2cbf38939ff698a9a3cd48376ff69ad0ac8eda2b25bbc05833fb9d4d48117",
  // 0.23.x: the Shift+Enter keybind. zellij downgrades Shift+Enter to a
  // plain Enter for panes that never enabled the kitty keyboard
  // protocol — Claude Code among them — and a user keybind is the one
  // thing that wins before that downgrade, so the config writes the
  // ESC[13;2u bytes through in the two modes where typing reaches the
  // pane at all.
  "2aaca2fbc44c5653ac8503274cc88cdd8923b93813a6b988e7ee24a21800f32c",
]);

/**
 * WSL's low-latency clipboard bridge.
 *
 * Zellij gives copy_command UTF-8 on stdin and terminates it after one
 * second. Starting powershell.exe is too slow on some WSL machines, while
 * iconv + clip.exe completes in tens of milliseconds. clip.exe accepts
 * redirected UTF-16LE without a BOM, preserving accents and supplementary
 * Unicode characters in the Windows clipboard.
 *
 * The argv is the primitive and the string is derived from it, not the
 * other way round. zellij wants one line of shell; a red-dev surface that
 * copies something — the Emoji picker is the first — wants a program and
 * its arguments, and deriving the string means the second one cannot
 * drift into a second bridge with its own encoding bug. `join(" ")`
 * reproduces the exact line this function has always returned, which is
 * what keeps the SHIPPED_ZELLIJ_CONFIGS upgrade path intact.
 */
export function wslClipboardArgv(): readonly string[] {
  return ["bash", `${home()}/.local/share/red-dev/config/bash/windows-clipboard.sh`];
}

export function wslClipboardCommand(): string {
  return wslClipboardArgv().join(" ");
}

/** Native Windows fallback. WSL uses the faster helper above because Zellij
 * terminates commands after one second; PowerShell startup inside WSL can
 * exceed that deadline. */
export function windowsClipboardArgv(): readonly string[] {
  const script =
    "$ProgressPreference='SilentlyContinue';" +
    "$s=[Console]::OpenStandardInput();" +
    "$m=New-Object IO.MemoryStream;" +
    "$s.CopyTo($m);" +
    "Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString($m.ToArray()))";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return ["powershell.exe", "-NoProfile", "-EncodedCommand", encoded];
}

export function windowsClipboardCommand(): string {
  return windowsClipboardArgv().join(" ");
}

/**
 * The three routes, and the one target that has none.
 *
 * This is the whole clipboard layer of the product, in one function: the
 * WSL bridge, the native Windows bridge, and `wl-copy` on a Linux
 * desktop. A server gets null, because a copy_command naming a program
 * that is not installed is the same silent failure as no clipboard at
 * all, pointed the other way — and there is no display there to have a
 * clipboard on.
 *
 * The order is not alphabetical and cannot be reordered. A WSL distro is
 * `os: "linux"` and `env: "wsl"`, so asking about the OS first would send
 * it to a `wl-copy` that is not there; and native Windows is `env:
 * "windows"`, not `"desktop"`, so the desktop branch has to come last.
 *
 * Exported so every surface that copies asks the same question. zellij's
 * `copy_command` was the first caller and the Emoji picker is the second;
 * a third one that wrote its own ternary is how one target quietly gets a
 * clipboard the others do not have.
 */
export function clipboardArgvFor(p: Platform): readonly string[] | null {
  if (p.env === "wsl") return wslClipboardArgv();
  if (p.os === "windows") return windowsClipboardArgv();
  // wl-copy, not xclip: the desktop targets are Wayland sessions, and
  // wl-copy takes UTF-8 on stdin with no encoding step in between.
  if (p.env === "desktop") return ["wl-copy"];
  return null;
}

/**
 * The zellij config for this machine, which is the shipped one plus the
 * one line that cannot be shipped.
 *
 * Without a copy_command zellij copies through OSC 52 — it asks the
 * terminal to set the clipboard and reports success either way. On
 * Windows that ask goes unanswered often enough that selecting text
 * shows "Copied!" and pastes the previous contents, which is worse than
 * failing. On WSL the helper converts Zellij's UTF-8 to BOM-less UTF-16LE
 * before clip.exe reads it. This both preserves Unicode and finishes before
 * Zellij's one-second copy-command deadline. Native Windows uses the same
 * explicit UTF-8 decoding through the PowerShell clipboard API.
 *
 * Per platform rather than shipped, because a copy_command naming a
 * program that does not exist is the same silent failure pointed the
 * other way.
 */
export function zellijConfigFor(p: Platform): string {
  const argv = clipboardArgvFor(p);
  if (!argv) return zellijBase;
  const command = argv.join(" ");

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
 * The same question, asked of a machine that has a user layer.
 *
 * A composed config.kdl is not a fixed set of bytes — it changes every
 * time the layer does — so the hash list above cannot recognise one, and
 * without this the first edit to a layer would be the last that ever
 * landed: the file would stop matching anything red-dev shipped and be
 * kept forever as the user's.
 *
 * Two files are red-dev's to rewrite. One carries the marker red-dev
 * writes at the top of every composition. The other is exactly what this
 * binary would write with no layer at all, which is what sits on a
 * machine that converged yesterday and wrote its first layer today.
 * Anything else falls through to the rule that has always applied: it is
 * the user's file, and the most a converge may do to it is say so.
 */
export function zellijLayerAction(
  current: string | null,
  base: string,
  composed: string,
): ZellijConfigAction {
  if (current === composed) return "keep";
  if (current !== null && (current === base || isComposedZellijConfig(current))) {
    return "upgrade";
  }
  return zellijConfigAction(current, composed);
}

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
 * Composed from red-dev's base and the person's layer.
 *
 * zellij has no include mechanism, so the layer cannot be a file zellij
 * reads: red-dev writes the whole of config.kdl from its own base plus
 * config.user.kdl beside it, and the layer wins wherever both speak. A
 * converge may replace everything red-dev wrote and never touches the
 * layer — see .red/adr/0007.
 *
 * On a machine with no layer this is exactly what it always was: written
 * once and then the user's, with the one exception of a file that is
 * byte-for-byte a version red-dev shipped, which nobody has changed by
 * definition and which after 0.11.0 would otherwise leave zellij holding
 * keys the shell needs.
 */
export async function installZellijConfig(p: Platform): Promise<void> {
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

  // The layer before the config it composes into, and created once: a
  // file someone can find beside config.kdl is the only version of "your
  // edits go here" that survives being forgotten. Every converge after
  // this one reads it and writes nothing to it.
  if (await seedZellijLayer(p)) {
    log.ok(`zellij user layer created at ${dir}/${ZELLIJ_LAYER_FILE} — yours to edit`);
  }

  const base = zellijConfigFor(p);
  const layer = await readZellijLayer(p);
  // Three authors, in the order they win: red-dev's base, the fragment
  // the RedSkills package set carries for its dashboard, and the
  // operator's own layer last. The middle one is only there on a machine
  // whose companion converge found a zellij surface in the set.
  const shipped = composeZellijLayers(base, [await readZellijCompanionLayer(p), layer]);
  const layered = shipped !== base;
  const current = existsSync(path) ? await Bun.file(path).text() : null;
  switch (zellijLayerAction(current, base, shipped)) {
    case "keep":
      log.skip(
        layered ? "zellij config already carries your layer" : "zellij config exists — left alone",
      );
      // Saying nothing here is how someone ends up with a terminal that
      // swallows Ctrl-p and no idea why.
      if (current && !/default_mode\s+"locked"/.test(current)) {
        log.warn(
          "your zellij config predates the always-on session and does not set " +
            'default_mode "locked", so zellij will hold Ctrl-p, Ctrl-n, Ctrl-t, ' +
            "Ctrl-o and Ctrl-s. Delete it to take red-dev's, or set RED_ZELLIJ=0.",
        );
      }
      // A layer nothing composes is worse than no layer: the person
      // edited the file they were told to edit and the terminal did not
      // change. It happens on a machine whose config.kdl was written by
      // hand before the layer existed, which is precisely the file a
      // converge must not overwrite — so it is said rather than fixed.
      if (layered && current !== shipped) {
        log.warn(
          `your config.kdl is your own, so ${ZELLIJ_LAYER_FILE} is not composed into it. ` +
            `Move what you want to keep into ${ZELLIJ_LAYER_FILE} and delete ${path} to hand the file back.`,
        );
      }
      break;
    case "upgrade":
      await Bun.write(path, shipped);
      log.ok(
        layered
          ? "zellij config regenerated — your layer is in it"
          : "zellij config upgraded — the one on disk was red-dev's own",
      );
      break;
    case "write":
      await Bun.write(path, shipped);
      log.ok(`zellij config written to ${path}`);
      break;
  }

  // The shipped config used to reference theme "red-dev", so the theme
  // had to be written here too — zellij refuses to start on a theme name
  // it cannot resolve, and the theme step can fail or not have run.
  //
  // Both are gone. What is left is the reverse job: a machine installed
  // before this release has the theme file and the reference, and the
  // "keep" branch above leaves its config.kdl alone precisely because it
  // is the user's. clearZellij removes red-dev's own two lines from it
  // without touching the rest.
  const { clearZellij } = await import("./terminal-surfaces.ts");
  await clearZellij(p);
}
