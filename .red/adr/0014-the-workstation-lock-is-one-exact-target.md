# 0014 — The workstation lock is one exact target, and an account is not an installation

- Status: accepted
- Date: 2026-08-19
- Contexts: `provisioning`, `agents`, `lifecycle`
- Refines: ADR 0010 (one RedSkills package set per workstation), ADR 0011 (what a package set is)
- Sources: red-dev #208; Spec #201; `src/manifest.ts` (the provider matrix this locks)

## Context

ADR 0011 gives the RedSkills package set one identity: a version, a source
commit, a whole-set digest, and a signature over all three. Everything *around*
it has none. Claude Code arrives from an install script that fetches whatever
shipped this morning, Codex from npm at whatever `latest` resolves to when the
converge runs, zellij from a release tag, VS Code from Microsoft's apt
repository, node and python from mise. Six acquisition paths, and not one of them
writes down what it took — so two workstations provisioned an hour apart are two
different workstations, and the only way to learn which one a bug belongs to is
to go and look at both.

ADR 0010 deliberately keeps those applications as independent tools rather than
folding them into the package set, so their publishers keep their own release
cycles. That decision is right and it leaves a hole: nothing decides the
combination. An offline depot cannot be built out of a hole — a machine with no
network cannot resolve `latest`, and a rollback that restored one application at
a time would be restoring a combination nobody has ever run.

The second half of the context is what "provisioned" can honestly mean without a
network. Every coder CLI in the set needs an account somewhere, and no depot on a
USB stick can supply one. A bootstrap that counted a missing Anthropic login as a
failed installation would report a correct air-gapped workstation as red forever,
and the operator would learn to ignore the report.

## Decision

**One lock, one target, and a target is one or more surfaces.** Ubuntu is a
single surface. A Windows workstation is two — the coder CLIs, zellij and herdr
in WSL, the GUI applications native — provisioned from one medium, so it is one
target with two surfaces rather than two targets. Every locked application names
its surface, because "codex 0.55.0" without a place is satisfied by installing it
on the wrong side of the fence.

**Exact, or refused.** A lock records a version that resolves to itself: a moving
selector (`latest`, `stable`, `next`, a branch, a range) is refused as a version,
a source URL that resolves through a moving pointer is refused as a source, and a
package coordinate that does not name the locked version is refused as a
disagreement between what will be installed and what was written down. The
refusals happen before the first step runs, because a locked installation that
discovers its input was wrong halfway through has already put an unlocked version
on the machine.

**A cross-target input is an identity error, not a partial match.** A lock for
another target, an entry naming a surface its target does not have, or a machine
missing one of the target's surfaces stops the whole operation. Provisioning half
a Windows workstation from an Ubuntu lock is worse than provisioning none of it.

**Every entry carries a checksum and a provenance record.** The provenance
vocabulary is closed — npm provenance, GitHub attestation, a sigstore bundle, a
publisher's signing key, a winget manifest, published release checksums — because
the interesting question about a depot is what kind of proof it rests on, and an
answer in free text is an answer nobody can group.

**Readiness is installed, synchronized and verified. An unconfigured account is
reported.** The plan carries the accounts a person still has to configure, naming
the service and the file that would prove it, and that list never touches the
verdict. A bootstrap that ends with seven CLIs installed and seven accounts
unconfigured has succeeded and says exactly what is left.

**The package set is not in the lock.** It has an identity of its own, signed by
its publisher, and a second version of it here would be a second answer to a
question that already has one.

**A lock that was not resolved from published bytes may be planned and never
installed.** The fixtures in `src/fixtures/workstation-lock/` carry `origin:
"fixture"`: their checksums were written down rather than computed from what a
publisher shipped. They are enough to plan a clean machine — which is what the
tests do — and `installFromLock` refuses them, so a digest nobody verified can
never authorise an installation.

## Consequences

- The lock is resolved through an injected resolver, so the only thing standing
  between a hundred registry lookups and a test table is one function. The
  committed fixtures are asserted byte-for-byte against what resolution produces,
  which is what makes a fixture evidence rather than decoration.
- The encoding is canonical — fixed key order, sorted entries, digest over the
  identity bytes, exactly the bytes on disk — for the same reason the package-set
  manifest is: a lock that arrives reformatted is refused rather than re-blessed
  under a digest computed from something else.
- mise and red-dev appear twice in a Windows lock, once per surface. That is not
  duplication: the WSL installation owns the runtimes and the CLIs, the Windows
  one owns the host configuration, and the surface field is what lets the lock
  say so.
- An application whose publisher offers no version argument to its install script
  cannot be locked, because a script that always installs the newest release is a
  moving selector with a URL. That is a conversation with the publisher rather
  than a special case here.
- Adding Ubuntu 26.04 is a surface and a fixture. Adding an arm64 target is the
  same, and the artifact names it resolves will differ — which is precisely why
  the artifact belongs to the resolution rather than to the catalogue.
