# 0014 — The companions converge from the set, not from a release

- Status: accepted
- Date: 2026-08-18
- Contexts: `agents`, `lifecycle`, `terminal`
- Refines: ADR 0010 (one package set per workstation) and ADR 0011 (the set is a
  self-contained copy with one identity); extends the host reconciliation those two
  produced to the surfaces that are not agent hosts
- Sources: red-dev #205, Spec #201 (user stories 12, 13, 21, 23, 27; the decisions on
  companion installation, the guaranteed editor and ownership-aware merges)

## Context

Five RedSkills surfaces on a workstation are not agent hosts: the shared runtimes on PATH,
the `redskilled` daemon, the herdr plugin, the VS Code extension and zellij's dashboard
layout. Before this, each arrived its own way. The runtimes were whatever mise happened to
shim; the extension and the herdr plugin were resolved from the newest GitHub release at
converge time and installed with `herdr plugin install <owner/repo/subdir> --ref <tag>`;
zellij had no RedSkills surface at all. So one machine could hold agent hosts reconciled
against set `3.19.5+3fcba9589ff0` and an editor extension from whatever tag GitHub answered
with that afternoon, and nothing on the machine could say which. A release-resolved install
also cannot work on an air-gapped target, which Spec #201 requires.

The host reconciliation built for #204 already had the shape this needs — plan, apply,
verify, record, with an ownership manifest and an observed state digest — but it was private
to `src/red-skills-hosts.ts`.

## Decision

**Companions are installed from artifacts inside the selected package set, and from nowhere
else.** `~/.red-skills/current` is followed; the artifact is found under the set's `dist/` or
`companions/<surface>/`, or it is not. Reconciliation resolves no release, reads no registry
and downloads nothing. A set that does not yet carry an artifact reports `unavailable` — not
a failure, because the remedy is a newer set rather than a retry, and not a fetch, because a
digest cannot speak for bytes that came from somewhere else.

**Every companion record carries the package-set digest and the artifact's own version.**
They are two different facts: the set is `3.19.5` and the `.vsix` inside it may be `4.2.0`,
and "which extension is on this machine" is not a question the set's version answers. Both
are in `~/.local/share/red-dev/red-skills-companions.json` and both are in doctor.

**The ownership machinery is shared with the hosts.** `src/owned-state.ts` owns paths,
fields, blocks and commands, applies a plan, and hashes the observed result; the host and
companion registries differ only in what they own. Two digest algorithms over the same kind
of state would disagree eventually, and the symptom — a surface that reconciles every
converge, or one that never does — would not point at the copy that caused it.

**Configuration the operator wrote is never rewritten.** herdr's `config.toml` receives one
block delimited by a header red-dev wrote, and stands down entirely when the file already
binds `prefix+d`. zellij's `config.kdl` is composed from three authors in order — red-dev's
base, the fragment the set carries, the operator's `config.user.kdl` — with the operator
last and therefore winning over both (ADR 0007).

**VS Code is the guaranteed editor, and it is the one thing here allowed to reach a package
manager.** When the set carries a `.vsix` and the machine has no compatible editor at all,
VS Code is installed through Microsoft's apt repository or winget; every compatible editor
already present — VSCodium, Cursor — then receives the same revision out of the same set.
Nothing about the extension itself is ever fetched. An editor that cannot be installed makes
the extension `blocked`, which fails the reconciliation rather than reporting a surface that
is not there.

**The runtime launchers live in a directory red-dev owns outright, ahead of mise's shims.**
`~/.local/share/red-dev/red-skills/bin` is prepended after the shims in `config/bash/path.sh`,
so it is searched first. Each launcher execs the shim inside `~/.red-skills/current`, which
is what makes it follow the active set without being rewritten and roll back with it.
`~/.local/bin` would have lost to the shim mise made for the same npm package, which is
precisely the drift this ADR removes.

**A failed companion fails the reconciliation, stamps nothing, and takes nothing with it.**
No record is written over a half-applied plan, nothing is uninstalled on the way in, and
pruning runs after the walk over the download cache the release path used to fill — keeping
what the active and previous revisions could still want.

## Consequences

- `red-dev update` no longer resolves RedSkills releases for the extension or the plugin;
  both advance when the set does, and a machine whose set has not moved issues no commands.
- Today's composed sets carry the runtime bundles and the daemon but no `.vsix`, herdr
  plugin or zellij surface (reddb-io/red-skills#3977), so those three report `unavailable`
  on a converged machine until the complete set is published. That is the honest state, and
  doctor says it.
- `herdr plugin link` replaces `herdr plugin install`: the plugin directory is already on
  disk, and link is the command that registers a local one. Verification reads herdr's own
  `plugins.json` and fails when it names a root outside the set.
- A machine converged before this keeps its `red-skills-extensions.json`; the uninstall
  offer reads the companion registry first and falls back to that record, so neither is
  offered twice and neither is stranded.
- The daemon is never signalled. A converge that lands under a running `redskilled` records
  `restart-needed` and says so; plugin freshness does not justify interrupting autonomous
  work.
- `src/red-skills-ext.ts` no longer resolves or installs anything: the release path, its
  asset globs and the repository name are gone, so nothing can reach for them again. What
  stayed is `resolvedSource`, which half the repo asks it, and the uninstall driven by the
  record the old path wrote — a machine converged before this ADR still has exactly what
  red-dev installed on it taken back off.
