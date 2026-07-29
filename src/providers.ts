/**
 * Provider execution. Each provider knows how to make one tool present
 * on one platform; the caller decides which provider applies.
 *
 * Every provider must be idempotent: re-running after a partial failure
 * is the normal recovery path, not an edge case. A fresh provision can
 * die halfway through for reasons that have nothing to do with us — we
 * lost one to a full host disk while writing this.
 */

import { existsSync } from "node:fs";
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

function wingetBin(): string {
  return process.platform === "win32" ? "winget" : "winget.exe";
}

export async function wingetInstall(id: string): Promise<void> {
  log.step(`winget: ${id}`);
  const code = await run(
    [
      wingetBin(),
      "install",
      "--id",
      id,
      "--exact",
      "--silent",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ],
    { allowFailure: true },
  );
  // winget uses a distinct non-zero code for "already installed", which
  // is success as far as a converge tool is concerned.
  if (code !== 0) log.warn(`winget returned ${code} for ${id} (may already be present)`);
}

// --------------------------------------------------- github release

function globToRegExp(glob: string): RegExp {
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

export async function ghInstall(repo: string, glob: string): Promise<void> {
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
  } else {
    throw new RedError(`don't know how to unpack ${file}`);
  }

  await run(["rm", "-rf", tmp], { allowFailure: true });
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
      [
        wingetBin(),
        "upgrade",
        "--all",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ],
      { allowFailure: true },
    );
  }
}

// -------------------------------------------------------- dispatch

export interface ApplyContext {
  root: string;
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
    case "gh":
      await ghInstall(pr.repo, pr.asset);
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
      if (pr.name === "alacritty") {
        const { configureAlacritty } = await import("./alacritty.ts");
        const { THEMES } = await import("./themes.ts");
        const theme = THEMES[ctx.theme];
        if (!theme) throw new RedError(`unknown theme '${ctx.theme}'`);
        const { NERD_FONTS } = await import("./wsl.ts");
        const spec = NERD_FONTS[ctx.font];
        if (!spec) throw new RedError(`unknown font '${ctx.font}'`);
        await configureAlacritty({
          platform: ctx.platform,
          theme,
          fontFamily: spec.family,
          opacity: ctx.opacity,
        });
        // Converging should leave the machine themed, not just the
        // terminal emulator configured.
        const { applyThemeEverywhere } = await import("./theme-apply.ts");
        const { applied } = await applyThemeEverywhere(theme, ctx.platform);
        if (applied.length > 0) log.ok(`themed: ${applied.join(", ")}`);
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
