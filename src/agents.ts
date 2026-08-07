/**
 * Coding agents, and the skills that go with them.
 *
 * These moved out of `core` because installing five agents on every
 * machine is a decision nobody made — they were unconditional before,
 * which is not the same as chosen. They are offered pre-ticked where
 * they used to be automatic, so the default behaviour is unchanged and
 * the answer is now the user's.
 *
 * red-skills is the reason this is a group rather than loose entries:
 * it registers a marketplace in Claude Code and Codex CLI and generates
 * plugin modules for OpenCode, so it is only meaningful once at least
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
import type { Platform } from "./platform.ts";

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
  /** Runtimes an npm lifecycle script needs in addition to Node itself. */
  runtimeNeeds?: string[];
  /** A command that must start successfully before presence counts as ready. */
  probeArgs?: string[];
  /** Desktop applications have no CLI and only exist on some targets. */
  desktopOnly?: boolean;
}

export const AGENTS: AgentSpec[] = [
  {
    key: "claude-code",
    label: "Claude Code",
    about: "Anthropic's CLI",
    cmd: "claude",
    recommended: true,
    installer: "https://claude.ai/install.sh",
    winget: "Anthropic.ClaudeCode",
  },
  {
    key: "codex",
    label: "Codex CLI",
    about: "OpenAI's CLI",
    cmd: "codex",
    recommended: true,
    winget: "OpenAI.Codex",
    npm: "@openai/codex",
  },
  {
    key: "opencode",
    label: "OpenCode",
    about: "SST's terminal agent",
    cmd: "opencode",
    recommended: true,
    installer: "https://opencode.ai/install",
    winget: "SST.opencode",
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

/** Which agents can be installed here. */
export function availableAgents(p: Platform): AgentSpec[] {
  return AGENTS.filter((a) => {
    if (a.desktopOnly) {
      // A desktop application needs somewhere to draw, and neither of
      // these has an official Linux build. Under WSL they would also be
      // installing onto a host this scope does not own.
      return p.os === "windows";
    }
    if (p.os === "windows") return Boolean(a.winget ?? a.msstore ?? a.npm);
    return Boolean(a.installer ?? a.npm);
  });
}

export function isAgentInstalled(a: AgentSpec): boolean {
  return a.cmd.length > 0 && Bun.which(a.cmd) !== null;
}

/** Presence plus the runtime-backed health check declared by the agent. */
export async function isAgentReady(a: AgentSpec): Promise<boolean> {
  if (!isAgentInstalled(a)) return false;
  if (!a.probeArgs) return true;
  const executable = Bun.which(a.cmd);
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
  const { spawnLogged } = await import("./providers.ts");
  const code = await spawnLogged(cmd, env ? { env } : {});
  if (code !== 0) throw new RedError(`${cmd[0]} exited non-zero`);
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
  return { ...current, PATH: path, Path: path };
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

async function agentRuntimeEnvironment(
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
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  const code = await proc.exited;
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
function npmArgv(npm: string, args: string[]): string[] {
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
async function resolveNpm(): Promise<string | null> {
  const { runtimeTool } = await import("./runtimes.ts");
  return await runtimeTool("npm");
}

/** The real Codex binary winget currently leaves without a `codex` alias. */
export function codexPortableExecutable(files: string[]): string | null {
  return (
    files.find((file) => /^codex-(?:x86_64|aarch64)-pc-windows-msvc\.exe$/i.test(file)) ?? null
  );
}

function prependProcessPath(dir: string): void {
  const current = process.env["Path"] ?? process.env["PATH"] ?? "";
  const entries = current.split(";");
  if (entries.some((entry) => entry.toLowerCase() === dir.toLowerCase())) return;
  const path = `${dir};${current}`;
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

export type AgentInstallMethod = "msstore" | "winget" | "npm" | "installer";

/** Choose a method that can run unattended on this target. */
export function agentInstallMethod(a: AgentSpec, p: Platform): AgentInstallMethod | null {
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
    await run(
      npmArgv(npm, ["install", "-g", a.npm]),
      await agentRuntimeEnvironment(npm, a),
    );
    return;
  }

  throw new RedError(`no install method for ${a.label} on this platform`);
}

/**
 * Install red-skills, which configures whichever agents are present.
 *
 * Run after the agents rather than before: its installer detects what
 * exists and wires each one up, so running it first would configure
 * nothing and report success.
 */
export async function installRedSkills(): Promise<void> {
  const url = "https://raw.githubusercontent.com/reddb-io/red-skills/v3/scripts/install.sh";
  const { installerInstall } = await import("./providers.ts");
  const { runtimeTool } = await import("./runtimes.ts");
  const node = await runtimeTool("node");
  log.step("red-skills");
  log.plain("     Registers the RedSkills marketplace in Claude Code and Codex,");
  log.plain("     and generates plugin modules for OpenCode. User-level, global.");
  const home = process.env["USERPROFILE"] ?? process.env["HOME"];
  if (home && repairCopiedRedSkillsCurrent(home)) {
    log.plain("       replacing Git Bash's copied current snapshot with the managed source");
  }
  const install = async () =>
    await installerInstall(
      url,
      "reddb-io/red-skills",
      [],
      node ? executableEnvironment(node) : undefined,
    );
  try {
    await install();
  } catch (error) {
    if (!home || !repairCopiedRedSkillsCurrent(home)) throw error;
    log.plain("       retrying with the release assets now cached");
    await install();
  }
}

/**
 * Remove Git Bash's directory-copy emulation of the RedSkills `current` link.
 *
 * Its installer owns this path and recreates it immediately. The two markers
 * keep a similarly named user directory out of scope.
 */
export function repairCopiedRedSkillsCurrent(
  home: string,
  platform: string = process.platform,
): boolean {
  if (platform !== "win32") return false;
  const root = home.replace(/\\/g, "/");
  const current = `${root}/.red-skills/current`;
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
 * Advance the red-skills checkout, and rebuild what was built from it.
 *
 * convergeRedSkills asks whether red-skills is *wired*, and a wired
 * machine is one it has nothing left to do on — which is the right
 * answer for `install` and the wrong one for `update`. The checkout at
 * ~/.red-skills/current froze at the version that first wired this
 * machine and stayed there, while Claude's own plugin cache went on
 * updating through the marketplace. Two copies, one advancing, and the
 * one everything here builds from was the stationary one.
 *
 * So this is update's business, not converge's: the installer is
 * re-run, which is what fetches the newest tarball and repoints
 * `current`, and then anything built from that tree is rebuilt against
 * where it now points.
 */
export async function updateRedSkills(p: Platform): Promise<void> {
  const { sourceRoot, refreshRedSkillsExtensions } = await import("./red-skills-ext.ts");
  if (!sourceRoot()) {
    log.skip("red-skills: not installed, nothing to advance");
    return;
  }

  const { realpathSync } = await import("node:fs");
  const before = realpathSync(sourceRoot() as string);
  await installRedSkills();
  const after = realpathSync(sourceRoot() as string);
  if (before === after) log.skip(`red-skills already at ${after.split("/").pop()}`);
  else log.ok(`red-skills ${before.split("/").pop()} → ${after.split("/").pop()}`);

  await refreshRedSkillsExtensions(p);
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
 *   opencode  no such command — the installer leaves an uninstall
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
 * Whether Claude's marketplace points at GitHub rather than at a
 * directory on this disk.
 *
 * The vendor installer registers `~/.red-skills/current`, which is a
 * symlink into a versioned snapshot taken the day it ran. Claude then
 * does exactly what it was asked: auto-update re-reads that directory,
 * finds it unchanged, and records a fresh lastUpdated. The machine
 * reports "Updated today" and sits on the version it was installed
 * with — 3.3.0 against 3.3.7 upstream, for a week, with nothing
 * anywhere saying so.
 *
 * "Is red-skills in the list" cannot see that: the name is present
 * either way. The source is what distinguishes a marketplace that can
 * receive updates from one that only appears to.
 */
export async function claudeMarketplaceIsGithub(): Promise<boolean | null> {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!home) return null;
  const path = `${home.replace(/\\/g, "/")}/.claude/plugins/known_marketplaces.json`;
  if (!existsSync(path)) return null;
  try {
    const known = JSON.parse(await Bun.file(path).text()) as Record<
      string,
      { source?: { source?: string } }
    >;
    const entry = known["red-skills"];
    if (!entry) return null;
    return entry.source?.source === "github";
  } catch {
    // Unreadable is not the same as wrong. Null means "no opinion", and
    // the caller leaves the machine alone rather than repointing a
    // marketplace on a guess.
    return null;
  }
}

function tomlStringValue(line: string, key: string): string | null {
  const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`));
  return match?.[1] ?? null;
}

/**
 * Whether Codex's marketplace points at GitHub rather than a local
 * red-skills snapshot.
 *
 * Codex records marketplace sources in config.toml. A local source has
 * the same failure mode as Claude's directory marketplace: RedSkills
 * appears installed and enabled, but MCP launchers that fall back to
 * Codex's Git marketplace checkout have nowhere to go.
 */
export async function codexMarketplaceIsGithub(): Promise<boolean | null> {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!home) return null;
  const path = `${home.replace(/\\/g, "/")}/.codex/config.toml`;
  if (!existsSync(path)) return null;

  try {
    const lines = (await Bun.file(path).text()).split(/\r?\n/);
    let inTable = false;
    for (const line of lines) {
      const table = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (table) {
        inTable = table[1] === "marketplaces.red-skills";
        continue;
      }
      if (!inTable) continue;
      const sourceType = tomlStringValue(line, "source_type");
      if (sourceType !== null) return sourceType === "git";
    }
    return null;
  } catch {
    // Unreadable is not the same as wrong. Null means "no opinion", and
    // the caller leaves the machine alone rather than repointing a
    // marketplace on a guess.
    return null;
  }
}

/**
 * Repoint Claude's marketplace from the frozen directory to GitHub.
 *
 * Remove, re-add by repo, reinstall the plugins — the same five steps
 * anyone doing this by hand runs, because there is no `marketplace
 * set-source`. The plugins have to be reinstalled: they were installed
 * from a marketplace that no longer exists under that name.
 *
 * Not destructive in any way that matters. Everything removed here is
 * re-created from the origin in the same run, and the source cache under
 * ~/.red-skills is left alone.
 */
export async function repointClaudeMarketplace(): Promise<void> {
  const { spawnLogged } = await import("./providers.ts");
  log.step("red-skills: marketplace points at a local directory — repointing at GitHub");
  log.plain("     A directory source cannot receive updates. Claude re-reads the");
  log.plain("     same snapshot and records a new timestamp, so a stuck machine");
  log.plain("     reports itself as current.");

  await spawnLogged(["claude", "plugin", "marketplace", "remove", "red-skills"]);
  if ((await spawnLogged(["claude", "plugin", "marketplace", "add", "reddb-io/red-skills"])) !== 0) {
    throw new RedError("could not add the red-skills marketplace from GitHub");
  }
  for (const plugin of ["dev", "memory", "brain"]) {
    await spawnLogged(["claude", "plugin", "install", `${plugin}@red-skills`]);
  }
  log.ok("red-skills marketplace now tracks reddb-io/red-skills");
}

/**
 * Repoint Codex's marketplace from a local snapshot to GitHub.
 *
 * Codex keeps plugin enablement when a marketplace is removed, but the
 * explicit add calls refresh the cache for the three RedSkills plugins
 * that contribute skills, hooks, and MCP servers.
 */
export async function repointCodexMarketplace(): Promise<void> {
  const { spawnLogged } = await import("./providers.ts");
  log.step("red-skills: Codex marketplace points at a local directory — repointing at GitHub");
  log.plain("     A local Codex marketplace can leave MCP launchers looking");
  log.plain("     for a Git marketplace checkout that does not exist.");

  if ((await spawnLogged(["codex", "plugin", "marketplace", "remove", "red-skills"])) !== 0) {
    throw new RedError("could not remove the local red-skills marketplace from Codex");
  }
  if ((await spawnLogged(["codex", "plugin", "marketplace", "add", "reddb-io/red-skills"])) !== 0) {
    throw new RedError("could not add the red-skills marketplace to Codex from GitHub");
  }
  for (const plugin of ["dev", "memory", "brain"]) {
    if ((await spawnLogged(["codex", "plugin", "add", `${plugin}@red-skills`])) !== 0) {
      throw new RedError(`could not install ${plugin}@red-skills into Codex`);
    }
  }
  log.ok("Codex red-skills marketplace now tracks reddb-io/red-skills");
}

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
    agent: "opencode",
    cmd: "opencode",
    // OpenCode has no marketplace to list: red-skills generates plugin
    // and skill modules into its config directory and records them in an
    // uninstall manifest. That file is the claim; the directory existing
    // is not, since opencode makes it itself.
    wired: async () =>
      existsSync(`${configHome()}/opencode/redskills-install-manifest.txt`),
  },
];

/** Installed hosts that red-skills has not been wired into. */
export async function unwiredSkillHosts(): Promise<SkillHost[]> {
  const present = SKILL_HOSTS.filter((h) => Bun.which(h.cmd));
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
export async function convergeRedSkills(p: Platform): Promise<void> {
  void p;
  const present = SKILL_HOSTS.filter((h) => Bun.which(h.cmd));
  if (present.length === 0) {
    log.skip("red-skills: no coding agent installed to configure");
    return;
  }

  // Before asking whether it is wired: a marketplace registered against
  // a local directory is wired and permanently stale, which no amount
  // of reinstalling the same installer will fix.
  if (Bun.which("claude") && (await claudeMarketplaceIsGithub()) === false) {
    await repointClaudeMarketplace();
  }
  if (Bun.which("codex") && (await codexMarketplaceIsGithub()) === false) {
    await repointCodexMarketplace();
  }

  const missing = await unwiredSkillHosts();
  if (missing.length === 0) {
    log.skip(`red-skills already wired into ${present.map((h) => h.cmd).join(", ")}`);
    return;
  }

  log.step(`red-skills: not wired into ${missing.map((h) => h.cmd).join(", ")}`);
  await installRedSkills();
}
