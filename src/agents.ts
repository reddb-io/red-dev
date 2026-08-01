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

import { existsSync } from "node:fs";
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

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, {
    stdout: "inherit",
    stderr: "inherit",
    stdin: process.stdin.isTTY === true ? "inherit" : "ignore",
  });
  if ((await proc.exited) !== 0) throw new RedError(`${cmd[0]} exited non-zero`);
}

export async function installAgent(a: AgentSpec, p: Platform): Promise<void> {
  if (p.os === "windows" && a.msstore) {
    // --source msstore is load-bearing, not a detail: without it winget
    // resolves the id against the community repository, where the
    // ChatGPT entries belong to third parties rather than OpenAI.
    const { wingetArgv } = await import("./providers.ts");
    await run(
      wingetArgv([
        "install",
        "--id",
        a.msstore,
        "--source",
        "msstore",
        "--exact",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ]),
    );
    return;
  }

  if (p.os === "windows" && a.winget) {
    const { wingetArgv } = await import("./providers.ts");
    await run(
      wingetArgv([
        "install",
        "--id",
        a.winget,
        "--exact",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ]),
    );
    return;
  }

  if (a.installer) {
    const { installerInstall } = await import("./providers.ts");
    await installerInstall(a.installer, `${a.label} official installer`);
    return;
  }

  if (a.npm) {
    const npm = Bun.which("npm");
    if (!npm) throw new RedError("npm not on PATH — run `red-dev install core` first");
    await run([npm, "install", "-g", a.npm]);
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
  const url = "https://raw.githubusercontent.com/reddb-io/red-skills/v2/scripts/install.sh";
  const { installerInstall } = await import("./providers.ts");
  log.step("red-skills");
  log.plain("     Registers the RedSkills marketplace in Claude Code and Codex,");
  log.plain("     and generates plugin modules for OpenCode. User-level, global.");
  await installerInstall(url, "reddb-io/red-skills");
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

  const missing = await unwiredSkillHosts();
  if (missing.length === 0) {
    log.skip(`red-skills already wired into ${present.map((h) => h.cmd).join(", ")}`);
    return;
  }

  log.step(`red-skills: not wired into ${missing.map((h) => h.cmd).join(", ")}`);
  await installRedSkills();
}
