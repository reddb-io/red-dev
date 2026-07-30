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
