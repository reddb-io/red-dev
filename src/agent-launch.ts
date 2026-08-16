/**
 * Starting the Default agent — and the one thing red-dev promises not
 * to put on its command line.
 *
 * `red-dev agents run` exists so that "the host red-dev hands work to"
 * is something a person can actually be handed to: a launch shortcut, a
 * crash to diagnose, a profile's required host. What it builds is the
 * plain invocation — the executable and whatever the person typed after
 * `--`, in that order, with nothing of red-dev's in between.
 *
 * That emptiness is the feature. Omarchy launches its default agent in
 * bypass/auto-approve mode, and ADR 0001's amendment of 2026-08-15 puts
 * that on the do-not-copy list: unattended is a decision someone makes
 * at the moment they type it, never one shipped as a default. A promise
 * of that shape decays quietly — it is one convenience flag away from
 * being false, and nothing about the flag looks wrong at the moment it
 * is added. So the promise is checked here rather than described: every
 * argument red-dev contributes is read before the process starts, and a
 * bypass among them stops the launch instead of performing it.
 *
 * What it does not do is police the person. A flag they typed
 * themselves is carried through untouched — that is them making the
 * decision, which is exactly what the ADR reserves for them.
 *
 * See .red/contexts/agents/CONTEXT.md and src/default-agent.ts.
 */

import { AGENTS, npmArgv, type AgentSpec } from "./agents.ts";
import { isDefaultAgentCandidate, readDefaultAgent, reportDefaultAgent } from "./default-agent.ts";
import { RedError } from "./log.ts";

/**
 * What a permission bypass looks like across the hosts red-dev
 * installs, reduced to the part that survives every spelling.
 *
 * Matched as substrings of a folded token rather than as whole flags,
 * because the same decision arrives under too many names to enumerate:
 * `--dangerously-skip-permissions` (Claude Code),
 * `--dangerously-bypass-approvals-and-sandbox` and `--full-auto`
 * (Codex), `--yolo` (Gemini), `--permission-mode bypassPermissions`,
 * `--approval-mode auto_edit`, `--sandbox danger-full-access`. A list
 * of exact flags would pass the day a host renames one, which is the
 * day this most needs to fail.
 */
const BYPASS_MARKERS: readonly string[] = [
  "danger",
  "bypass",
  "yolo",
  "fullauto",
  "autoapprove",
  "autoaccept",
  "autoedit",
  "acceptedits",
  "skippermission",
  "nopermission",
  "noconfirm",
  "noprompt",
  "nosandbox",
  "trustall",
  "unattended",
];

/** Short forms that carry no word to match on. */
const BYPASS_TOKENS: readonly string[] = ["-y", "--yes"];

/**
 * Reduce a token to its letters and digits, so `--auto_edit`,
 * `--auto-edit` and `autoEdit` are one thing rather than three.
 */
function fold(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Which of these tokens hand a host's permission prompts away. PURE.
 *
 * Every token is read whole, flag and value alike: the answer to
 * `--permission-mode` lives one token to the right, and a scan of flag
 * names alone would walk straight past `bypassPermissions`.
 */
export function permissionBypassFlags(tokens: readonly string[]): string[] {
  return tokens.filter((token) => {
    if (BYPASS_TOKENS.includes(token.toLowerCase())) return true;
    const folded = fold(token);
    return BYPASS_MARKERS.some((marker) => folded.includes(marker));
  });
}

/** The arguments red-dev adds when it starts a host. Empty, and checked. */
export function hostLaunchArgs(host: AgentSpec): string[] {
  return [...(host.launchArgs ?? [])];
}

/**
 * The whole command line for a host, executable included. PURE.
 *
 * npmArgv is the one rewrite: a host installed from npm on Windows
 * lands as a `.cmd` shim, and CreateProcess cannot exec a batch file —
 * cmd.exe has to interpret it. It adds a prefix, never an argument.
 */
export function hostLaunchArgv(
  host: AgentSpec,
  executable: string,
  passthrough: readonly string[] = [],
): string[] {
  return npmArgv(executable, [...hostLaunchArgs(host), ...passthrough]);
}

export interface LaunchTarget {
  key: string;
  label: string;
  /** The executable as it was found on PATH, exactly as it will be run. */
  executable: string;
  /** What red-dev contributes to the command line. The guard reads this. */
  added: string[];
  /** What the person typed after `--`, carried through as they typed it. */
  passthrough: string[];
  argv: string[];
}

export type LaunchDecision =
  | { ok: true; target: LaunchTarget }
  | { ok: false; detail: string; fix?: string };

/**
 * Build the command line for a host, refusing to build one that starts
 * it unattended.
 *
 * The enumeration in agent-launch.test.ts catches a catalog entry that
 * carries such a flag before it ships. This catches it on the machine
 * of whoever ships it anyway — the difference between a test and a
 * guard, and the reason the ADR's amendment is executable rather than
 * aspirational.
 */
export function launchTarget(
  host: AgentSpec,
  executable: string,
  passthrough: readonly string[] = [],
): LaunchTarget {
  const added = hostLaunchArgs(host);
  const offending = permissionBypassFlags(added);
  if (offending.length > 0) {
    throw new RedError(
      `red-dev does not start ${host.label} with ${offending.join(" ")} — ` +
        "unattended is the person's decision at the moment they type it (ADR 0001)",
    );
  }
  return {
    key: host.key,
    label: host.label,
    executable,
    added,
    passthrough: [...passthrough],
    argv: hostLaunchArgv(host, executable, passthrough),
  };
}

/**
 * What to start, read from the recorded choice rather than from the
 * machine.
 *
 * The whole point of resolving here is that no caller gets to name a
 * host. A surface that reached for `claude` because it is usually there
 * would be right on most machines and wrong on exactly the machines
 * where someone bothered to choose — and it would be wrong silently.
 *
 * `locate` is injected for the same reason readDefaultAgent takes its
 * installed test: it is PATH, and PATH is not answerable in a test.
 */
export function resolveLaunch(
  prefs: { defaultAgent?: string | undefined; agents?: string[] | undefined },
  locate: (command: string) => string | null,
  passthrough: readonly string[] = [],
): LaunchDecision {
  const installed = (host: AgentSpec): boolean =>
    host.cmd.length > 0 && locate(host.cmd) !== null;

  const reading = readDefaultAgent(prefs.defaultAgent, installed);
  if (reading.state !== "ready") {
    // The same words doctor prints, so the machine says one thing about
    // the Default agent whichever surface is asked.
    const report = reportDefaultAgent(reading, prefs.agents ?? []);
    return { ok: false, detail: report.detail, ...(report.fix ? { fix: report.fix } : {}) };
  }

  const host = AGENTS.find((a) => a.key === reading.key && isDefaultAgentCandidate(a));
  const executable = host ? locate(host.cmd) : null;
  if (!host || !executable) {
    // Unreachable through readDefaultAgent, which only reports `ready`
    // for a candidate the same lookup just found. Answered rather than
    // asserted because a launch is not the place to discover that.
    return {
      ok: false,
      detail: `${reading.label ?? reading.recorded} is not on PATH`,
      fix: `red-dev agents ${reading.key ?? ""}`.trim(),
    };
  }
  return { ok: true, target: launchTarget(host, executable, passthrough) };
}

/**
 * Hand the terminal over and wait for it back.
 *
 * The three streams are inherited because this *is* the person's
 * session — the host draws a full-screen interface of its own and reads
 * the keyboard, neither of which survives a pipe. It lives here rather
 * than in main.ts so the exception to the console-ownership rule is a
 * file that can never run behind one of red-dev's own frames: nothing
 * reaches this but `red-dev agents run`, typed at a shell.
 *
 * The environment is inherited as it is, not the unattended one:
 * UNATTENDED_ENV exists to tell package managers that nobody is
 * watching, and here somebody is.
 */
export async function runLaunchTarget(target: LaunchTarget): Promise<number> {
  const child = Bun.spawn(target.argv, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}
