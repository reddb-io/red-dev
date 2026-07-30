/**
 * Provider execution. Each provider knows how to make one tool present
 * on one platform; the caller decides which provider applies.
 *
 * Every provider must be idempotent: re-running after a partial failure
 * is the normal recovery path, not an edge case. A fresh provision can
 * die halfway through for reasons that have nothing to do with us — we
 * lost one to a full host disk while writing this.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { log, RedError } from "./log.ts";
import type { Provider } from "./manifest.ts";
import type { Platform } from "./platform.ts";

/**
 * Inheriting stdin is only safe when there is a real terminal behind it.
 * Under CI, a pipe, or a background job, apt and dpkg can stop at a
 * prompt that nothing will ever answer — the process then sits at full
 * CPU forever rather than failing. Observed exactly once, for eight
 * minutes, which is how this guard came to exist. Detaching stdin turns
 * that deadlock into a normal non-zero exit.
 */
const stdinMode = (): "inherit" | "ignore" =>
  process.stdin.isTTY === true ? "inherit" : "ignore";

async function run(
  cmd: string[],
  opts: { allowFailure?: boolean } = {},
): Promise<number> {
  const proc = Bun.spawn(cmd, {
    stdout: "inherit",
    stderr: "inherit",
    stdin: stdinMode(),
  });
  const code = await proc.exited;
  if (code !== 0 && !opts.allowFailure) {
    throw new RedError(`${cmd[0]} exited ${code}: ${cmd.join(" ")}`);
  }
  return code;
}

async function capture(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

// ------------------------------------------------------------- apt

let aptRefreshed = false;
let sudoChecked = false;

/**
 * Fail fast when sudo would block on a password prompt.
 *
 * Detaching stdin is not enough: WSL hands even a non-interactive
 * `wsl -- bash -lc` a pty, so isTTY is true, sudo prompts, and the run
 * sits there forever against a terminal nobody is watching. `sudo -n`
 * answers "would this block?" without blocking, which turns a hang
 * into one line telling the user what to do.
 */
export async function requireSudo(): Promise<void> {
  if (sudoChecked) return;
  if (process.getuid?.() === 0) {
    sudoChecked = true;
    return;
  }

  const probe = Bun.spawn(["sudo", "-n", "true"], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  if ((await probe.exited) !== 0) {
    throw new RedError(
      "sudo needs a password and nothing here can supply one.\n" +
        "      Run `sudo -v` first, then re-run red-dev — or run it as root.",
    );
  }
  sudoChecked = true;
}

export async function aptRefreshOnce(): Promise<void> {
  if (aptRefreshed) return;
  await requireSudo();
  log.step("apt-get update");
  await run(["sudo", "-E", "apt-get", "update", "-y"]);
  aptRefreshed = true;
}

/**
 * Batched on purpose. Twenty sequential apt-get calls is the single
 * slowest part of a fresh provision, and each one re-reads the package
 * lists.
 */
export async function aptInstall(pkgs: string[]): Promise<void> {
  if (pkgs.length === 0) return;
  await aptRefreshOnce();
  log.step(`apt: ${pkgs.join(" ")}`);
  const env = { ...process.env, DEBIAN_FRONTEND: "noninteractive" };
  const proc = Bun.spawn(["sudo", "-E", "apt-get", "install", "-y", ...pkgs], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: stdinMode(),
    env,
  });
  const code = await proc.exited;
  if (code !== 0) throw new RedError(`apt-get install failed (${code})`);
}

// ---------------------------------------------------------- winget

/**
 * Build the argv that actually runs winget.
 *
 * winget is an APPEXECLINK reparse point under WindowsApps, and a
 * process cannot exec one directly — not by name, and not by absolute
 * path either, which is the part that took three attempts to learn.
 * Bun's spawn reports "Executable not found in $PATH" even when handed
 * the exact path `where.exe` returns.
 *
 * cmd.exe resolves execution aliases the way Explorer does, so going
 * through it is the difference between every winget install failing and
 * every one working. Under WSL the same alias is reached through the
 * interop layer, where winget.exe is a normal executable again.
 *
 * This is the third face of the same reparse-point problem: detection
 * needed where.exe, the font install needed AddFontResourceW, and
 * execution needs cmd.exe.
 */
export function wingetArgv(args: string[], platform: string = process.platform): string[] {
  if (platform === "win32") {
    return ["cmd.exe", "/c", "winget", ...args];
  }
  return [Bun.which("winget.exe") ?? "winget.exe", ...args];
}

export async function wingetInstall(id: string): Promise<void> {
  log.step(`winget: ${id}`);

  // Captured rather than inherited so the outcome can be read. winget
  // signals "installed, nothing to upgrade" with a non-zero code, and
  // treating every non-zero as a warning turns the steady state of an
  // idempotent converge into something that reads like a problem —
  // right underneath winget's own line saying it is fine.
  const proc = Bun.spawn(
    wingetArgv([
      "install",
      "--id",
      id,
      "--exact",
      "--silent",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ]),
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;

  if (code === 0) return;

  if (/No available upgrade found|already installed|No newer package versions/i.test(out)) {
    log.skip(`${id} already current`);
    return;
  }

  // Everything else is a failure and has to be reported as one.
  //
  // This used to warn and return, so a converge that could not install
  // anything still reported success. A mistyped id is the case that
  // matters: winget exits 20 with "No package found matching input
  // criteria", and `JesseDuffield.lazydocker` — lowercase L, where the
  // real package is `Lazydocker` — sat in the manifest being reported
  // as installed. A silent wrong result is worse than a loud failure.
  const detail = out.trim().split("\n").filter(Boolean).slice(-2).join(" ").trim();
  throw new RedError(
    /No package found/i.test(out)
      ? `winget has no package '${id}' — check the exact id, it is case-sensitive`
      : `winget exited ${code} for ${id}${detail ? `: ${detail}` : ""}`,
  );
}

// --------------------------------------------------- github release

/** Exported for tests: asset matching is where a silent bug costs most. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

interface GhAsset {
  name: string;
  browser_download_url: string;
}

/**
 * Resolve a release asset by matching a glob against the names the
 * release actually publishes. Never construct the filename from a
 * pinned version — see the note on the `gh` provider in manifest.ts.
 */
export async function resolveGhAsset(repo: string, glob: string): Promise<string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  const token = process.env["GITHUB_TOKEN"];
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers,
  });
  if (!res.ok) {
    throw new RedError(
      `GitHub API ${res.status} for ${repo}` +
        (res.status === 403 ? " — rate limited, set GITHUB_TOKEN" : ""),
    );
  }

  const body = (await res.json()) as { assets?: GhAsset[] };
  const assets = body.assets ?? [];
  const re = globToRegExp(glob);
  const hit = assets.find((a) => re.test(a.name));

  if (!hit) {
    const available = assets.map((a) => `  ${a.name}`).join("\n");
    throw new RedError(
      `no asset matching '${glob}' in latest ${repo} release.\nAvailable:\n${available}`,
    );
  }
  return hit.browser_download_url;
}

export async function ghInstall(
  repo: string,
  glob: string,
  bin?: string,
): Promise<void> {
  // Installing lands binaries in /usr/local/bin, so the same check has
  // to happen here and not only on the apt path.
  await requireSudo();
  const url = await resolveGhAsset(repo, glob);
  const file = url.split("/").pop() ?? "asset";
  log.step(`github: ${repo} -> ${file}`);

  const tmp = `/tmp/red-${Date.now()}`;
  await run(["mkdir", "-p", tmp]);

  const res = await fetch(url);
  if (!res.ok) throw new RedError(`download failed ${res.status}: ${url}`);
  await Bun.write(`${tmp}/${file}`, res);

  if (file.endsWith(".deb")) {
    await run(["sudo", "apt-get", "install", "-y", `${tmp}/${file}`]);
  } else if (file.endsWith(".tar.gz") || file.endsWith(".tgz")) {
    await run(["tar", "-xzf", `${tmp}/${file}`, "-C", tmp]);
    await installBinariesFrom(tmp);
  } else if (file.endsWith(".zip")) {
    await run(["unzip", "-qo", `${tmp}/${file}`, "-d", tmp]);
    await installBinariesFrom(tmp);
  } else if (bin) {
    // A bare binary. Several projects publish one rather than an
    // archive, and its asset name usually encodes the platform rather
    // than the command, so the caller names it.
    await run(["chmod", "+x", `${tmp}/${file}`]);
    await run(["sudo", "install", "-m", "0755", `${tmp}/${file}`, `/usr/local/bin/${bin}`]);
  } else {
    throw new RedError(
      `don't know how to unpack ${file} — if it is a bare binary, give the provider a bin name`,
    );
  }

  await run(["rm", "-rf", tmp], { allowFailure: true });
}

/**
 * The same release, onto Windows.
 *
 * Neither of the two RedDB tools is on winget, and every other `gh`
 * entry in the manifest falls back to a winget id — so without this the
 * only honest Windows column for them would be skip(), on a target
 * where the publisher does ship a build. That is precisely the gap this
 * project exists to close.
 *
 * No sudo equivalent and no admin: a bare binary lands in the same
 * per-user bin directory boot.ps1 already created and put on PATH, and
 * an installer is the vendor's own, run with the flags it documents.
 */
export async function ghInstallWindows(
  repo: string,
  glob: string,
  bin?: string,
  silentArgs?: string[],
): Promise<void> {
  const url = await resolveGhAsset(repo, glob);
  const file = url.split("/").pop() ?? "asset";
  log.step(`github: ${repo} -> ${file}`);

  // node:fs rather than cmd.exe for the file work. `mkdir` and `copy`
  // print "A subdirectory or file already exists." and "1 file(s)
  // copied." on success, and both landed in the middle of the converge
  // log — chatter from a shell we only invoked because it was the first
  // thing to hand.
  const tmp = `${process.env["TEMP"] ?? "C:\\Windows\\Temp"}\\red-dev-${Date.now()}`;
  mkdirSync(tmp, { recursive: true });
  const downloaded = `${tmp}\\${file}`;

  const res = await fetch(url);
  if (!res.ok) throw new RedError(`download failed ${res.status}: ${url}`);
  await Bun.write(downloaded, res);

  if (silentArgs) {
    // An installer, run the way its publisher documents. Verified
    // against the asset rather than assumed: red-request's is NSIS and
    // its PE manifest asks for asInvoker, so /S installs per-user with
    // no UAC prompt — which is what lets a converge stay unattended.
    log.step(`running ${file} ${silentArgs.join(" ")}`);
    await run([downloaded, ...silentArgs]);
  } else if (bin) {
    const dir = windowsBinDir();
    mkdirSync(dir, { recursive: true });
    // Copied rather than moved: the download and the destination can be
    // on different volumes, where a rename fails.
    copyFileSync(downloaded, `${dir}\\${bin}.exe`);
    log.step(`installed ${dir}\\${bin}.exe`);
  } else {
    throw new RedError(
      `don't know what to do with ${file} on Windows — give the provider a bin name, or silentArgs if it is an installer`,
    );
  }

  rmSync(tmp, { recursive: true, force: true });
}

/**
 * Where boot.ps1 puts red-dev, and therefore somewhere already on the
 * user's PATH. Anything installed beside it is reachable without a
 * second PATH entry to explain.
 */
export function windowsBinDir(): string {
  const override = process.env["RED_DEV_BIN_DIR"];
  if (override) return override;
  const local = process.env["LOCALAPPDATA"];
  if (!local) throw new RedError("LOCALAPPDATA is not set — cannot place a binary");
  return `${local}\\red-dev\\bin`;
}

async function installBinariesFrom(dir: string): Promise<void> {
  const listing = await capture([
    "find",
    dir,
    "-type",
    "f",
    "-perm",
    "-u+x",
    "-not",
    "-name",
    "*.tar.gz",
    "-not",
    "-name",
    "*.zip",
  ]);
  for (const path of listing.split("\n").filter(Boolean)) {
    const base = path.split("/").pop() ?? "";
    if (/\.(md|txt)$/i.test(base) || /^(LICENSE|README)/i.test(base)) continue;
    await run(["sudo", "install", "-m", "0755", path, "/usr/local/bin/"]);
  }
}

// -------------------------------------------------------------- npm

/**
 * Fetch a vendor's install script and run it.
 *
 * Downloaded to a file and executed, rather than piped into sh: a pipe
 * consumes stdin, so an installer that wants to ask something gets EOF
 * instead — and a truncated download runs whatever prefix arrived.
 * Writing it out first means a failed transfer fails before anything
 * executes.
 */
/**
 * Which shell a vendor script asked for.
 *
 * `#!/usr/bin/env bash` counts as bash, which is the form dit uses —
 * matching only `#!/bin/bash` would have sent it to dash anyway.
 * Anything else falls back to sh, because a script that does not say is
 * a script that should not need more than POSIX.
 */
export function shellFor(body: string): "bash" | "sh" {
  const m = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(body);
  if (!m?.[1]) return "sh";
  const interpreter = m[1].endsWith("/env") && m[2] ? m[2] : m[1];
  return /(^|\/)bash$/.test(interpreter) ? "bash" : "sh";
}

export async function installerInstall(
  url: string,
  note: string,
  args: string[] = [],
): Promise<void> {
  log.step(`installer: ${url}`);
  log.plain(`       ${note}`);

  const tmp = `/tmp/red-dev-installer-${Date.now()}.sh`;
  const res = await fetch(url);
  if (!res.ok) throw new RedError(`installer download failed ${res.status}: ${url}`);
  const body = await res.text();
  if (body.trim().length === 0) throw new RedError(`installer at ${url} was empty`);
  await Bun.write(tmp, body);

  // Run with the interpreter the script asks for, not with `sh`.
  //
  // red-request's installer is deliberately POSIX and says so in its
  // header; dit's is `#!/usr/bin/env bash` and uses `[[ ]]` and `local`
  // in its input-permission setup. On Ubuntu `sh` is dash, so running
  // every vendor script through it would have failed that one with a
  // syntax error partway through — after it had already installed the
  // binary, which is the worst place to stop.
  const shell = shellFor(body);

  // Primed before handing over, not after it blocks.
  //
  // A vendor script that installs a .deb calls sudo from inside itself,
  // where none of our own guards apply — so an unprimed timestamp turns
  // into a password prompt against a converge whose output the TUI is
  // capturing. requireSudo answers "would this block?" without blocking
  // and fails with an instruction instead.
  if (body.includes("sudo ")) await requireSudo();

  const proc = Bun.spawn([shell, tmp, ...args], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: stdinMode(),
  });
  const code = await proc.exited;
  await run(["rm", "-f", tmp], { allowFailure: true });

  if (code !== 0) throw new RedError(`installer exited ${code}: ${url}`);
}

// ------------------------------------------------- ppa / apt repos

export async function ppaInstall(ppa: string, pkgs: string[]): Promise<void> {
  await requireSudo();
  log.step(`ppa: ${ppa}`);
  // add-apt-repository refreshes the lists itself, but only for the
  // repository it just added; the batched refresh still has to happen.
  await run(["sudo", "-E", "add-apt-repository", "-y", `ppa:${ppa}`]);
  aptRefreshed = false;
  await aptInstall(pkgs);
}

/**
 * Which file under sources.list.d already configures this repository,
 * if any. Both the one-line .list format and the deb822 .sources format
 * are checked, because Ubuntu 24.04 onward writes the latter.
 */
async function findSourceFor(repoUrl: string): Promise<string | null> {
  const dir = "/etc/apt/sources.list.d";
  if (!existsSync(dir)) return null;
  const listing = await capture(["sh", "-c", `grep -rl "${repoUrl}" ${dir} 2>/dev/null || true`]);
  const first = listing.split("\n").find(Boolean);
  return first ?? null;
}

export interface AptRepoSpec {
  pkgs: string[];
  keyUrl: string;
  keyring: string;
  entry: string;
  group?: string;
}

/**
 * Add a third-party apt repository and install from it.
 *
 * The key is fetched and dearmored only if it is not already present,
 * and the sources entry is written only if its content differs, so a
 * re-run touches nothing. That matters: apt refuses to work at all when
 * the same repository is configured twice.
 */
export async function aptRepoInstall(
  spec: AptRepoSpec,
  codename: string,
): Promise<void> {
  const entry = spec.entry.replaceAll("{{codename}}", codename);
  const listName = spec.keyring.split("/").pop()?.replace(/\.(gpg|asc)$/, "") ?? "red-dev";
  const listPath = `/etc/apt/sources.list.d/${listName}.list`;

  if (!existsSync(spec.keyring)) {
    log.step(`key: ${spec.keyUrl}`);
    await run(["sudo", "install", "-m", "0755", "-d", "/etc/apt/keyrings"]);
    const res = await fetch(spec.keyUrl);
    if (!res.ok) throw new RedError(`key download failed ${res.status}: ${spec.keyUrl}`);
    const tmp = `/tmp/red-dev-key-${listName}`;
    await Bun.write(tmp, res);

    // .asc keys are armoured text and apt reads them directly; .gpg
    // must be binary, so dearmor when the target says so.
    if (spec.keyring.endsWith(".gpg")) {
      await run(["sudo", "sh", "-c", `gpg --dearmor < "${tmp}" > "${spec.keyring}"`]);
    } else {
      await run(["sudo", "cp", tmp, spec.keyring]);
    }
    await run(["sudo", "chmod", "a+r", spec.keyring]);
    await run(["rm", "-f", tmp], { allowFailure: true });
  }

  // Someone else may already have configured this repository under a
  // different filename — omakub writes github-cli.list where we would
  // write githubcli-archive-keyring.list. Adding ours too makes apt
  // complain about a duplicate source on every single invocation, so
  // look for the URL anywhere under sources.list.d before writing.
  const repoUrl = /https?:\/\/\S+/.exec(entry)?.[0] ?? "";
  const existingOwner = repoUrl ? await findSourceFor(repoUrl) : null;

  if (existingOwner && existingOwner !== listPath) {
    log.skip(`repository already configured in ${existingOwner}`);
  } else {
    const current = existsSync(listPath) ? await Bun.file(listPath).text() : "";
    if (current.trim() !== entry.trim()) {
      log.step(`repo: ${listPath}`);
      await run(["sudo", "sh", "-c", `printf '%s\\n' "${entry}" > "${listPath}"`]);
      aptRefreshed = false;
    }
  }

  await aptInstall(spec.pkgs);

  if (spec.group) {
    const user = process.env["USER"] ?? process.env["LOGNAME"];
    if (user) {
      await run(["sudo", "usermod", "-aG", spec.group, user], { allowFailure: true });
      log.ok(`${user} added to group '${spec.group}' — log out and back in to take effect`);
    }
  }
}

// -------------------------------------------------------- updates

/**
 * Update everything the platform's own package manager owns. Kept
 * separate from `install` because upgrading and converging are
 * different intents: converge makes the manifest true, update moves
 * already-installed things forward.
 */
export async function systemUpdate(p: Platform): Promise<void> {
  if (p.caps.apt) {
    await aptRefreshOnce();
    log.step("apt full-upgrade");
    const env = { ...process.env, DEBIAN_FRONTEND: "noninteractive" };
    const proc = Bun.spawn(["sudo", "-E", "apt-get", "full-upgrade", "-y"], {
      stdout: "inherit",
      stderr: "inherit",
      stdin: stdinMode(),
      env,
    });
    if ((await proc.exited) !== 0) throw new RedError("apt full-upgrade failed");

    log.step("apt autoremove");
    await run(["sudo", "-E", "apt-get", "autoremove", "-y"], { allowFailure: true });
  }

  if (p.caps.winget) {
    log.step("winget upgrade --all");
    await run(
      wingetArgv([
        "upgrade",
        "--all",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ]),
      { allowFailure: true },
    );
  }
}

// -------------------------------------------------------- dispatch

export interface ApplyContext {
  // No `root`: there is nothing on disk to point at. Every config file
  // this tool writes is either a text import compiled into the binary
  // or generated from the theme, so a converge needs no checkout, no
  // clone and no download beyond the executable itself.
  platform: Platform;
  /** Theme key from src/themes.ts. */
  theme: string;
  /** Font key from src/wsl.ts NERD_FONTS. */
  font: string;
  /** Terminal background opacity, 0-100. */
  opacity: number;
}

export async function applyProvider(pr: Provider, ctx: ApplyContext): Promise<void> {
  switch (pr.kind) {
    case "apt":
      // Batched by the caller; reaching here means a one-off.
      await aptInstall([pr.pkg]);
      return;
    case "winget":
      await wingetInstall(pr.id);
      return;
    case "installer":
      await installerInstall(pr.url, pr.note, pr.args);
      return;
    case "gh":
      // Two implementations, one provider: the manifest names a release
      // asset and the platform decides how it lands. Splitting this
      // into two provider kinds would put the same repo in two places
      // and let them drift.
      if (ctx.platform.os === "windows") {
        await ghInstallWindows(pr.repo, pr.asset, pr.bin, pr.silentArgs);
      } else {
        await ghInstall(pr.repo, pr.asset, pr.bin);
      }
      return;
    case "ppa":
      await ppaInstall(pr.ppa, pr.pkgs);
      return;
    case "aptrepo":
      await aptRepoInstall(pr, ctx.platform.codename ?? "stable");
      return;
    case "builtin": {
      // Imported lazily so the Windows build does not pull WSL-only
      // code into a target that can never reach a WSL host.
      if (pr.name === "dotfiles") {
        const { installDotfiles } = await import("./dotfiles.ts");
        await installDotfiles();
        return;
      }
      if (pr.name === "blesh") {
        const { installBlesh } = await import("./blesh.ts");
        await installBlesh();
        return;
      }
      if (pr.name === "runtimes") {
        const { installRuntimes } = await import("./runtimes.ts");
        await installRuntimes(ctx.platform);
        return;
      }
      if (pr.name === "alacritty") {
        const { configureAlacritty } = await import("./alacritty.ts");
        const { THEMES } = await import("./themes.ts");
        const theme = THEMES[ctx.theme];
        if (!theme) throw new RedError(`unknown theme '${ctx.theme}'`);
        const { NERD_FONTS } = await import("./wsl.ts");
        const spec = NERD_FONTS[ctx.font];
        if (!spec) throw new RedError(`unknown font '${ctx.font}'`);
        // Alacritty's config may live on the Windows host, so this can
        // fail for reasons that have nothing to do with zellij, btop or
        // neovim. Keep the surfaces independent: one unreachable
        // filesystem must not leave the machine unthemed.
        try {
          await configureAlacritty({
            platform: ctx.platform,
            theme,
            fontFamily: spec.family,
            opacity: ctx.opacity,
          });
        } catch (err) {
          log.warn(`alacritty: ${(err as Error).message}`);
        }

        const { applyThemeEverywhere } = await import("./theme-apply.ts");
        const { applied } = await applyThemeEverywhere(theme, ctx.platform);
        if (applied.length > 0) log.ok(`themed: ${applied.join(", ")}`);

        const { applyWallpaperLogged } = await import("./wallpaper.ts");
        await applyWallpaperLogged(theme, ctx.theme, ctx.platform);
        return;
      }
      const wsl = await import("./wsl.ts");
      if (pr.name === "wsl-interop") {
        await wsl.ensureWslInterop();
        return;
      }
      if (pr.name === "nerd-font") {
        await wsl.installNerdFont(ctx.font);
      } else {
        const { THEMES } = await import("./themes.ts");
        const theme = THEMES[ctx.theme];
        if (!theme) throw new RedError(`unknown theme '${ctx.theme}'`);
        const spec = wsl.NERD_FONTS[ctx.font];
        if (!spec) throw new RedError(`unknown font '${ctx.font}'`);
        await wsl.configureWindowsTerminal({
          fontFace: spec.family,
          theme,
          opacity: ctx.opacity,
          distro: process.env["WSL_DISTRO_NAME"] ?? undefined,
          home: process.env["HOME"] ?? undefined,
        });
      }
      return;
    }
    case "skip":
      return;
  }
}
