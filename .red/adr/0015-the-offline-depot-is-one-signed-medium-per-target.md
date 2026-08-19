# 0015 — The offline depot is one signed medium per target, and it carries no secret

- Status: accepted
- Date: 2026-08-19
- Contexts: `provisioning`, `agents`, `lifecycle`
- Refines: ADR 0010 (one RedSkills package set per workstation), ADR 0011 (what a package set is), ADR 0014 (the workstation lock is one exact target)
- Sources: red-dev #211; Spec #201; `src/offline-depot.ts`

## Context

ADR 0011 gives the RedSkills package set one identity and one verifier.
ADR 0014 gives everything around it one exact version per surface, with a
checksum and a provenance record each. Both were written for a machine that
can reach a network: the set is acquired from a GitHub release, and the lock
records where each artifact *would* be fetched from. A target behind an air
gap can read neither, and until now there was nothing between the two that a
person could carry.

The obvious shape — copy the release assets onto a stick — fails on three
counts. Nothing says which target the stick was cut for, so an Ubuntu medium
half-applies to a Windows workstation and stops in the middle. Nothing binds
the artifacts to the lock, so an artifact edited in transit installs and the
machine never learns. And a directory assembled by hand out of somebody's home
directory is exactly the shape of accident that carries an `~/.aws/credentials`
or an `.npmrc` publish token onto a stranger's desk.

## Decision

**One depot, one target, one signed manifest.** `red.offline-depot.v1` names
the target in full, the lock digest, the package-set identity it activates and
the revision it rolls back to, the activation, and every entry with its
depot-relative path, size and sha256. The digest is taken over all of it in
canonical bytes, and a manifest that arrives reformatted is refused rather than
re-blessed under a digest computed from whatever showed up — the same rule the
package-set manifest and the lock already live by.

**A depot is exported from bytes that verified, and only from bytes that
verified.** The export refuses a `fixture` lock, refuses an incomplete lock,
refuses a package set that will not verify on the exporting machine, and
refuses any artifact that does not hash to what the lock says. The target has
no second chance: it cannot re-fetch, so every question has to have been
answered before the medium left.

**The import opens no socket, and the installer is handed its bytes.** Nothing
on the import path takes a fetcher. The artifact for each locked application is
read out of the machine's own copy of the depot and re-hashed against the lock
*before* the installer sees it, so an installer that wanted to reach for the
network would have to invent a URL nothing gave it. "Installed from the depot"
is therefore a property of the code rather than a promise in a runbook.

**Machine-owned storage, copied, never linked.** The depot is copied under
`~/.red-skills/depots/<digest12>` before anything installs from it, for the
reason ADR 0011 copies a package set rather than linking one: the medium is a
USB stick somebody is about to unplug.

**Both ends scan, and a finding never quotes the secret.** The export refuses
to finish a depot containing recognised credential material and the import
refuses to read one. Findings name the recogniser and the path only — a report
that quoted the matched bytes would put the secret into the log, the doctor
output and whatever issue comment pastes them, which is the leak the scan
exists to prevent.

**Verification is unconditional; writing is conditional.** Every import
re-parses the manifest, re-hashes every entry, re-checks the signature and
re-scans for credentials. What it *writes* is skipped when the machine-owned
copy already holds the same manifest bytes, when the lock finds an application
already at its locked version, and when the state file would be rewritten
identically. So a second converge on an unchanged machine writes nothing, and
that is a value a caller reads rather than a filesystem a caller watches.

**One activation, decided elsewhere.** The depot carries `dev` because
`src/red-skills-plugins.ts` says so, and the import refuses when the machine
would switch on anything else. A depot free to declare its own activation would
be a second answer to a question that already has one, and the second answer is
the one that ships Memory and Brain switched on.

## Consequences

- The credential scan is honest about its reach: fixed-prefix tokens their
  issuers made recognisable, plus well-known credential stores by path. An
  opaque secret in a file nothing here names will not be found. It is a guard
  against the ordinary accident, not against a determined leak, and it says so.
- Binary artifacts skip the content pass. A `.deb` of any size will eventually
  contain a byte sequence matching almost any pattern, and a scan nobody
  believes is a scan nobody runs.
- The journey in `src/offline-depot-e2e.ts` is one function that both `bun test`
  and `bun run e2e:offline-ubuntu24` call, so the command in the acceptance
  criteria and the gate cannot come to different conclusions. It substitutes
  three things a hermetic run cannot have — the publisher's bytes, a signing
  identity, and root — and names all three rather than hiding them.
- Adding Ubuntu 26.04 is a target and a fixture, exactly as it is for the lock.
  Adding a second medium format (an ISO, an apt mirror) is a layout question
  under one manifest, not a second manifest.
- A depot is bound to one package-set revision plus the one it rolls back to.
  A target that needs a third has to be handed a second medium, which is the
  honest cost of having no network rather than something to paper over.
