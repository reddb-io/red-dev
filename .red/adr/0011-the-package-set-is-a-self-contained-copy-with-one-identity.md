# 0011 — The package set is a self-contained copy, with one identity

- Status: accepted
- Date: 2026-08-18
- Contexts: `agents`, `lifecycle`
- Refines: ADR 0010 (the composed set, and what `current` may name); supersedes the
  "links, not copies" layout of ADR 0008
- Sources: red-dev #202; the red-skills release contract `red.package-set.v1`
  (`scripts/verify-package-set.mjs`, reddb-io/red-skills#3974)

## Context

ADR 0008 resolved RedSkills as four mise `npm:` entries — the core and one package per
plugin — and linked `~/.red-skills/versions/v<x>` into mise's install tree so the layout
would stay in step with mise. Two defects only showed on a machine that had actually
converged: the core package carries the marketplace manifests but no `plugins/` for them to
name, and no `.red/config.yaml` for the OpenCode generator to read, so a Directory
marketplace registered from `current` had nothing to install and the opencode/redcode
refresh died at "config not found". The standalone installer never had either problem
because it *composes* the tree from the same packages, pinned to one version.

ADR 0010 decided that one package set — a complete tree with one identity — is the only
thing `current` may name, and that a signed manifest with a whole-set digest verifies it.
red-skills now publishes that manifest (`red.package-set.v1`: source commit, per-artifact
SHA-256, whole-set digest, cosign keyless bundle) over its release assets; it does not yet
cover the workstation tree (reddb-io/red-skills#3977).

## Decision

**A candidate set arrives one of two ways, and both are verified before `current` moves.**
A *composed* set is built by red-dev from mise's installs: the core and every
manifest-declared plugin at the highest version present in *all* of them, copied into one
tree with the standalone installer's shape (core at the root, `plugins/<name>`, every plugin
`dist/` file beside the core's, `.red/config.yaml`). Version skew is refused, and `current`
stays where it was. Its identity is its version plus a content digest of the whole tree; it
is `unsigned`. A *manifest* set is a directory carrying `package-set.manifest.json`, its
sigstore bundle, `artifacts/` and `tree/`; it passes the publisher's rules exactly (canonical
bytes, key order, sorted unique basenames, one commit, digest recompute, per-artifact size
and SHA-256), then cosign, keyless, offline, against the release identity and the vendored
Sigstore trust root. It is `trusted`. A machine that resolves a trusted set never accepts an
unsigned one again.

**The set is a self-contained copy, not a link into mise's tree.** The `bin/*.mjs` shims
resolve `../dist/` through their real path and would find the core's `dist/`, never the
plugin bundles; the OpenCode generator writes into `<tree>/dist/opencode`, which through a
link is a write into a mise-owned tree; `mise prune` would collect the revision `previous`
rolls back to; and a Windows file symlink needs a privilege a junction does not. A revision
lives at `~/.red-skills/sets/<version>+<digest12>`, immutable and reused by name; only
`current` and `previous` are links (junctions on Windows).

**Identity is version + digest + source commit, never a path.** The machine keeps the active
revision and the previous one, records both in `~/.red-skills/package-set.json` together
with why the last candidate was refused, and doctor reports exactly that. A second converge
writes nothing.

**red-dev does not invent manifest fields.** `targets`, `version` and `channel` belong in a
`red.package-set.v2` the publisher signs; until then a v1 manifest is target-neutral and an
unknown schema is refused as incompatible metadata.

## Consequences

- The four mise entries stay as the *acquisition* until #203's mise plugin and
  reddb-io/red-skills#3977's complete set replace them; what changed is that they are no
  longer resolved into the layout independently.
- `cosign` is a core manifest entry, and its trust root is vendored (`vendor/sigstore/`), so
  a depot import verifies with no network.
- About 25 MB per retained revision, two revisions; the ADR 0008 links under `versions/`
  are left alone (a dangling one is removed) and the retention module collects the
  standalone installer's trees as before.
- The `internal` plugin the marketplace lists is not declared in the manifest and so is not
  composed; nothing asks a host for it.
- `trusted` means the release identity signed exactly the declared artifacts and those are
  the bytes on disk; the tree beside them is covered once red-skills publishes the complete
  set (#3977) — the wording in doctor says so.
