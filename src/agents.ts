/**
 * Coding agents, and the skills that go with them.
 *
 * These moved out of `core` because installing five agents on every
 * machine is a decision nobody made — they were unconditional before,
 * which is not the same as chosen. The setup offers every applicable
 * agent pre-ticked so the user can opt out explicitly.
 *
 * red-skills is the reason this is a group rather than loose entries:
 * it registers a marketplace in Claude Code and Codex CLI and generates
 * plugin modules for RedCode, so it is only meaningful once at least
 * one agent exists. Installing it alone would configure nothing.
 */

import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { log, RedError } from "./log.ts";
import { tlsTrustFailure, unattendedEnvironment } from "./unattended.ts";
import type { Platform } from "./platform.ts";
import type { Trigger } from "./trigger.ts";
import type { CompanionOutcome } from "./red-skills-companions.ts";
import type { HostOutcome } from "./red-skills-hosts.ts";
import { redSkillsCurrentPosix } from "./red-skills-root.ts";

export interface AgentSpec {
  key: string;
  label: string;
  about: string;
  /** Command that proves it is installed. */
  cmd: string;
  /** Ticked when the question is first shown. */
  recommended: boolean;
  /** Vendor install script, used on Linux and WSL. */
  installer?: string;
  /** winget id, used on native Windows. */
  winget?: string;
  /**
   * Microsoft Store product id, for apps the publisher ships there and
   * not through the winget community repository.
   *
   * Kept separate from `winget` because the source matters: searching
   * the winget repo for ChatGPT returns third-party wrappers
   * (j178.ChatGPT, lencx.ChatGPT) that are not OpenAI's. Installing one
   * of those under the name of the official app would be worse than
   * installing nothing.
   */
  msstore?: string;
  /** npm package, when neither of the above fits the platform. */
  npm?: string;
  /**
   * A mise spec, for a host this organisation publishes itself.
   *
   * The rule in `src/agent-update.ts` — every host by its own
   * publisher's mechanism — is written against third parties, and it is
   * right for them: red-dev has no business deciding what "current"
   * means for Anthropic's CLI or OpenAI's. It says nothing about a host
   * we publish, because there is no vendor to get between.
   *
   * For those, `src/manifest.ts` already recorded the opposite rule and
   * the reason: a bare release download "downloads a tool *once* and
   * there is nothing left that knows how to move it forward; every
   * reddb-io tool grew an install.sh and none of them grew an updater."
   * RedCode was in this list rather than that one, so it got the
   * third-party answer by accident of which catalog it lived in — and
   * sat three versions behind while every other reddb-io tool tracked
   * the publisher through `mise upgrade`.
   *
   * Declaring it here rather than moving the host into `TOOLS` keeps
   * the one thing that list is for: red-skills wires its marketplace
   * into these hosts, and a host that left the list would stop being
   * wired.
   *
   * Takes precedence over `release` on a machine that has mise. The
   * `release` entry stays as the answer for a machine that does not.
   */
  mise?: string;
  /** GitHub release archives whose stable filenames are part of our contract. */
  release?: {
    repo: string;
    linux: Partial<Record<Platform["arch"], string>>;
    windows: Partial<Record<Platform["arch"], string>>;
  };
  /**
   * The publisher's own update command, appended to this host's binary.
   *
   * Only for a host that manages its own installation — Claude Code's
   * install.sh puts a self-updating binary on the machine, so `claude
   * update` is the door its publisher built for exactly this, and
   * re-running the install script would be red-dev going around it.
   * A host whose package manager owns the version (npm, winget, a
   * release archive) leaves this unset: see src/agent-update.ts.
   */
  selfUpdate?: string[];
  /** Runtimes an npm lifecycle script needs in addition to Node itself. */
  runtimeNeeds?: string[];
  /** A command that must start successfully before presence counts as ready. */
  probeArgs?: string[];
  /**
   * Arguments red-dev adds when it starts this host.
   *
   * Empty for every host today, which is the point: what a person gets
   * from `red-dev agents run` is the command line they would have typed
   * themselves. It exists as a field so that a host which one day needs
   * one — a profile, a config path — declares it here, where the
   * permission-bypass guard in src/agent-launch.ts reads it, rather
   * than having it spliced in at a call site no guard looks at.
   */
  launchArgs?: string[];
  /**
   * This host's configuration, as home-relative file paths.
   *
   * Files, and never the directory that holds them. The directories are
   * where these tools keep their working life: measured on one
   * workstation, `~/.codex` is 3.9 GB of sessions and caches, `~/.claude`
   * is 856 MB and `~/.local/share/redcode` is 610 MB. A retirement that
   * copied those aside would move gigabytes to protect a few kilobytes
   * of settings, every time it ran.
   *
   * What is listed is what a person would be sorry to lose if a version
   * change rewrote it. A path that does not exist is skipped, so a host
   * that has never been configured costs nothing.
   */
  configFiles?: string[];
  /** Desktop applications have no CLI and only exist on some targets. */
  desktopOnly?: boolean;
  /**
   * Runs agents rather than being one, so it is never the Default agent
   * — see src/default-agent.ts. It belongs in this list because it is
   * installed and offered alongside them; it just cannot answer a
   * prompt.
   */
  multiplexer?: boolean;
}

export const AGENTS: AgentSpec[] = [
  {
    key: "claude-code",
    label: "Claude Code",
    about: "Anthropic's CLI",
    cmd: "claude",
    configFiles: [".claude/settings.json", ".claude.json"],
    recommended: true,
    installer: "https://claude.ai/install.sh",
    winget: "Anthropic.ClaudeCode",
    selfUpdate: ["update"],
  },
  {
    key: "codex",
    label: "Codex CLI",
    about: "OpenAI's CLI",
    cmd: "codex",
    configFiles: [".codex/config.toml"],
    recommended: true,
    winget: "OpenAI.Codex",
    npm: "@openai/codex",
    // OpenAI ships a standalone build with its own updater, and machines
    // are moving onto it: this one's `codex` resolves into
    // ~/.codex/packages/standalone, which npm did not put there and will
    // not overwrite. See agentUpdateMechanism for when this wins.
    selfUpdate: ["update"],
  },
  {
    key: "redcode",
    label: "RedCode",
    about: "RedDB's OpenCode-compatible terminal agent",
    cmd: "redcode",
    configFiles: [".config/redcode/opencode.json", ".config/redcode/opencode.jsonc"],
    recommended: true,
    mise: "github:reddb-io/redcode",
    release: {
      repo: "reddb-io/redcode",
      linux: {
        x64: "redcode-linux-x64.tar.gz",
        arm64: "redcode-linux-arm64.tar.gz",
      },
      windows: {
        x64: "redcode-windows-x64.zip",
        arm64: "redcode-windows-arm64.zip",
      },
    },
  },
  {
    // npm only, and that is not an oversight: winget's repository has no
    // Google entry for it, and searching it for "gemini" returns
    // ChatALL, Chatbox and Nekot — third-party chat clients that happen
    // to speak to Gemini. Same trap as the ChatGPT wrappers below.
    //
    // @google/gemini-cli is Google's own: published by google-wombot
    // from google-gemini/gemini-cli, and its bin really is `gemini`.
    key: "gemini",
    label: "Gemini CLI",
    about: "Google's CLI",
    cmd: "gemini",
    configFiles: [".gemini/settings.json"],
    recommended: false,
    npm: "@google/gemini-cli",
  },
  {
    // The winget id is the publisher's: "T3 Tools Inc", support at
    // pingdotgg/t3code. Checked, because npm's `t3code-cli` is a
    // third-party wrapper by an unrelated author whose binary is not
    // even called t3code — installing that under this name would be
    // worse than installing nothing.
    key: "t3code",
    label: "T3 Code",
    about: "T3 Tools' editor",
    cmd: "",
    recommended: false,
    winget: "T3Tools.T3Code",
    desktopOnly: true,
  },
  {
    // Not an agent — the thing agents run inside. It multiplexes them
    // into one terminal and keeps them alive on the far side of an SSH
    // connection, so it belongs in this list even though it does not
    // answer prompts itself.
    //
    // Linux and WSL only, and that falls out of having no winget entry
    // rather than being asserted: availableAgents requires winget,
    // msstore or npm on Windows, and herdr has none. Which is correct
    // — the stable manifest at herdr.dev/latest.json publishes linux
    // and macos assets and no windows one. A Windows build exists only
    // in the preview channel, as a dated .zip, and pulling a preview
    // into a converge is a decision rather than a default.
    //
    // The installer is POSIX sh and lands in ~/.local/bin, which needs
    // no sudo and is already on the PATH red-dev builds.
    key: "herdr",
    label: "Herdr",
    about: "run several coding agents in one terminal, alive over SSH",
    cmd: "herdr",
    recommended: false,
    installer: "https://herdr.dev/install.sh",
    multiplexer: true,
  },
  {
    key: "openclaw",
    label: "OpenClaw",
    about: "personal assistant, any platform",
    cmd: "openclaw",
    recommended: false,
    installer: "https://openclaw.ai/install.sh",
    npm: "openclaw",
  },
  {
    key: "hermes",
    label: "Hermes Agent",
    about: "Nous Research's agent",
    cmd: "hermes",
    recommended: false,
    installer: "https://hermes.nousresearch.com/install.sh",
    // Deliberately the scoped-by-name package: bare `hermes` on npm is
    // an unrelated project at 0.4.x, and installing it would put a
    // completely different binary on PATH under the expected name.
    npm: "hermes-agent",
    runtimeNeeds: ["python@3.13"],
    probeArgs: ["--version"],
  },
  {
    key: "muse",
    label: "Muse",
    about: "Meta's coding agent",
    cmd: "muse",
    recommended: false,
    installer: "https://dev.meta.ai/install.sh",
    // No winget id, and deliberately none guessed.
    //
    // The repository has Muse.MuseHub and Musescore.Musescore, and
    // neither is Meta's. Putting one of those here would install a
    // notation editor under the name of a coding agent — the same
    // mistake the msstore field above exists to prevent, where searching
    // for ChatGPT returns third-party wrappers.
    //
    // So on native Windows Muse is not offered at all: availableAgents
    // requires winget, msstore or npm there, and none of the three is
    // true. Under WSL the installer runs and the binary lands in the
    // distro, which is where a CLI belongs anyway.
  },
  {
    key: "claude-desktop",
    label: "Claude Desktop",
    about: "the desktop app, not the CLI",
    cmd: "",
    recommended: false,
    winget: "Anthropic.Claude",
    desktopOnly: true,
  },
  {
    // Codex Desktop is a mode inside OpenAI's ChatGPT app rather than a
    // separate download, and OpenAI ships it through the Microsoft
    // Store. There is no official Linux build — the CLI above is the
    // Linux answer, which is why this is Windows-only rather than
    // desktop-capable-anywhere.
    key: "codex-desktop",
    label: "Codex Desktop",
    about: "Codex inside OpenAI's ChatGPT app",
    cmd: "",
    recommended: false,
    msstore: "9PLM9XGG6VKS",
    desktopOnly: true,
  },
];

/** Translate the retired OpenCode selection without uninstalling OpenCode itself. */
export function currentAgentKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.map((key) => key === "opencode" ? "redcode" : key))];
}

/** Which agents can be installed here. */
export function availableAgents(p: Platform): AgentSpec[] {
  return AGENTS.filter((a) => {
    if (a.desktopOnly) {
      // A desktop application needs somewhere to draw, and neither of
      // these has an official Linux build. Under WSL they would also be
      // installing onto a host this scope does not own.
      return p.os === "windows";
    }
    if (p.os === "windows") return Boolean(a.release?.windows[p.arch] ?? a.winget ?? a.msstore ?? a.npm);
    return Boolean(a.release?.linux[p.arch] ?? a.installer ?? a.npm);
  });
}

/** Resolve against PATH as it exists now, including tools exposed this run. */
export function commandPath(
  command: string,
  platform: string = process.platform,
): string | null {
  const path = process.env["Path"] ?? process.env["PATH"] ?? "";
  if (platform !== "win32") return Bun.which(command, { PATH: path });

  // On Windows one directory routinely holds both `code` — a shell
  // script for Git Bash, which the OS itself cannot execute — and
  // `code.cmd`, which it can. `where code` lists them in that order and
  // so does `Bun.which`, so taking the first match takes the wrong one
  // exactly when both exist. The extension is not decoration there; it
  // is what makes a file runnable.
  //
  // Measured on the machine that found it: the VS Code extension step
  // failed with `ENOENT: no such file or directory` while `code` was on
  // PATH and working — because what red-dev had resolved was the bash
  // script.
  for (const extension of [".cmd", ".exe", ".bat", ""]) {
    const found = Bun.which(`${command}${extension}`, { PATH: path });
    if (found) return found;
  }
  return null;
}

export function isAgentInstalled(a: AgentSpec): boolean {
  return a.cmd.length > 0 && commandPath(a.cmd) !== null;
}

/** Presence plus the runtime-backed health check declared by the agent. */
export async function isAgentReady(a: AgentSpec): Promise<boolean> {
  if (!isAgentInstalled(a)) return false;
  if (!a.probeArgs) return true;
  const executable = commandPath(a.cmd);
  if (!executable) return false;
  try {
    const proc = Bun.spawn(npmArgv(executable, a.probeArgs), {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      env: await agentRuntimeEnvironment(executable, a),
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Every agent install, routed through the log rather than the console.
 *
 * This used to spawn with stdout and stderr inherited, unconditionally.
 * Under `red-dev install` that is correct — there is no frame to damage.
 * Inside the fullscreen converge it is not: the renderer owns the screen
 * and repaints it, so a child writing directly to the console lands in
 * whatever cell the cursor happens to be in. The result was two streams
 * in one row —
 *
 *     Fou ok  Codex CLI[OpenAI.Codex] Version 0.146.1
 *     No fail T3 Code: cmd.exe exited non-zeroes it grant any licenses
 *
 * — winget's "Found"/"No" colliding with red-dev's own "ok"/"fail", and
 * a progress bar drawn across the panel on the right.
 *
 * spawnLogged is the existing answer and every other provider already
 * used it: inherit when the log is going straight to the terminal, pipe
 * into the log when something is capturing it. The bug was that this
 * file had its own two-line copy of the wrong half.
 */
async function run(cmd: string[], env?: Record<string, string | undefined>): Promise<void> {
  const { spawnLoggedCapture } = await import("./providers.ts");
  const result = await spawnLoggedCapture(cmd, env ? { env } : {});
  if (result.code !== 0) {
    throw new RedError(tlsTrustFailure(result.out + result.err) ?? `${cmd[0]} exited non-zero`);
  }
}

/**
 * The environment a child needs when its executable came from mise.
 *
 * Resolving npm.cmd by absolute path gets npm running — and then npm
 * spawns the package's lifecycle scripts through cmd.exe, which looks
 * `node` up on PATH and does not find it, because mise's install dir
 * was never on this process's PATH either:
 *
 *   npm error 'node' is not recognized as an internal or external command
 *
 * So the directory containing the executable is prepended for the child.
 * That also lets shell installers see a runtime installed earlier in this
 * process, before the parent shell has had a chance to refresh PATH. Both
 * spellings of the variable are set because Windows inherits whichever
 * casing already exists.
 */
export function executablesEnvironment(
  executables: string[],
  platform: string = process.platform,
  current: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const sep = platform === "win32" ? ";" : ":";
  const inherited =
    platform === "win32"
      ? current["Path"] ?? current["PATH"] ?? ""
      : current["PATH"] ?? current["Path"] ?? "";
  const dirs = executables
    .map((executable) => executable.replace(/[\\/][^\\/]+$/, ""))
    .filter((dir, index, all) => {
      const key = platform === "win32" ? dir.toLowerCase() : dir;
      return all.findIndex((candidate) =>
        (platform === "win32" ? candidate.toLowerCase() : candidate) === key
      ) === index;
    });
  const path = [...dirs, inherited].filter(Boolean).join(sep);
  return unattendedEnvironment(current, { PATH: path, Path: path });
}

export function executableEnvironment(
  executable: string,
  platform: string = process.platform,
  current: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return executablesEnvironment([executable], platform, current);
}

export function npmEnvironment(
  npm: string,
  platform: string = process.platform,
  current: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return executableEnvironment(npm, platform, current);
}

/**
 * Exported for the update path, which spawns the same npm against the
 * same host and must not grow a second answer to "what does this child
 * need on its PATH" — see src/agent-update.ts.
 */
export async function agentRuntimeEnvironment(
  executable: string,
  agent: AgentSpec,
): Promise<Record<string, string | undefined>> {
  const { runtimeTool } = await import("./runtimes.ts");
  const executables = [executable];
  for (const runtime of agent.runtimeNeeds ?? []) {
    const name = runtime.split("@")[0]!;
    const executable = await runtimeTool(name);
    if (!executable) {
      throw new RedError(`${agent.label} needs ${runtime}, but mise cannot resolve ${name}`);
    }
    executables.push(executable);
  }
  return executablesEnvironment(executables);
}

/**
 * winget, with the reason it failed kept.
 *
 * `run` above reports `cmd.exe exited non-zero`, which is true and
 * useless — three agents failed with that line and none of them said
 * whether the package was missing, the source was unreachable or the
 * installer had refused. providers.ts::wingetInstall already captures
 * and interprets the output; this is that treatment for the agent path,
 * which had grown its own thinner copy.
 *
 * A non-zero exit is not automatically a failure: winget signals
 * "installed, nothing newer" that way too, and treating it as an error
 * turns the steady state of an idempotent converge into a red line.
 */
async function runWinget(argv: string[], label: string): Promise<void> {
  const { spawnLoggedCapture } = await import("./providers.ts");
  const result = await spawnLoggedCapture(argv);
  const out = result.out + result.err;
  const { code } = result;
  if (code === 0) return;

  if (/No available upgrade found|already installed|No newer package versions/i.test(out)) {
    log.skip(`${label} already current`);
    return;
  }

  const detail = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[-\\|/]+$/.test(l))
    .slice(-2)
    .join(" ");
  throw new RedError(
    /No package found/i.test(out)
      ? `winget has no package for ${label} — the id is case-sensitive`
      : `winget exited ${code}${detail ? `: ${detail}` : ""}`,
  );
}


/**
 * npm's argv, which on Windows is not just the path.
 *
 * mise resolves npm to npm.cmd there, and CreateProcess cannot exec a
 * batch file directly — the same story as winget's reparse point, with
 * the same answer: cmd.exe interprets it.
 */
export function npmArgv(npm: string, args: string[]): string[] {
  const lower = npm.toLowerCase();
  return lower.endsWith(".cmd") || lower.endsWith(".bat")
    ? ["cmd.exe", "/c", npm, ...args]
    : [npm, ...args];
}

/**
 * The npm this converge just made exist, found through mise.
 *
 * Bun.which alone re-created the bug the runtime ordering was meant to
 * fix: PATH is read at process start, so node@lts lands and npm is
 * still "not on PATH" in the very same run. runtimeTool asks mise,
 * whose answer does not depend on when this process was born.
 */
export async function resolveNpm(): Promise<string | null> {
  const { runtimeTool } = await import("./runtimes.ts");
  return await runtimeTool("npm");
}

/** The real Codex binary winget currently leaves without a `codex` alias. */
export function codexPortableExecutable(files: string[]): string | null {
  return (
    files.find((file) => /^codex-(?:x86_64|aarch64)-pc-windows-msvc\.exe$/i.test(file)) ?? null
  );
}

function prependProcessPath(dir: string, platform: string = process.platform): void {
  const current = process.env["Path"] ?? process.env["PATH"] ?? "";
  const separator = platform === "win32" ? ";" : ":";
  const key = (value: string): string => platform === "win32" ? value.toLowerCase() : value;
  const entries = current.split(separator);
  if (entries.some((entry) => key(entry) === key(dir))) return;
  const path = [dir, current].filter(Boolean).join(separator);
  process.env["Path"] = path;
  process.env["PATH"] = path;
}

/**
 * Make a winget-installed agent usable before this process is restarted.
 *
 * Winget updates the user PATH but cannot update the environment of the
 * red-dev process that launched it. Codex also currently has a second issue:
 * its portable package contains the real executable but publishes no `codex`
 * link under WinGet/Links. Refreshing only PATH therefore still leaves that
 * package listed as installed and impossible to invoke.
 */
async function exposeWindowsAgentCommand(a: AgentSpec): Promise<void> {
  if (!a.winget || !a.cmd) return;
  const local = process.env["LOCALAPPDATA"];
  if (!local) return;

  const packageDir = `${local}\\Microsoft\\WinGet\\Packages\\${a.winget}_Microsoft.Winget.Source_8wekyb3d8bbwe`;
  if (existsSync(packageDir)) prependProcessPath(packageDir);
  if (a.key !== "codex") return;

  let executable: string | null = null;
  try {
    executable = codexPortableExecutable(readdirSync(packageDir));
  } catch {
    return;
  }
  if (!executable) return;

  const { windowsBinDir } = await import("./providers.ts");
  const bin = windowsBinDir();
  mkdirSync(bin, { recursive: true });
  const target = `${packageDir}\\${executable}`;
  const exposed = `${bin}\\codex.exe`;
  // A .cmd wrapper is visible to PowerShell but Git Bash does not find
  // it by the extensionless name. An .exe works in both shells. Refresh
  // the command every time winget runs so an agent upgrade cannot leave
  // it on the previous version. Both paths live under LOCALAPPDATA and
  // therefore on one volume, so a hard link normally costs no second
  // 343 MB copy; the copy is the conservative fallback.
  try {
    if (existsSync(exposed)) unlinkSync(exposed);
    linkSync(target, exposed);
  } catch {
    copyFileSync(target, exposed);
  }
  prependProcessPath(bin);
  log.ok("Codex CLI command exposed as codex");
}

export type AgentInstallMethod =
  | "mise"
  | "msstore"
  | "winget"
  | "npm"
  | "installer"
  | "github-release";

/** Choose a method that can run unattended on this target. */
export function agentInstallMethod(a: AgentSpec, p: Platform): AgentInstallMethod | null {
  // First, and only for a host we publish: mise owns version resolution,
  // download, checksum and the shim for the rest of this organisation's
  // suite, and a host of ours is not different in kind from `red` or
  // `tq`.
  //
  // Not conditioned on mise being present, though the first draft was.
  // This function is asked what mechanism a host *has*, and the answer
  // must not change with the machine it is asked on — a probe here made
  // it disagree with itself between a developer's box and CI. mise is
  // core's first tool and red-dev is itself installed by it, so a run
  // that reaches an agent has one; where it somehow does not,
  // `installAgent` says so in those words rather than quietly picking a
  // mechanism nothing will maintain.
  if (a.mise) return "mise";
  const release = p.os === "windows" ? a.release?.windows[p.arch] : a.release?.linux[p.arch];
  if (release) return "github-release";
  if (p.os === "windows" && a.msstore) return "msstore";
  if (p.os === "windows" && a.winget) return "winget";
  if (p.os === "windows" && a.npm) return "npm";
  // WSL synchronization has no terminal from which sudo can read a
  // password. The npm packages are the vendor-published unattended path.
  if (p.env === "wsl" && a.npm) return "npm";
  if (a.installer) return "installer";
  if (a.npm) return "npm";
  return null;
}

export async function installAgent(a: AgentSpec, p: Platform): Promise<void> {
  const method = agentInstallMethod(a, p);

  if (method === "mise" && a.mise) {
    // `use -g`, the same verb every other tool in the suite is placed
    // with: it installs, writes the pin into the global config and
    // leaves a shim on PATH, so the next `mise upgrade` knows this host
    // exists. `ghInstallExactArchive` below places a file and leaves
    // nothing that knows how to move it — which is the whole reason
    // this branch is here.
    const { useRuntimes } = await import("./runtimes.ts");
    await useRuntimes([`${a.mise}@latest`]);
    return;
  }

  if (method === "github-release" && a.release) {
    const asset = p.os === "windows" ? a.release.windows[p.arch] : a.release.linux[p.arch];
    if (!asset) throw new RedError(`no ${p.os}/${p.arch} release asset for ${a.label}`);
    const { ghInstallExactArchive } = await import("./providers.ts");
    await ghInstallExactArchive(a.release.repo, asset, a.cmd, p);
    return;
  }

  if (method === "msstore" && a.msstore) {
    // --source msstore is load-bearing, not a detail: without it winget
    // resolves the id against the community repository, where the
    // ChatGPT entries belong to third parties rather than OpenAI.
    const { wingetArgv } = await import("./providers.ts");
    await runWinget(
      wingetArgv([
        "install",
        "--id",
        a.msstore,
        "--source",
        "msstore",
        "--exact",
        "--accept-package-agreements",
        "--accept-source-agreements",
        // See wingetInstall: winget's progress UI is drawn against
        // CONOUT$ and ignores a redirected stdout, so without this it
        // paints over the converge frame no matter how the child is
        // spawned.
        "--disable-interactivity",
      ]),
      a.label,
    );
    return;
  }

  if (method === "winget" && a.winget) {
    const { wingetArgv } = await import("./providers.ts");
    await runWinget(
      wingetArgv([
        "install",
        "--id",
        a.winget,
        "--exact",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
        // See wingetInstall: winget's progress UI is drawn against
        // CONOUT$ and ignores a redirected stdout, so without this it
        // paints over the converge frame no matter how the child is
        // spawned.
        "--disable-interactivity",
      ]),
      a.label,
    );
    await exposeWindowsAgentCommand(a);
    return;
  }

  // npm before the vendor installer where the installer cannot run.
  //
  // The order used to be installer-then-npm everywhere, and on Windows
  // that picked the wrong one for every agent that has both. OpenClaw
  // and Hermes ship POSIX shell installers that expect sudo and a Unix
  // filesystem; run there they failed with `Executable not found in
  // $PATH: "sudo"` while a perfectly good npm package sat unused in the
  // same spec.
  //
  // Native Linux keeps the official installer. WSL uses npm for agents
  // that publish it because the Windows-side synchronizer is deliberately
  // non-interactive and cannot prime or answer a sudo password prompt.
  if (method === "installer" && a.installer) {
    const { installerInstall } = await import("./providers.ts");
    await installerInstall(a.installer, `${a.label} official installer`);
    return;
  }

  if (method === "npm" && a.npm) {
    const npm = await resolveNpm();
    if (!npm) throw new RedError("no npm anywhere — not on PATH, and mise has no node. Run `red-dev install core`");
    const env = await agentRuntimeEnvironment(npm, a);
    await run(
      npmArgv(npm, ["install", "-g", a.npm]),
      // Mise wraps npm global installs with an implicit `mise reshim` after
      // npm has already succeeded. That second command has no deadline and
      // can strand a WSL converge forever at "Reshimming mise 24...". A
      // red-dev shell activates mise and therefore exposes the package from
      // Node's bin directory without this extra global shim pass.
      { ...env, MISE_SKIP_RESHIM: "1" },
    );
    // npm places global command links beside itself under a mise-managed
    // Node. Make them visible to the rest of this same converge; the next
    // shell will get the same directory from `mise activate`.
    prependProcessPath(npm.replace(/[\\/][^\\/]+$/, ""));
    return;
  }

  throw new RedError(`no install method for ${a.label} on this platform`);
}

/**
 * Put the RedSkills package set on this machine.
 *
 * There used to be a `curl | sh` here: the standalone `install.sh`,
 * downloaded from the repo's `v3` branch on every run, which registered
 * its own marketplaces, generated its own host surfaces and owned
 * `~/.red/skills/current`. ADR 0010 ends it. The set is one acquisition
 * — a verified, signed, immutable revision staged under its own name —
 * and this is a call into it rather than a second implementation beside
 * it, because two acquisition paths on one machine is exactly how the
 * hosts and the editor extension came to be on different revisions.
 *
 * A refusal throws, because the caller asked for a source and there
 * isn't one. Everything else — already current, nothing published,
 * a remote that could not be reached — is a machine that still resolves
 * whatever it resolved before, and is reported rather than raised.
 */
export async function installRedSkills(p?: Platform): Promise<void> {
  const { acquireRedSkills, announce } = await import("./red-skills-acquire.ts");
  log.step("red-skills");
  log.plain("     Acquires the complete RedSkills package set: the plugin payloads,");
  log.plain("     the host generators and every companion artifact, from one revision.");

  // Before the acquisition, because the acquisition cannot get past it.
  // A package set activates by putting a link at `~/.red/skills/current`
  // and src/red-skills-set.ts refuses to remove a real directory sitting
  // there — correctly, since deleting a directory it did not create is
  // not its business. Spec #185's Git Bash copy is exactly such a
  // directory, and it is the one shape of that blockage red-dev can
  // prove it owns, from the two markers the standalone tarball carries.
  const home = process.env["USERPROFILE"] ?? process.env["HOME"];
  if (home && repairCopiedRedSkillsCurrent(home)) {
    log.plain("       replacing Git Bash's copied current snapshot with the package set link");
  }

  const acquisition = await acquireRedSkills(p ? { manifestPlatform: p } : {});
  announce(acquisition);
  if (acquisition.outcome === "refused") throw new RedError(acquisition.reason);
}

/**
 * Remove Git Bash's directory-copy emulation of the RedSkills `current` link.
 *
 * A Spec #185 leftover, and the only one the adoption in
 * src/red-skills-adopt.ts cannot reach: its walk covers
 * `~/.red/skills/versions`, and this is a copy of one of those trees
 * standing on the path the package set has to link. The two markers the
 * standalone tarball carries are what keep a similarly named user
 * directory out of scope — without both of them this declines, and the
 * package set declines too, and the machine keeps what it has.
 */
export function repairCopiedRedSkillsCurrent(
  home: string,
  platform: string = process.platform,
): boolean {
  if (platform !== "win32") return false;
  const root = home.replace(/\\/g, "/");
  const current = redSkillsCurrentPosix(root);
  try {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (!existsSync(`${current}/.claude-plugin/marketplace.json`)) return false;
    if (!existsSync(`${current}/.upstream`)) return false;
    rmSync(current, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Advance the red-skills checkout, and the two artifacts beside it.
 *
 * convergeRedSkills asks whether red-skills is *wired*, and a wired
 * machine is one it has nothing left to do on — which is the right
 * answer for `install` and the wrong one for `update`. The checkout at
 * ~/.red/skills/current froze at the version that first wired this
 * machine and stayed there, while Claude's own plugin cache went on
 * updating through the marketplace. Two copies, and the one everything
 * resolved through was the stationary one.
 *
 * So this is update's business, not converge's. What it does about it
 * has changed, though: the acquisition now belongs to the staged
 * reconciliation in src/staged-update.ts, which runs immediately before
 * this on the same `red-dev update` and has already put the machine on
 * one revision under ADR 0010's Workers rule. Re-acquiring here would
 * be a second network round trip for one update, and — worse — a second
 * chance for the two paths to land on different revisions. So this
 * refreshes what the staged update does not own and then *reports*
 * which revision the machine ended on, rather than fetching one.
 */
export async function updateRedSkills(p: Platform): Promise<void> {
  // Before the early return below, not after it. The Product skill is
  // red-dev's own and does not come out of the red-skills tarball, so a
  // machine with agents and no marketplace still has product knowledge
  // to refresh — and refreshing it here is what stops it freezing at
  // whatever the install-day converge wrote.
  const { refreshProductSkill } = await import("./product-skill.ts");
  await refreshProductSkill(p);

  const { sourceRoot } = await import("./red-skills-ext.ts");

  // The companions before the early return, and out of the set rather
  // than out of a release. They used to be resolved from GitHub here,
  // which is what let an editor extension and the agent hosts on one
  // machine come from two different revisions; now both read the same
  // digest, and a machine whose set has not moved does nothing.
  await convergeRedSkillsCompanions(p);

  if (!sourceRoot()) {
    log.skip("red-skills: not installed, nothing to advance");
    return;
  }

  // Read off the package-set state rather than off the link, because
  // the identity of a revision is its version and whole-set digest and
  // never just the directory it happens to sit in (ADR 0011).
  const { formatPackageSetIdentity, readPackageSetState } = await import("./red-skills-set.ts");
  const state = readPackageSetState(homeDir());
  const active = state.revisions.find((r) => r.key === state.active) ?? null;
  if (active === null) log.skip("red-skills: no package set is active on this machine");
  else log.ok(`red-skills at ${formatPackageSetIdentity(active)}`);
}

/** This user's home, in the one spelling every path here is built from. */
function homeDir(): string {
  return (process.env["HOME"] ?? process.env["USERPROFILE"] ?? "").replace(/\\/g, "/");
}

/**
 * The hosts red-skills wires into, and how each one answers.
 *
 * A table rather than one probe, because "is red-skills installed" is
 * not a question with a single answer. The installer configures every
 * CLI it detects, so a machine that had only Claude when it last ran and
 * has Codex now is wired for one and not the other — and the first
 * version of this asked Claude alone and let Claude speak for the set,
 * which would have left exactly that machine unwired forever.
 *
 * Each host answers in its own currency, and all three were checked on
 * a real machine rather than assumed:
 *
 *   claude    `claude plugin marketplace list`  names red-skills
 *   codex     `codex plugin marketplace list`   names red-skills
 *   redcode   no such command — the installer leaves an uninstall
 *             manifest, which is the only artifact that means "we did
 *             this" rather than "a directory exists"
 */
export interface SkillHost {
  /** Key in AGENTS, so the two lists cannot drift apart silently. */
  agent: string;
  /** Command that proves this host is installed at all. */
  cmd: string;
  /** Whether red-skills is wired into this host specifically. */
  wired: () => Promise<boolean>;
}

/** Does this CLI name red-skills among its marketplaces? */
async function cliNamesRedSkills(cmd: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const out = (await new Response(proc.stdout).text()).toLowerCase();
    await proc.exited;
    return out.includes("red-skills");
  } catch {
    // A question that cannot be asked is not a no. Answering yes means a
    // converge does nothing, rather than reinstalling on every run
    // against a CLI that is broken for unrelated reasons.
    return true;
  }
}

/**
 * Where the marketplace registration is decided, and why it is not here.
 *
 * This file used to hold the other side of it: a pair of probes asking
 * whether each host's marketplace pointed at GitHub, and a pair of
 * repairs that repointed a directory-registered host back at
 * `reddb-io/red-skills`. That was right while nothing on the machine
 * moved `~/.red/skills/current` — a directory source meant a host frozen
 * at its install-day snapshot, reporting "Updated today" against a
 * version a week behind.
 *
 * mise moves it now, so the directory is the only source pinned to the
 * version this machine resolved, and red-dev registers from it. Keeping
 * the repair beside that would be one converge evicting the registration
 * the previous one made — the endless eviction the arbitration exists to
 * end, with both ends of it in this repo.
 *
 * red-skills-registration.ts owns all of it: the boundary read, the
 * declaration, and the read-back that proves it took.
 */

function configHome(): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  return `${home.replace(/\\/g, "/")}/.config`;
}

export const SKILL_HOSTS: SkillHost[] = [
  {
    agent: "claude-code",
    cmd: "claude",
    wired: () => cliNamesRedSkills(["claude", "plugin", "marketplace", "list"]),
  },
  {
    agent: "codex",
    cmd: "codex",
    wired: () => cliNamesRedSkills(["codex", "plugin", "marketplace", "list"]),
  },
  {
    agent: "redcode",
    cmd: "redcode",
    // RedCode has no marketplace to list: red-skills generates plugin
    // and skill modules into its config directory and records them in an
    // uninstall manifest. That file is the claim; the directory existing
    // is not, since redcode makes it itself.
    wired: async () =>
      existsSync(`${configHome()}/redcode/redskills-install-manifest.txt`),
  },
];

/** Installed hosts that red-skills has not been wired into. */
export async function unwiredSkillHosts(): Promise<SkillHost[]> {
  const present = SKILL_HOSTS.filter((h) => commandPath(h.cmd));
  const out: SkillHost[] = [];
  for (const h of present) {
    if (!(await h.wired())) out.push(h);
  }
  return out;
}

/**
 * Put red-skills where the agents can see it, as part of a converge.
 *
 * It used to run in exactly two places — the first-run interview and
 * behind a confirm in `red-dev agents` — so a plain `install core`, and
 * therefore the install script, never set it up. A machine could carry
 * four coding agents and no marketplace, which is what this one did.
 *
 * One installer run wires every host it detects, so finding a single
 * unwired one is reason enough to run it: installing Codex a week after
 * Claude has to be enough to get the marketplace into it.
 *
 * Skipped loudly with no host installed: red-skills configures agents,
 * and with no agent to configure it has nothing to do.
 */
export interface RedSkillsConverge {
  /** One outcome per host in table order, including the ones left alone. */
  hosts: HostOutcome[];
  /** The same, per companion. */
  companions: CompanionOutcome[];
}

export async function convergeRedSkills(
  p: Platform,
  trigger: Trigger = "unknown",
): Promise<RedSkillsConverge> {
  // The companions first, and deliberately above the guard below: the
  // runtimes, the daemon, herdr, the editor extension and zellij's
  // dashboard are RedSkills on this workstation whether or not a coding
  // agent is installed on it, and gating them on one would leave a
  // machine with an editor and no coder holding none of them.
  const companions = await convergeRedSkillsCompanions(p, trigger);

  const present = SKILL_HOSTS.filter((h) => commandPath(h.cmd));
  if (present.length === 0) {
    log.skip("red-skills: no coding agent installed to configure");
    return { hosts: [], companions };
  }

  // Ahead of every early return under it. red-dev owns this file, so it
  // is current whenever red-dev has run — including on the ordinary
  // converge where red-skills itself is already wired and there is
  // nothing else to do here.
  const { refreshProductSkill } = await import("./product-skill.ts");
  await refreshProductSkill(p);

  const missing = await unwiredSkillHosts();
  if (missing.length === 0) {
    log.skip(`red-skills already wired into ${present.map((h) => h.cmd).join(", ")}`);
  } else {
    log.step(`red-skills: not wired into ${missing.map((h) => h.cmd).join(", ")}`);
  }

  // A source, where this machine has none — and the package set, never
  // the standalone installer. This used to run whenever a host looked
  // unwired, which meant re-downloading and re-running an installer to
  // fix a marketplace registration; the wiring is the reconciliation
  // below, and the only thing an absent source is a reason to do is
  // acquire one.
  const { sourceRoot } = await import("./red-skills-ext.ts");
  if (sourceRoot() === null) await installRedSkills(p);

  if (missing.length > 0 && commandPath("redcode")) {
    // The RedSkills generator owns the provider/MCP portions of opencode.json;
    // red-dev owns terminal-following theme/input defaults. Re-apply our small
    // merge after generation so a first RedCode migration converges in one run.
    const { applyRedcode } = await import("./terminal-surfaces.ts");
    await applyRedcode(p);
  }

  // After the installer, never before it, because red-dev has the last
  // word on this machine. The standalone one-liner registers from GitHub
  // wherever it runs — including from the line above — and where red-dev
  // is present the directory it advances is the declared source. Running
  // this first would leave the installer's registration standing until
  // the next converge.
  //
  // Free when the registration is already ours: the hosts are asked what
  // they recorded, and an ordinary converge issues no commands at all.
  const { convergeMarketplaceOwnership } = await import("./red-skills-registration.ts");
  await convergeMarketplaceOwnership(p);

  // On both paths, and where the early return used to be. Being wired is
  // not the same as being current: mise advances the set underneath a
  // machine that was wired months ago, and the hosts read caches and
  // generated trees that only move when something tells them to.
  //
  // Free when nothing moved — a host whose recorded set digest, mode and
  // observed state all still hold is skipped, so an ordinary converge
  // issues no host commands at all. It is not free the moment any of them
  // stops holding, which is the whole difference from the path-only stamp
  // this replaced: a checkout edited in place keeps its path.
  const { reconcileSkillHosts, reconciliationFailed, stuckHosts } = await import(
    "./red-skills-hosts.ts"
  );
  const hosts = await reconcileSkillHosts(p);

  // A host that did not converge does not roll back the ones that did —
  // the plugin managers offer no cross-host transaction, and undoing six
  // good hosts because the seventh is broken would cost more than it
  // saves. It is said out loud instead, once, naming them: partial state
  // is visible and retryable, and silence is what turns it into a machine
  // nobody knows is half-wired.
  if (reconciliationFailed(hosts)) {
    const stuck = stuckHosts(hosts);
    log.warn(`red-skills: not reconciled into ${stuck.map((h) => h.host).join(", ")}`);
    for (const h of stuck) log.plain(`       ${h.host}: ${h.reason ?? "no reason given"}`);
  }

  // A host can converge and still have less than the one beside it —
  // Gemini has no hook runner, and a set may declare no MCP for anybody.
  // Said out loud on the converge that observed it, not only in doctor:
  // "seven hosts reconciled" read without this is a claim that all seven
  // got the same thing, which is the misdescription the record exists to
  // prevent. Skipped hosts say it too, out of what they recorded.
  for (const h of hosts) {
    for (const gap of h.missing ?? []) log.skip(`${h.host}: ${gap}`);
  }

  // Last, and gated on everything above it. A machine provisioned by
  // Spec #185 carries a whole second RedSkills, and ADR 0010 says it is
  // adopted and backed up first and its obsolete ownership removed only
  // once the package set, every host and every companion have verified.
  // The outcomes this run just observed are what it is gated on — not a
  // record from an earlier converge, and not the mere existence of a
  // `current` link, which is what an ungated cleanup mistook for a
  // working workstation.
  await adoptSpec185Workstation(hosts, companions);

  // Both halves, to whoever asked. The converge is what observed them,
  // and a caller that has to re-probe to learn what just happened is a
  // caller that can be told something different from what was done.
  return { hosts, companions };
}

/**
 * Adopt whatever Spec #185 left, on the evidence of this converge.
 *
 * Isolated and never allowed to fail the converge: the machine that has
 * just verified seven hosts and five companions is a working machine
 * whether or not a gigabyte of leftovers came off it, and a throw here
 * would report the whole reconciliation as broken over a directory that
 * could not be unlinked.
 */
async function adoptSpec185Workstation(
  hosts: readonly HostOutcome[],
  companions: readonly CompanionOutcome[],
): Promise<void> {
  try {
    const { adoptLegacyWorkstation, announceAdoption } = await import("./red-skills-adopt.ts");
    const { readPackageSetState } = await import("./red-skills-set.ts");
    const home = homeDir();
    const state = readPackageSetState(home);
    const active = state.revisions.find((r) => r.key === state.active) ?? null;
    const adoption = await adoptLegacyWorkstation({
      home,
      verify: async () => ({
        active: active
          ? { version: active.version, digest: active.digest, sourceCommit: active.sourceCommit }
          : null,
        hosts,
        companions,
      }),
    });
    // Silent on the machine that has nothing to adopt, which is every
    // machine provisioned after Spec #185 and every one already adopted.
    if (adoption.outcome !== "clean") announceAdoption(adoption);
  } catch (err) {
    log.warn(`red-skills adoption: ${(err as Error).message}`);
  }
}

/**
 * The rest of the RedSkills workstation, out of the same set.
 *
 * The runtimes on PATH, the daemon, the herdr plugin, the VS Code
 * extension and zellij's dashboard are converged from artifacts inside
 * the same package set the hosts are reconciled against — so the version
 * an operator types is the version their agents read, which is the drift
 * Spec #201 exists to end. Free when nothing moved, for the same reason
 * the host walk is: a companion whose recorded digest, artifact version
 * and observed state all still hold issues no commands at all.
 *
 * A companion the set does not carry yet is `unavailable` and is not a
 * failure; one that refused is, and is said out loud without taking the
 * artifact the machine was already using with it.
 */
export async function convergeRedSkillsCompanions(
  p: Platform,
  trigger: Trigger = "unknown",
): Promise<CompanionOutcome[]> {
  const { reconcileCompanions, companionReconciliationFailed, stuckCompanions } = await import(
    "./red-skills-companions.ts"
  );
  const companions = await reconcileCompanions(p, { trigger });
  if (companionReconciliationFailed(companions)) {
    const stuck = stuckCompanions(companions);
    log.warn(`red-skills: companions not converged: ${stuck.map((c) => c.companion).join(", ")}`);
    for (const c of stuck) log.plain(`       ${c.companion}: ${c.reason ?? "no reason given"}`);
  }
  return companions;
}
