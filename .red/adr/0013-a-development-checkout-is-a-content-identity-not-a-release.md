# 0013 — A development checkout is a content identity, not a release

- Status: accepted
- Date: 2026-08-18
- Contexts: `agents`, `provisioning`, `lifecycle`
- Refines: ADR 0010 (the local mise plugin), ADR 0011 (what a package set is), ADR 0012 (one acquisition, dispatched into)
- Sources: red-dev #206; Spec #201; mise's `path:` tool selector

## Context

ADR 0012 gives this machine exactly one acquisition: a channel resolves to a
commit, the commit is archived into an immutable snapshot, that commit's release
assets are overlaid, the signed manifest is verified, and only then does
`current` move. Every one of those steps is a statement about something somebody
published.

None of them is true of the tree a person is editing. A working checkout has no
release to resolve, frequently no tag, usually uncommitted edits, and never a
signature — so the acquisition would refuse it four times over. Yet the tree a
person is editing is precisely what they need this machine to resolve while they
edit it, and the alternative they reach for otherwise is a symlink into
`~/.red-skills/current`, which puts a mutable directory behind a pointer the
whole machine treats as immutable.

The other half of the context is what a checkout must not cost. The bytes belong
to Git and to the package manager: a build that writes `dist/` into the working
tree makes the developer's `git status` dirty because red-dev ran, and a sync
that touched `node_modules` would be red-dev acting inside a directory it does
not own.

## Decision

**A checkout is admitted through its own door, and the door is narrow.** It is
spelled `path:<dir>` — mise's own word for the same thing — and it is refused
unless spelled that way, because a bare directory name and a channel name are
both just words and a selector that guessed between them would install a release
for a typo'd path.

**The identity is the content, and never the path.** A revision key is
`<version>-dev.<content8>+<content12>`, where the content is a sha256 over the
checkout's source: the same walk and the same relative paths a composed set is
digested with, minus `.git` and `node_modules`. Two directories holding the same
bytes are therefore one revision, and a machine that synced one has nothing to do
for the other. A key derived from where a directory happens to sit would change
when somebody moved it, and every downstream comparison — is this active, is it
staged, were the hosts reconciled against it — would silently be answering about
a path.

`.git` is excluded because it is version-control state rather than content: a
`git status` writes an index, and an identity that moved when you *looked* at the
repository would be no identity. `node_modules` is excluded because it belongs to
the package manager.

**The version says `dev`, everywhere a version is printed.** `3.20.0` becomes
`3.20.0-dev.4f2c81ae`. A checkout that borrowed the bare version would be
indistinguishable, in the state file and in `red-dev doctor`, from the release it
was branched from — and the point of the override is to run something that is not
that release. The revision is recorded as `kind: "checkout"`, `trust: "unsigned"`,
and doctor prints it as a development checkout rather than as a published set.

**Same commit, or built here.** A checkout that is clean at a commit reuses that
commit's published bundles: they describe exactly these bytes, and reusing them
is one download instead of a build. A checkout with uncommitted edits reuses
nothing — those bundles describe bytes that are no longer there, and overlaying
them would produce a tree whose source says one thing and whose bundles say
another, which is the cross-commit failure ADR 0012 refuses under a different
name. Assets declaring some *other* commit are refused outright, exactly as they
are online, and the refusal is recorded in `~/.red-skills/package-set.json` so
doctor can say why hours later.

**The build runs in the staging, so the checkout never moves.** The source is
copied into `~/.red-skills/checkouts/<key>/tree` and the checkout's own `build`
script runs *there*. Its own script rather than one red-dev knows how to perform:
red-dev has no opinion about how RedSkills is bundled, and one written here would
be a second build to keep in step with the repository's. The content digest is
recomputed when the staging is finished and the sync refuses if it moved, which
makes "the checkout is byte-for-byte unchanged" a property of the code rather
than a promise about it.

**Staging is keyed by the digest, so a second sync with no edits does nothing.**
A staging directory carries a receipt naming its own key, written last and
renamed into place, so an interrupted build is a directory with no receipt and is
rebuilt rather than activated. A staging whose key matches is reused whole: no
copy, no download, no build — and the activation then writes nothing, because
`current` already resolves to that revision and the reconciliation stamp already
names it.

**Only an explicit `red-dev red-skills sync <path>` advances a checkout.** The
mise plugin's install phase recognises a `path:` override and acquires nothing:
mise's job is to record which version a tool is on, and a working tree moves for
reasons mise has no way to see, so a `mise upgrade` that "advanced" one would be
advancing it to whatever it already was while reporting an install. `red-dev
update` leaves it too — an unpinned update on a machine resolving a checkout
returns before it reaches the remote. Naming a revision explicitly
(`red-dev red-skills install 3.19.5`) still leaves the override, because that is
a person asking to go back.

## Consequences

- `red-dev doctor` gains a third kind of active revision, and a machine on a
  checkout reads as a warning rather than as an error: unsigned is the accurate
  thing to say about a tree nobody published, and the verified revision it
  displaced stays retained as the rollback.
- The downgrade guard — an unsigned composed set may not replace a verified one —
  deliberately does not apply here. That guard exists so a set nobody asked for
  cannot displace a verified one; a checkout is the one candidate somebody asked
  for by name.
- `~/.red-skills/checkouts/` grows with what a developer edits rather than with
  what is released, so it is held to the same retention the revisions are: the
  active staging and its rollback.
- A checkout that carries no `build` script, or whose build produces no bundles,
  is refused with that sentence. That is a one-line fix in the tree rather than a
  mystery about a missing bundle at the first host launch.
- The sync costs one full content walk of the checkout on every invocation, twice
  when it stages. That is what buys a path-independent identity and the
  unchanged-checkout proof; a mtime-based shortcut would be faster and would be
  wrong the first time two machines disagreed.
