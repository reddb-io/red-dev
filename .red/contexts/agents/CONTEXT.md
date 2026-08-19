# Context: agents

Agent hosts, RedSkills, MCPs, and RedDB products' accessibility to agents.

## Agent host

An agent client program that consumes RedSkills on a provisioned machine. Decided supported set: Claude Code, Codex, OpenCode, RedCode, Gemini, Pi, and Hermes — all seven with shared skills and doctor verification. OpenCode and RedCode are both managed OpenCode-compatible hosts. Hermes depends on official upstream RedSkills support.

## RedSkills package set

A coherent, versioned unit of the RedSkills workstation distribution: core, all plugin payloads, host manifests and generators, shared runtimes, daemon, companion integrations, and their required artifacts. Releases are the reproducible default; a local source checkout may stand in for the package set during development without becoming a second installation model. AI coder activation is deliberately narrower than its contents: only the `dev` plugin is installed into agent hosts.

On a machine today the set is **composed** by red-dev from mise's installs (core + every declared plugin at the one version present in all of them, copied into a self-contained tree under `~/.red/skills/sets/<version>+<digest12>`, `unsigned`) or **published** (a directory carrying the `red.package-set.v1` manifest, its cosign bundle, artifacts and tree, verified to `trusted`); either way it is the only thing `~/.red/skills/current` may name, and its identity is version + digest + source commit, never a path (ADR 0011).

_Avoid_: RedSkills install (ambiguous between acquisition and host activation), plugin bundle (only one part of the set)

## User-global installation

An agent-host integration available to one operating-system user in every repository and new session. It is not a system-wide installation shared by other users, and it does not imply that an already-running host has reloaded changed plugins.

_Avoid_: global installation (ambiguous between user-global and system-wide)

## Default agent

The one agent host a person has chosen as the target when red-dev hands work to an agent — a crash to diagnose, a launch shortcut, a profile's required host. It is a choice recorded once, not an inference from what happens to be installed, and red-dev never starts it with a permission bypass or auto-approve flag: unattended mode is the person's decision at the moment they type it, never a default red-dev ships (decision of 2026-08-15, contrasting Omarchy's `omarchy-agent`, which launches its default agent in bypass mode).

It is started with `red-dev agents run`, which builds the host's plain invocation — the command line the person would have typed, plus whatever they typed after `--` — and is guarded by an enumeration of every host's launch argv, so the promise above is checked rather than described (decision of 2026-08-15). It is chosen in the interview right after the agent hosts and changed with `red-dev agents default <key>`; when exactly one CLI host is selected it is that one, without a question. Its update path is part of `red-dev update` (system, red-skills, agents, converge) and also stands alone as `red-dev agents update`, each host by its publisher's own mechanism (decision of 2026-08-15).

_Avoid_: primary agent, main agent, "the agent"

## Agent usage

How much of an agent provider's allowance this machine has consumed, per window the provider defines (Claude's five-hour and weekly windows, Codex's rate limits, GitHub's `api`/`gql` budgets). It is an observation red-dev caches and reads back — a surface that shows it never queries a provider live, never launches an agent process to learn it, and prefers a stale reading to no reading. Shown compact on the Redwall and in detail by `doctor` / `red-dev agents status` (decision of 2026-08-15).

_Avoid_: quota, limits panel, budget (reserved for GitHub's rate-limit share)

## Product skill

red-dev's own agent skill — how the product lays out managed paths and state, what `doctor --json`, `red-dev logs` and the transcripts say, when a step needs privilege — installed into each agent host's skills home the way Omarchy symlinks `default/agents/skills`. It is what the **Default agent** receives when asked to diagnose a crash, and it complements RedSkills' process skills rather than duplicating them (decision of 2026-08-15).

_Avoid_: red-dev skill (ambiguous with RedSkills), diagnose skill (one use of it, not the thing)

## MCP posture

CLI-first: every required capability has a stable CLI path; MCP is optional acceleration. An MCP failure never brings down a required item's readiness — the item stays `healthy` with a `degraded(reason, fallback, remediation)` state pointing at the CLI fallback.

## Relationships

- The **Default agent** is exactly one of the installed **Agent hosts**, or unset.
- **Agent usage** is observed per **Agent host** provider; the Redwall reads it, it never produces it. The first collectors cover only what can be read without launching a process (Claude from local credentials over HTTP; Codex once its CLI exposes limits) — never an app-server.
- The **Product skill** is installed for every **Agent host**; the **Default agent** is the one red-dev briefs with it.
