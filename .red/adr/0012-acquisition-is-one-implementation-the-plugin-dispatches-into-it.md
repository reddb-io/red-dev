# 0012 — Acquisition is one implementation, and the mise plugin dispatches into it

- Status: accepted
- Date: 2026-08-18
- Contexts: `agents`, `provisioning`, `lifecycle`
- Refines: ADR 0010 (the local mise plugin), ADR 0011 (what a package set is)
- Sources: red-dev #203; mise's asdf-compatible plugin contract and tool-level `postinstall`

## Context

ADR 0010 gives online RedSkills acquisition to a local mise plugin: channels
(`stable`, `next`, an exact version or commit), one shared Git mirror, immutable
snapshots, release assets overlaid from the same commit, a verified signed
manifest, and red-dev's reconciliation invoked from a tool-level postinstall. It
also requires that `mise upgrade red-skills` and `red-dev update` reach the same
idempotent result.

A mise plugin is a directory of executables — `bin/list-all`, `bin/latest-stable`,
`bin/install` — which mise runs as shell. Writing the mirror, the snapshot, the
overlay and the signature check *in those scripts* would put a second acquisition
on the machine beside the one `red-dev update` runs, free to disagree with it
about which commit is current while both report success. The two entry points
would then be two implementations of the same guarantee, which is the failure the
acceptance criterion names.

The other half of the context is timing. red-skills publishes `red.package-set.v1`
over its release assets but not yet the complete workstation tree beside it
(reddb-io/red-skills#3977), and ADR 0011's four npm entries are still what
composes a usable set on a real machine today.

## Decision

**The acquisition is one TypeScript implementation, and the plugin's scripts
dispatch into it.** Each `bin/*` is a few lines of bash that `exec "$red_dev"
red-skills <phase>`. The plugin owns the contract — the names mise calls, the
`ASDF_*` environment it sets, the exit code it reads — and red-dev owns the work.
`red-dev update` calls the same functions directly, so "both entry points reach
the same active digest" is true by construction rather than by review.

**Cheap questions come before expensive ones, and a machine already on the
resolved commit does nothing at all.** A channel is resolved with `git ls-remote`,
which needs no clone. The release's package-set manifest is fetched next, because
it is one request and it decides whether there is anything to acquire. Only then
is the mirror cloned (once, and fetched every time after), the commit archived
into `~/.red/skills/snapshots/<commit>`, and the candidate staged. An acquisition
whose resolved commit is already the active revision's returns before any of it,
which is what makes a no-op install produce no host writes.

**Assets belong to the resolved commit, or they are refused.** A manifest whose
`sourceCommit` is not the resolved commit, an artifact whose SHA-256 or size does
not match, a release publishing a manifest with no signature bundle beside it —
each is refused before red-dev is asked to reconcile anything, and the refusal is
recorded in `~/.red/skills/package-set.json` so doctor can say why hours later.
Only `*.bundle.min.mjs` and `*.asset.cjs` overlay into the tree's `dist/`, which
is the shape ADR 0011's composed set already produces; the rest of the release
stays in `artifacts/` for the companion surfaces.

**A release with no package set is `unavailable`, and a remote nobody can reach is
`unreachable` — neither is refused.** The first is the ordinary state of every
machine until #3977 publishes the complete set; the second is a laptop on a train.
Only a refusal is a statement about a package set, so only a refusal is recorded:
the other two leave the state file byte-identical, `current` naming the set it
already named, and the machine exactly as it was.

**Reconciliation is gated on the identity, not on being invoked.**
`~/.red/skills/reconciled.json` records the revision key the hosts were last
converged against, and holds nothing else — no timestamp, no count — so an
unchanged run leaves it byte-identical. mise runs the tool-level postinstall after
every install it performs, including reinstalls of the same revision; the stamp is
what turns that into one process and no host state.

**The plugin is installed as `red-skills-set`, not as `red-skills`.** A plugin's
directory name is its tool name, and `red-skills` is already the alias the
generated fragment maps to `npm:@reddb-io/red-skills`. Installing under that name
would swap the acquisition on every machine that upgrades before the complete set
is published — and this acquisition answers `unavailable` until then, which would
leave those machines with no source at all. The `[tools]` entry moves onto the
plugin in one line when #3977 lands; both paths already converge through the same
functions, so that line is the whole migration.

## Consequences

- The plugin cannot work on a machine without red-dev, and says so rather than
  failing at its first command. That is the correct dependency direction: red-dev
  installs mise, and ADR 0010 already makes red-dev the sole host-wiring owner.
- `red-dev red-skills` is a real command surface, because the plugin scripts and
  the postinstall both invoke it. Its `list-all` and `latest-stable` phases print
  bare versions to stdout, since mise parses exactly that.
- Snapshots and staged candidates are retained for the same two revisions the sets
  are — the active one and its rollback — so the mirror is the only thing on the
  machine that grows with the repository's history rather than with its releases.
- A package set may now carry a prerelease version (`3.20.0-next.1`), because the
  `next` channel is the prereleases; the revision key and the tree's version
  pattern in red-skills-set.ts admit one. mise's installs tree still does not:
  there, an exact `x.y.z` is what tells a version apart from a selector link.
- `red-dev update` performs an online acquisition on every run. Until #3977, that
  costs one `git ls-remote` and one release API call, and changes nothing.
