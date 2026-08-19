# 0016 — A legacy workstation is adopted before anything is removed

- Status: accepted
- Date: 2026-08-19
- Contexts: `agents`, `provisioning`, `lifecycle`
- Sources: Spec #201 acceptance criteria for migration; the ADR 0008 cleanup as shipped

## Context

Machines provisioned under Spec #185 carry a complete second RedSkills. The
standalone `install.sh` extracted a tree per release under
`~/.red-skills/versions`, kept the tarball it came from, registered a
Git-sourced marketplace in Claude and Codex, ran generators that wrote
OpenCode, RedCode and pi surfaces recorded in their own manifests, left every
host holding a copy of every plugin version it had ever carried, and wrote a
release-driven record naming the editors that took the VS Code extension.
Measured on one developer host: about 1.16 GB, none of it collected by
anything, because the only thing that could have was the same install script.

red-dev already removed most of that, in a migration that ran during install.
It ran **ungated**: the plan was built and applied in one pass, with nothing
between them. On a machine where the package set had not landed — no network,
a refused manifest, a Worker holding the activation — that took the only
RedSkills there was, and left a workstation with seven wired hosts resolving a
directory that no longer existed.

The migration was also the last thing on the machine still reaching for the
standalone acquisition. `installRedSkills` curled `scripts/install.sh` from the
repo's `v3` branch on every converge that found a host unwired, which made
red-dev a second owner of `~/.red-skills/current` — the drift ADR 0010 exists
to end, with both ends of it inside this repo.

## Decision

**Adoption is four phases in one order, and the order is the contract.**
Inventory, back up, verify, then clean up. Removal is last and is the only
phase that takes anything, which is what makes an interrupt survivable at every
point above it: a run killed during the inventory, during the backup or during
verification leaves the previous source exactly where it was, and the next run
starts again from the same inventory.

**The gate is the whole difference from what was here before.** Cleanup does
not begin until the package set is active, all seven host adapters have
reported and none is blocked or failed, and every companion has converged. It
is gated on the outcomes the converge that just ran *observed* — not on a
record an earlier converge wrote, and not on the existence of a `current` link,
which is what an ungated cleanup mistook for a working workstation. A host that
is `absent` passes, because a machine without gemini is not a host red-dev
failed to wire; a host that was never reported does not, because an unreported
surface is one nothing checked.

**Obsolete is defined per kind, and every definition is a question with an
answer on disk.** A version tree is superseded once `current` no longer
resolves into `versions/`. A registration is superseded only when the host
itself reports red-dev's directory source on re-read, never because a converge
said it re-registered. A generated path is superseded when the legacy manifest
names it and the host registry does not own it. A plugin copy or companion
artifact is superseded when its version is neither active nor previous and no
host records resolving through it. Files the operator wrote are never in the
inventory: what comes out of a config file somebody else owns is one entry, and
the rest of the file is theirs.

**The backup lives outside what an uninstall removes.** Under
`~/.local/state/red-dev/adoption/<stamp>`, not `~/.local/share/red-dev`, for
the same reason the pre-red-dev dotfiles backup is left where it is: it is the
only copy of what was there before. Every kind is copied except the extracted
version trees, which are recorded by identity — a tree is a published tarball
unpacked a second time, the tarball beside it *is* copied, and duplicating a
gigabyte in order to reclaim a gigabyte reclaims nothing.

**red-dev no longer downloads or invokes the standalone acquisition.**
`installRedSkills` acquires the package set in-process, and the converge
reaches it only on a machine that resolves no source at all — wiring is the
host reconciliation, and a marketplace registration is no longer a reason to
download an installer. What red-dev removed is written into a record it owns,
so an uninstall takes back exactly that and nothing on the evidence that a path
looks like ours.

## Consequences

- The ADR 0008 legacy-retention module is gone; the migration that ran it now
  asks the gated adoption to run instead, and refuses to remove anything on a
  machine that has not converged.
- An operator can be told to converge first: `red-dev red-skills adopt` exits
  non-zero when the gate refuses and names the surfaces nothing verified.
- Machines that never carried Spec #185 state pay one inventory walk per
  converge and nothing else — an empty inventory is reported `clean` and writes
  no backup at all.
- A registration a host has not moved off survives adoption and is reported
  with the reason, so a partially adopted machine is visible rather than
  silently half-done.
