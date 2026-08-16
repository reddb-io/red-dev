/**
 * Updating the agent hosts — each one by its own publisher's mechanism.
 *
 * There is no uniform update path here, and that is the decision rather
 * than an omission. A host installed from npm is refreshed by npm; one
 * that came from a GitHub release is re-resolved against that release
 * and verified against the checksum published beside it; a winget
 * package is upgraded by winget; and a host whose publisher ships a
 * self-update is asked to update itself. Routing all four through the
 * runtime manager's package backend would put red-dev between a vendor
 * and its own binary, deciding on their behalf what "current" means —
 * which is how a machine ends up holding a version nobody upstream
 * recognises.
 *
 * Two rules hold across every mechanism:
 *
 *   A host that is already current is a skip carrying a reason, in the
 *   publisher's own words where it gave one. Not a reinstall — 33 MB
 *   re-downloaded to arrive where we started — and not a failure, since
 *   winget reports exactly that state with a non-zero exit code.
 *
 *   A host that fails is named, and the rest still run. An update that
 *   abandons four hosts because the first vendor script was briefly
 *   unreachable is worse than no update at all: it is an update that
 *   reports itself as having happened.
 */

import {
  agentInstallMethod,
  agentRuntimeEnvironment,
  commandPath,
  npmArgv,
  resolveNpm,
  type AgentSpec,
} from "./agents.ts";
import { runBounded } from "./bounded-command.ts";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import {
  exactGhReleaseUrl,
  ghInstallExactArchive,
  installerInstall,
  spawnLoggedCapture,
  wingetArgv,
} from "./providers.ts";

/**
 * How a host is refreshed, which is how it was installed — plus the one
 * case where the publisher owns the update and not the install.
 */
export type AgentUpdateMechanism =
  | "self-update"
  | "npm"
  | "winget"
  | "msstore"
  | "github-release"
  | "installer";

/**
 * What a mechanism does, in the shape the runner needs to do it.
 *
 * Three kinds rather than one argv, because two of these are not
 * commands: a release is a download whose checksum is verified in this
 * process, and a vendor script is fetched, hashed and interpreted by
 * providers.ts. Flattening them into a command line would mean inventing
 * one, and an invented argv is exactly what a test cannot pin.
 */
export type AgentUpdateStep =
  | { kind: "command"; argv: string[]; env: Record<string, string> }
  | { kind: "release"; repo: string; asset: string; bin: string }
  | { kind: "script"; url: string };

export type AgentUpdatePlan =
  | {
    state: "ready";
    key: string;
    label: string;
    mechanism: AgentUpdateMechanism;
    /** Where the host was found on PATH, when it has a command at all. */
    executable: string | null;
    step: AgentUpdateStep;
  }
  /** Nothing to do, and why. Never a failure. */
  | { state: "skip"; key: string; label: string; reason: string }
  /** Something to do that this machine cannot do yet, and the fix. */
  | { state: "blocked"; key: string; label: string; reason: string; fix: string };

/** PATH and npm, both injected: neither is answerable in a test. */
export interface UpdateResolution {
  locate: (command: string) => string | null;
  npm: string | null;
  /** process.platform, for the one argv that is rewritten on Windows. */
  platform?: string;
}

/**
 * The mechanism for this host on this machine.
 *
 * Read off the install method, because the publisher that installed a
 * host is the publisher that updates it: a Codex installed from npm on
 * WSL is not upgraded by winget just because a winget id exists in the
 * same catalog entry. The single divergence is a vendor self-update,
 * which replaces re-running the vendor's install script — the same
 * publisher, through the door they built for exactly this.
 */
export function agentUpdateMechanism(a: AgentSpec, p: Platform): AgentUpdateMechanism | null {
  const method = agentInstallMethod(a, p);
  if (method === null) return null;
  if (method === "installer" && a.selfUpdate) return "self-update";
  return method;
}

/** What updating one host would run, decided without running anything. PURE. */
export function planAgentUpdate(
  a: AgentSpec,
  p: Platform,
  res: UpdateResolution,
): AgentUpdatePlan {
  const { key, label } = a;
  const mechanism = agentUpdateMechanism(a, p);
  if (!mechanism) return { state: "skip", key, label, reason: "no update mechanism here" };

  // A host with a command that is not on PATH is not installed, and
  // update does not install: `red-dev agents <key>` is that command, and
  // silently widening this one into it would turn an update of four
  // hosts into an install of eleven.
  const executable = a.cmd.length > 0 ? res.locate(a.cmd) : null;
  if (a.cmd.length > 0 && !executable) {
    return { state: "skip", key, label, reason: "not installed" };
  }

  const ready = (step: AgentUpdateStep): AgentUpdatePlan => ({
    state: "ready",
    key,
    label,
    mechanism,
    executable,
    step,
  });

  switch (mechanism) {
    case "self-update":
      return ready({
        kind: "command",
        argv: npmArgv(executable as string, a.selfUpdate as string[]),
        env: {},
      });

    case "npm": {
      if (!res.npm) {
        return {
          state: "blocked",
          key,
          label,
          reason: "no npm anywhere — not on PATH, and mise has no node",
          fix: "red-dev install core",
        };
      }
      return ready({
        kind: "command",
        // Pinned to @latest rather than left bare: npm treats an
        // already-installed global as satisfied under some resolutions,
        // and an update that can decide it has nothing to fetch is not
        // an update.
        argv: npmArgv(res.npm, ["install", "-g", `${a.npm}@latest`]),
        // The same suppression the install path carries. Mise wraps a
        // global npm install with an implicit reshim that has no
        // deadline, and a WSL update stranded at "Reshimming mise 24..."
        // is indistinguishable from one that hung.
        env: { MISE_SKIP_RESHIM: "1" },
      });
    }

    case "winget":
      return ready({
        kind: "command",
        argv: wingetArgv(
          [
            "upgrade",
            "--id",
            a.winget as string,
            "--exact",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
            // See wingetInstall: winget's progress UI is drawn against
            // CONOUT$ and ignores a redirected stdout, so without this it
            // paints over whatever frame is on the screen.
            "--disable-interactivity",
          ],
          res.platform,
        ),
        env: {},
      });

    case "msstore":
      return ready({
        kind: "command",
        argv: wingetArgv(
          [
            "upgrade",
            "--id",
            a.msstore as string,
            // As on the install path: without an explicit source the id
            // resolves against the community repository, where the
            // ChatGPT entries belong to third parties rather than OpenAI.
            "--source",
            "msstore",
            "--exact",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--disable-interactivity",
          ],
          res.platform,
        ),
        env: {},
      });

    case "github-release": {
      const asset = p.os === "windows" ? a.release?.windows[p.arch] : a.release?.linux[p.arch];
      if (!asset) {
        return { state: "skip", key, label, reason: `no ${p.os}/${p.arch} release asset` };
      }
      return ready({ kind: "release", repo: a.release?.repo as string, asset, bin: a.cmd });
    }

    case "installer":
      return ready({ kind: "script", url: a.installer as string });
  }
}

/**
 * The states a publisher's answer reduces to.
 *
 * "skipped" is not a weaker "updated": it is the machine already being
 * where the update was trying to take it, which is the ordinary outcome
 * of running this twice.
 */
export interface AgentUpdateOutcome {
  key: string;
  label: string;
  mechanism: AgentUpdateMechanism | null;
  state: "updated" | "skipped" | "failed";
  /** Why nothing happened. Always present when nothing did. */
  reason?: string;
  /** The publisher's own words, kept for the log. */
  detail?: string;
  /** What the operator can type to unblock this host. */
  fix?: string;
}

/**
 * The ways a publisher says "you already have this".
 *
 * Read before the exit code, not after it, because winget answers this
 * question with a non-zero exit — the steady state of an idempotent
 * machine, reported as an error by every caller that checks the code
 * first.
 */
const ALREADY_CURRENT: readonly RegExp[] = [
  /No available upgrade found/i,
  /No newer package versions?/i,
  /already installed/i,
  /already current/i,
  /already up[ -]to[ -]date/i,
  /\bup[ -]to[ -]date\b/i,
  /already (?:at|on) (?:the )?latest/i,
  /is the latest version/i,
  /changed 0 packages/i,
  /nothing to update/i,
];

/** winget's way of saying the package this id names is not on the machine. */
const NOT_INSTALLED = /No installed package(?:s)? found/i;

/** The last thing the child said that was not a progress spinner. */
function lastWords(output: string): string {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[-\\|/]+$/.test(line))
    .slice(-2)
    .join(" ");
}

/** What a mechanism's exit code and output mean. PURE. */
export function readUpdateOutcome(result: { code: number; output: string }): {
  state: "updated" | "skipped" | "failed";
  reason?: string;
  detail?: string;
} {
  const { code, output } = result;
  if (NOT_INSTALLED.test(output)) {
    return { state: "skipped", reason: "not installed", detail: lastWords(output) };
  }
  if (ALREADY_CURRENT.some((marker) => marker.test(output))) {
    return { state: "skipped", reason: "already current", detail: lastWords(output) };
  }
  if (code === 0) return { state: "updated", detail: lastWords(output) };
  const detail = lastWords(output);
  return { state: "failed", detail: detail || `exited ${code}` };
}

/** The version inside whatever a host prints when asked. PURE. */
export function versionIn(text: string): string | null {
  return text.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? null;
}

/** Whether an installed host is already the release this tag names. PURE. */
export function sameRelease(versionOutput: string, tag: string): boolean {
  const installed = versionIn(versionOutput);
  const published = versionIn(tag);
  return installed !== null && published !== null && installed === published;
}

/**
 * The tag a release redirect currently points at. PURE.
 *
 * `/releases/latest/download/<asset>` answers with a Location naming the
 * tag it resolved to, which is the whole of the re-resolution this needs
 * — and it costs no GitHub API quota, the same reason the install path
 * downloads through that redirect rather than through the API.
 */
export function releaseTagFromLocation(location: string): string | null {
  const match = location.match(/\/releases\/download\/([^/]+)\//);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

async function resolveReleaseTag(repo: string, asset: string): Promise<string | null> {
  try {
    const res = await fetch(exactGhReleaseUrl(repo, asset), {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const location = res.headers.get("location");
    return location ? releaseTagFromLocation(location) : null;
  } catch {
    // No answer is not "already current". Returning null makes the
    // caller update rather than assume, which is the safe direction:
    // the worst case is a download the machine did not strictly need.
    return null;
  }
}

async function probeVersion(executable: string): Promise<string | null> {
  try {
    const result = await runBounded([executable, "--version"], { timeoutMs: 5_000 });
    if (result.timedOut || result.exitCode !== 0) return null;
    return versionIn(result.stdout + result.stderr);
  } catch {
    return null;
  }
}

/** Every side of the machine this touches, so a test can hold all of them. */
export interface AgentUpdateDeps {
  locate?: (command: string) => string | null;
  npm?: () => Promise<string | null>;
  command?: (
    argv: string[],
    env: Record<string, string | undefined>,
  ) => Promise<{ code: number; output: string }>;
  release?: (step: { repo: string; asset: string; bin: string }, p: Platform) => Promise<void>;
  script?: (url: string, note: string) => Promise<void>;
  /** The tag the publisher's stable redirect resolves to right now. */
  releaseTag?: (repo: string, asset: string) => Promise<string | null>;
  /** What the installed host answers when asked for its version. */
  version?: (executable: string) => Promise<string | null>;
  /** Called as each host settles, so a caller can report while it runs. */
  report?: (outcome: AgentUpdateOutcome) => void;
}

async function defaultCommand(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number; output: string }> {
  const result = await spawnLoggedCapture(argv, { env });
  return { code: result.code, output: result.out + result.err };
}

/**
 * Run one host's plan, in the mechanism's own currency.
 *
 * A release and a vendor script throw on failure and answer nothing on
 * success, so they report `updated` by having returned. A command is
 * read: its exit code and its output are what says whether anything
 * moved.
 */
async function performUpdate(
  plan: Extract<AgentUpdatePlan, { state: "ready" }>,
  host: AgentSpec,
  p: Platform,
  npm: string | null,
  deps: AgentUpdateDeps,
): Promise<AgentUpdateOutcome> {
  const base = { key: plan.key, label: plan.label, mechanism: plan.mechanism };

  if (plan.step.kind === "release") {
    const { repo, asset, bin } = plan.step;
    const tag = await (deps.releaseTag ?? resolveReleaseTag)(repo, asset);
    if (tag && plan.executable) {
      const installed = await (deps.version ?? probeVersion)(plan.executable);
      if (installed && sameRelease(installed, tag)) {
        return { ...base, state: "skipped", reason: `already at ${tag}` };
      }
    }
    await (deps.release ?? ((step, platform) =>
      ghInstallExactArchive(step.repo, step.asset, step.bin, platform)))(
        { repo, asset, bin },
        p,
      );
    return { ...base, state: "updated", detail: tag ?? undefined };
  }

  if (plan.step.kind === "script") {
    const { url } = plan.step;
    await (deps.script ?? installerInstall)(url, `${plan.label} official installer`);
    return { ...base, state: "updated" };
  }

  // npm's child needs the directory npm itself lives in, or the
  // lifecycle scripts it spawns look `node` up on a PATH this process
  // was born without. Built from the resolved npm rather than from
  // argv[0], which on Windows is cmd.exe. Same environment the install
  // path builds, with the step's own variables on top of it.
  const env: Record<string, string | undefined> = plan.mechanism === "npm" && npm
    ? { ...(await agentRuntimeEnvironment(npm, host)), ...plan.step.env }
    : plan.step.env;
  const result = await (deps.command ?? defaultCommand)(plan.step.argv, env);
  return { ...base, ...readUpdateOutcome(result) };
}

/**
 * Update every host given, and let none of them stop the others.
 *
 * The try/catch is the whole point of the loop being here rather than at
 * a call site: `ghInstallExactArchive` throws on a 404, `installerInstall`
 * throws on a TLS failure, and either would otherwise end an update that
 * still had four working hosts in front of it.
 */
export async function updateAgents(
  hosts: readonly AgentSpec[],
  p: Platform,
  deps: AgentUpdateDeps = {},
): Promise<AgentUpdateOutcome[]> {
  const locate = deps.locate ?? commandPath;
  // Resolved once, and only when something on this machine needs it.
  const wantsNpm = hosts.some((host) => agentUpdateMechanism(host, p) === "npm");
  const npm = wantsNpm ? await (deps.npm ?? resolveNpm)() : null;

  const outcomes: AgentUpdateOutcome[] = [];
  for (const host of hosts) {
    const plan = planAgentUpdate(host, p, { locate, npm });
    let outcome: AgentUpdateOutcome;
    if (plan.state === "skip") {
      outcome = { key: plan.key, label: plan.label, mechanism: null, state: "skipped", reason: plan.reason };
    } else if (plan.state === "blocked") {
      outcome = {
        key: plan.key,
        label: plan.label,
        mechanism: agentUpdateMechanism(host, p),
        state: "failed",
        reason: plan.reason,
        fix: plan.fix,
      };
    } else {
      try {
        outcome = await performUpdate(plan, host, p, npm, deps);
      } catch (err) {
        outcome = {
          key: plan.key,
          label: plan.label,
          mechanism: plan.mechanism,
          state: "failed",
          detail: (err as Error).message,
        };
      }
    }
    outcomes.push(outcome);
    deps.report?.(outcome);
  }
  return outcomes;
}

/** One host's outcome, in the log's own three columns. */
export function reportAgentUpdate(outcome: AgentUpdateOutcome): void {
  const where = outcome.mechanism ? ` (${outcome.mechanism})` : "";
  if (outcome.state === "updated") {
    log.ok(`${outcome.label}${where}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
    return;
  }
  if (outcome.state === "skipped") {
    log.skip(`${outcome.label}: ${outcome.reason ?? "nothing to do"}`);
    return;
  }
  log.err(`${outcome.label}${where}: ${outcome.reason ?? outcome.detail ?? "update failed"}`);
  if (outcome.fix) log.plain(`       fix: ${outcome.fix}`);
}
