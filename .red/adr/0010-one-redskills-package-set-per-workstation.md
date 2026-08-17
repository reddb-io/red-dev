# 0010 — One RedSkills package set per workstation

- Status: accepted
- Date: 2026-08-17
- Contexts: `agents`, `provisioning`, `lifecycle`
- Supersedes: ADR 0008
- Sources: the RedSkills `/start` grilling session of 2026-08-17

## Context

RedSkills reaches each agent host through a different marketplace, generator,
copy, or skills directory. The same revision is consequently cloned and cached
several times, while the four mise/npm entries can advance independently. The
current npm runtime package carries bundles and shims rather than the complete
workstation distribution, and the standalone installer remains a competing
owner of `~/.red-skills/current`.

The required outcome is one user-global local source for every integration, an
online update through mise, and a complete offline bootstrap from a directory.

## Decision

**A RedSkills package set is one mise tool.** It contains the complete
workstation distribution: all four plugin payloads, host manifests and
generators, shared runtimes, `redskilled`, the Herdr plugin, VS Code extension,
Zellij integration, and required RedSkills artifacts. Only the `dev` plugin is
activated in AI coder hosts. Host applications and other third-party tools stay
separate mise tools, but exact compatible revisions are recorded in the same
per-target lock.

**A local mise plugin acquires the package set.** Online channels are `stable`,
`next`, or an exact version/commit. The plugin maintains one local Git mirror,
creates immutable snapshots, overlays release assets from the same commit,
verifies a signed manifest and every SHA-256 digest, and invokes red-dev from a
tool-level postinstall. `mise upgrade red-skills` and `red-dev update` therefore
reach the same idempotent red-dev reconciliation. The package-set identity is
its version plus whole-set digest and source commit, never just its path.

A development checkout is a mise `path:` override and is updated explicitly
through red-dev rather than by `mise upgrade`. It overlays matching release
assets; assets unavailable for that commit are built into digest-keyed staging
without mutating the checkout.

**red-dev remains the sole host-wiring owner.** It installs and verifies
RedSkills for Claude Code, Codex, OpenCode, RedCode, Gemini, Pi, and Hermes,
using each host's supported extension mechanism and falling back to skills-only
where richer hooks, MCP, or agent surfaces do not exist. It installs all seven
hosts on a clean workstation, but activates only `dev`. User configuration is
preserved through dedicated includes or ownership-aware structural merges.
Host-owned caches may exist; obsolete revisions are removed only after the new
source verifies successfully.

**An Offline depot bootstraps a clean workstation without network access.** A
connected machine creates the private depot with `red-dev depot export`; it
contains the mise and red-dev bootstrap, local mise plugin, Git snapshot,
release assets, third-party installers, exact lock, signed manifest, checksums,
and both the selected and previous revisions. It contains no credentials. An
import copies versioned state into machine-owned storage, so removable media is
not a runtime dependency.

The first supported depots are Ubuntu 24.04/26.04 x64 and a combined Windows
x64 plus WSL2/Ubuntu workstation. On the combined target, all seven coder CLIs,
Zellij, Herdr, and the one `redskilled` daemon run in WSL; Windows hosts the GUI,
terminal, and VS Code. One combined depot carries both Windows and Linux
artifacts. VS Code is installed on a clean machine; the extension is also
updated in compatible editors already present.

**Convergence is truthful rather than falsely transactional.** Every chosen
surface must converge before the operation succeeds, but a failed host does not
roll back hosts already updated. Running coder sessions are never terminated;
they are reported as `restart needed`. Active Workers cause the complete update
to stage and remain pending rather than changing the active package set or
stopping work. Rollback restores the previous complete workstation lock.

The standalone `install.sh` is deprecated and redirects to the mise/red-dev
bootstrap. Existing installations are adopted and backed up first; Git-sourced
marketplaces and obsolete caches are removed only after the package-set source
and all managed surfaces verify.

## Consequences

- The release must publish a complete, commit-correlated workstation asset set;
  the current runtime-only npm package and partial checkout are insufficient.
- Gemini's incomplete generated surface and Hermes's missing adapter block a
  truthful seven-host success and must be completed before this guarantee ships.
- Offline depots are target-specific, potentially large, and private because
  they cache third-party distributions rather than republishing them.
- The machine retains at most the active and previous locked workstation
  revisions, plus host cache entries still required by those revisions.
