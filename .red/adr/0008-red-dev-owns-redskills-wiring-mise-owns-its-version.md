# 0008 — red-dev owns RedSkills wiring; mise owns its version

- Status: superseded by ADR 0010
- Date: 2026-08-16
- Contexts: `agents`, `lifecycle`
- Sources: the RedSkills `/start` grilling session of 2026-08-16; red-skills ADR 0146 (what gets published)

## Context

red-dev installs RedSkills by curling `install.sh` v3 (`agents.ts:667`) — a
builtin that hands the entire job to a script — and then keeps
`~/.red/skills/current` around as the tree it builds the VS Code extension and
the herdr plugin from. `mise-config.ts` already records that the agents were
deliberately left out of the mise manifest, as a second migration. This is that
migration.

Marketplace registration is why it matters. `plugin marketplace update` re-reads
whatever source was registered, so a `Directory` registration freezes a machine
at its install-day snapshot forever — which is exactly why `install.sh`
registers from GitHub and treats `Directory` as the offline/dev escape hatch,
and why it carries a `heal_marketplace_source` that re-registers a machine it
finds on the wrong one. The directory was never the stale option because
directories are stale; it was stale because **nothing moved it**. mise is a
thing that moves it.

## Decision

**red-dev owns the wiring of RedSkills into every agent host on the machine:**
Claude Code, Codex, OpenCode, RedCode and pi. Claude and Codex are CLI calls it
makes itself. OpenCode, RedCode and pi are the generators inside the installed
tree, **invoked, never reimplemented** — each generator renders the skills that
ship beside it, so porting one here would make a new RedSkills skill wait for a
red-dev release before it could appear.

**Each RedSkills package is a manifest entry, and mise resolves it.** The core
package always; one entry per plugin, opt-out like every other tool, so the
operator's choice lives where "what this machine has" is already declared. All
of them resolve through `npm:` at `latest`. The `github:` backend is wrong for
this payload: it scores release assets to put one executable on PATH, and what
we install is a tree.

**red-dev maintains the layout.** `~/.red/skills/versions/<v>` links each
installed package set, `current` names the newest, and both install modes
produce the same shape so the launcher has one contract to resolve against.
Windows uses junctions — the directory-copy path is the class of bug
`repairCopiedRedSkillsCurrent` already exists to clean up after.

Retention is mise's job: `mise prune` at the end of update. The first migration
also removes the legacy `~/.red/skills/versions`, `~/.red/skills/cache` and the
host plugin caches — 1.16 GB on the machine this was measured on, all of it
derived state the hosts rebuild on demand.

**Hosts are refreshed only when the resolved version changed.** Running
`marketplace update` plus `plugin update` across five hosts is not cheap enough
to do when nothing moved.

**Where red-dev is present, it is the declared owner**: the `Directory`-sourced
marketplace wins, and the standalone installer stops healing to `GitHub` when it
detects red-dev. Two marketplace names on one machine would install every plugin
twice. Both install modes remain fully supported — the standalone one-liner
stays a first-class path for machines without red-dev.

## Consequences

- red-dev inherits the failure modes of five host CLIs, including Codex's
  missing `plugin update` (remove/re-add) and each host's marketplace quirks.
- A plugin the operator opted out of still works if some repository enables it
  under ADR 0067 — its bundle simply resolves through npm instead of from disk.
- `mise upgrade` alone stops being sufficient: a version change reaches the
  hosts only through red-dev, which is now the only thing that refreshes them.
- The `lifecycle` context gets its first resolved terms: version selector,
  retention, channel ownership, and who moves the pointer.
