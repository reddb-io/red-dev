/**
 * The Product skill: what an agent needs to know about a machine red-dev
 * provisioned, put where every installed agent host can read it.
 *
 * RedSkills already teaches agents *how to work* — process, review,
 * handoff. None of it says where this machine keeps its managed
 * configuration, which command answers "what is wrong here", what the
 * rows in a transcript mean, or which acts stop and ask for
 * administrator. An agent handed a red-dev crash today has to rediscover
 * all four from the source, on a machine where the source may not even
 * be checked out. So: RedSkills carries process guidance, this carries
 * product knowledge, and the two do not overlap by design.
 *
 * ## Written, not symlinked
 *
 * Omarchy symlinks its skills directory into each host. That does not
 * survive this product's targets: Git Bash on Windows emulates symlinks
 * by copying — the failure `repairCopiedRedSkillsCurrent` exists to
 * repair — and a copy is exactly the freeze this is supposed to avoid.
 * A written file is the same on every target, and the refresh below is
 * what keeps it current instead of the link.
 *
 * ## Owned, and only what is owned
 *
 * A rewrite that overwrote whatever it found would be a tool deleting a
 * person's work. Every file this writes carries a managed marker, and a
 * file without one is left alone with a reason — the same rule
 * `repairCopiedRedSkillsCurrent` follows for the snapshot directory.
 *
 * See .red/contexts/agents/CONTEXT.md.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { commandPath } from "./agents.ts";
import { VERSION } from "./cli.ts";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";

/**
 * The skill's directory and frontmatter name.
 *
 * Not `red-dev`: RedSkills ships `doctor`, `diagnose` and `health` into
 * the same directories, and a bare product name there reads as "the
 * red-dev skill" — the ambiguity the context map tells us to avoid. This
 * names what it describes, which is the machine.
 */
export const PRODUCT_SKILL_NAME = "red-dev-machine";

/** What says red-dev wrote a file and may rewrite it. */
export const MANAGED_MARKER = "managed by red-dev";

/**
 * Where each host reads user-level skills from.
 *
 * A table for the same reason SKILL_HOSTS is one: the hosts do not agree,
 * and the only way to be wrong quietly is to assume they do. Each of
 * these was read off a provisioned machine rather than inferred —
 * ~/.codex/skills and ~/.config/redcode/skills both already held the
 * skills RedSkills generates, and ~/.claude/skills is Claude Code's
 * documented personal skills directory whether or not it exists yet.
 *
 * HOME-relative rather than through shared-root's configHome, which is
 * deliberate: a skills home belongs to the host, not to red-dev, and
 * pointing RedCode's at a Windows share would put the file somewhere
 * RedCode does not look. It is the same directory `unwiredSkillHosts`
 * reads RedCode's install manifest from.
 */
export interface SkillHome {
  /** Key in AGENTS, so this list cannot drift from that one. */
  agent: string;
  /** Command that proves the host is installed at all. */
  cmd: string;
  /** The host's user-level skills home, given a home directory. */
  dir: (home: string) => string;
}

export const SKILL_HOMES: SkillHome[] = [
  { agent: "claude-code", cmd: "claude", dir: (home) => `${home}/.claude/skills` },
  { agent: "codex", cmd: "codex", dir: (home) => `${home}/.codex/skills` },
  { agent: "redcode", cmd: "redcode", dir: (home) => `${home}/.config/redcode/skills` },
];

/**
 * What is to be done for one host.
 *
 * A skip always carries a reason. "Nothing happened" with no explanation
 * is how a host that has been silently missing for a month gets found by
 * accident rather than by reading the log.
 */
export type ProductSkillPlan =
  | { state: "write"; agent: string; cmd: string; path: string }
  | { state: "skip"; agent: string; cmd: string; reason: string };

/** Where the skill goes for every host, and why it does not. PURE. */
export function planProductSkill(
  homes: readonly SkillHome[],
  deps: { home: string | null; installed: (cmd: string) => boolean },
): ProductSkillPlan[] {
  return homes.map((h) => {
    if (!deps.installed(h.cmd)) {
      // Not "install it": this puts a document where an agent host can
      // read it, and it has no opinion about which hosts should exist.
      return { state: "skip" as const, agent: h.agent, cmd: h.cmd, reason: "no agent installed" };
    }
    if (!deps.home) {
      return {
        state: "skip" as const,
        agent: h.agent,
        cmd: h.cmd,
        reason: "no home directory to write into",
      };
    }
    const dir = h.dir(deps.home.replace(/\\/g, "/"));
    return {
      state: "write" as const,
      agent: h.agent,
      cmd: h.cmd,
      path: `${dir}/${PRODUCT_SKILL_NAME}/SKILL.md`,
    };
  });
}

/**
 * The facts about this machine the document is written from.
 *
 * Passed in rather than read inside the template, so the same call that
 * produces the file for this machine can produce one for a test — and so
 * that the paths in the skill are this machine's paths rather than the
 * ones a Linux developer's documentation happened to name.
 */
export interface MachineFacts {
  /** The red-dev that wrote it, so a stale copy identifies itself. */
  version: string;
  /** Transcripts, crash logs and cached observations. */
  state: string;
  /** Where managed configuration is written. */
  config: string;
}

/**
 * The skill, as the file a host will read.
 *
 * Generated rather than shipped as a static asset, because two of the
 * three things an agent needs here — the state directory and the
 * configuration root — are answers this machine gives and not constants:
 * they move with XDG variables, with Windows, and with a shared root.
 * A static document would be right on the machine it was written on.
 */
export function productSkillDocument(facts: MachineFacts): string {
  return `---
name: ${PRODUCT_SKILL_NAME}
description: What this machine's red-dev provisioning looks like — where managed configuration and state live, which commands report it, what the run transcripts and crash log contain, and which acts need administrator. Use when diagnosing a red-dev run, reading a transcript, or changing anything red-dev manages.
---

<!-- ${MANAGED_MARKER} ${facts.version} — rewritten by \`red-dev update\`; edits here are lost -->

# The machine red-dev provisioned

red-dev converges this machine toward a manifest: every tool it manages
has a provider chosen per platform, and running it again is meant to be
uneventful. Read the machine before changing it — most of what looks like
a broken tool is drift red-dev can already name.

This is product knowledge. RedSkills carries the process guidance; the
two do not repeat each other.

## Where things are

| What | Where |
| --- | --- |
| Managed configuration | \`${facts.config}\` |
| State: transcripts, crash logs, cached observations | \`${facts.state}\` |
| RedSkills source snapshot | \`~/.red/skills/current\` (a symlink into a versioned copy) |

Configuration under the managed root is rewritten by the next converge.
Change it through the command that owns it — \`red-dev theme\`,
\`red-dev shell\`, \`red-dev agents\` — rather than by editing the file,
or the edit disappears without anything reporting that it did.

## Commands that report state

Read-only, safe to run at any time, and the right first move:

- \`red-dev platform\` — what red-dev thinks this machine is.
- \`red-dev plan [scope]\` — what a converge would change, changing nothing.
- \`red-dev doctor\` — drift against the manifest, host process health,
  artifact usage, and the recorded Default agent. Lines that name a fix
  print it on the following line.
- \`red-dev logs\` — the last run's transcript. \`red-dev logs list\` for
  every kept run, \`red-dev logs 2\` for the run before last.
- \`red-dev reclaim\` — what derived artifacts are using, and what a prune
  would remove. It changes nothing without \`--apply\`.
- \`red-dev rescue\` — process groups proven to be orphaned. Also inert
  without \`--apply\`.

## Transcripts

Every mutating run is written to \`${facts.state}\` as
\`<timestamp>-<command>.log\`; the twenty newest are kept. A transcript
opens with a header naming the version, the time and the platform, and
closes with \`# exit <code>\`.

Converge steps are fixed-width rows:

    [ 7/36] zellij                 apt                          ok        412ms

so \`grep failed\` over a transcript is the whole technique for finding
what went wrong. Child process output is in there whenever something was
capturing it — the fullscreen converge — and deliberately not on a plain
terminal run, where apt keeps its progress bar and sudo can still ask for
a password.

## The crash log

An uncaught failure appends to \`${facts.state}/crash.log\` before the
process dies, with the previous file kept as \`crash.previous.log\`. Each
entry is a stack under a header naming the kind, the time, the version
and the platform. On Windows this is the only copy that survives a
fullscreen window closing, so it is the first file to read for "it
crashed and I saw nothing".

Machine-readable observations live beside it as JSON — agent usage per
provider, the GitHub rate-limit reading. They are caches red-dev writes
and reads back; read them, and let red-dev be the one to write them.

## What needs privilege

Some manifest items need administrator. A converge does not silently
escalate: it does what it can unprivileged, then names the rest and
points at \`red-dev privileged\`, which finishes only that work. Run that
command as the person, in a session that can prompt.

Do not re-run a whole converge under \`sudo\`. It writes into a home
directory, and a converge run as root leaves files the user can no longer
change — a slower failure than the one it was working around.
`;
}

/** What became of one host. */
export interface ProductSkillOutcome {
  agent: string;
  cmd: string;
  state: "written" | "unchanged" | "skipped" | "failed";
  path?: string;
  /** Why nothing happened. Always present when nothing did. */
  reason?: string;
}

/** Every side of the machine this touches, so a test can hold all of them. */
export interface ProductSkillDeps {
  /** The home directory to resolve skills homes against. */
  home?: string | null;
  installed?: (cmd: string) => boolean;
  facts?: MachineFacts;
  /** Existing content at a path, or null when there is nothing there. */
  read?: (path: string) => string | null;
  write?: (path: string, body: string) => void;
  /** Called as each host settles, so a caller can report while it runs. */
  report?: (outcome: ProductSkillOutcome) => void;
}

function defaultRead(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    // Unreadable is not "absent". Rewriting on a read error would
    // overwrite a file whose ownership we could not establish.
    throw new Error(`could not read ${path}`);
  }
}

function defaultWrite(path: string, body: string): void {
  mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(path, body);
}

/**
 * Where this machine keeps the things the skill names.
 *
 * Imported lazily for the same reason the command bodies do it: this is
 * reached on a converge, and neither module should be loaded by a
 * `red-dev platform`.
 */
async function machineFacts(p: Platform): Promise<MachineFacts> {
  const [{ transcriptDir }, { configHome }] = await Promise.all([
    import("./transcript.ts"),
    import("./shared-root.ts"),
  ]);
  return { version: VERSION, state: transcriptDir(), config: configHome(p) };
}

/**
 * Put the current Product skill into every installed host.
 *
 * Idempotent by content rather than by existence: a file identical to
 * what would be written is `unchanged`, so running this on every converge
 * is quiet, and a file that has fallen behind is rewritten without anyone
 * having to decide it is stale. That is the whole answer to the freeze —
 * there is no install-day copy, only the copy the last run wrote.
 *
 * One host's failure never stops the others. A read-only skills home is a
 * reason to report that host and move on, not to end a converge.
 */
export async function installProductSkill(
  p: Platform,
  deps: ProductSkillDeps = {},
): Promise<ProductSkillOutcome[]> {
  const home = deps.home !== undefined
    ? deps.home
    : (process.env["HOME"] ?? process.env["USERPROFILE"] ?? null);
  const installed = deps.installed ?? ((cmd: string) => commandPath(cmd) !== null);
  const plans = planProductSkill(SKILL_HOMES, { home, installed });

  // Only when something is going to be written. Resolving the machine's
  // paths on a host with no agent installed is work for a document
  // nobody will read.
  const writes = plans.filter((plan) => plan.state === "write");
  const body = writes.length > 0
    ? productSkillDocument(deps.facts ?? (await machineFacts(p)))
    : "";

  const read = deps.read ?? defaultRead;
  const write = deps.write ?? defaultWrite;
  const outcomes: ProductSkillOutcome[] = [];

  for (const plan of plans) {
    let outcome: ProductSkillOutcome;
    if (plan.state === "skip") {
      outcome = { agent: plan.agent, cmd: plan.cmd, state: "skipped", reason: plan.reason };
    } else {
      try {
        const existing = read(plan.path);
        if (existing !== null && !existing.includes(MANAGED_MARKER)) {
          outcome = {
            agent: plan.agent,
            cmd: plan.cmd,
            state: "skipped",
            path: plan.path,
            reason: "a skill of this name is already there and is not red-dev's",
          };
        } else if (existing === body) {
          outcome = { agent: plan.agent, cmd: plan.cmd, state: "unchanged", path: plan.path };
        } else {
          write(plan.path, body);
          outcome = { agent: plan.agent, cmd: plan.cmd, state: "written", path: plan.path };
        }
      } catch (err) {
        outcome = {
          agent: plan.agent,
          cmd: plan.cmd,
          state: "failed",
          path: plan.path,
          reason: (err as Error).message,
        };
      }
    }
    outcomes.push(outcome);
    deps.report?.(outcome);
  }
  return outcomes;
}

/**
 * The set of outcomes as the log's own lines.
 *
 * One line for the hosts that got it, because three "wrote the Product
 * skill" rows in a converge is noise for a step nobody asked for. A
 * failure gets its own line: that one is worth interrupting for.
 */
export function reportProductSkill(outcomes: readonly ProductSkillOutcome[]): void {
  const wrote = outcomes.filter((o) => o.state === "written");
  if (wrote.length > 0) log.ok(`Product skill refreshed for ${wrote.map((o) => o.cmd).join(", ")}`);

  for (const outcome of outcomes.filter((o) => o.state === "skipped" && o.path)) {
    log.skip(`Product skill for ${outcome.cmd}: ${outcome.reason}`);
  }
  for (const outcome of outcomes.filter((o) => o.state === "failed")) {
    log.err(`Product skill for ${outcome.cmd}: ${outcome.reason ?? "could not be written"}`);
  }
}

/**
 * Refresh the Product skill, and say what happened.
 *
 * The pairing every caller wants, so that neither the converge nor the
 * update path has to know which outcomes are worth a line.
 */
export async function refreshProductSkill(p: Platform): Promise<ProductSkillOutcome[]> {
  const outcomes = await installProductSkill(p);
  reportProductSkill(outcomes);
  return outcomes;
}
