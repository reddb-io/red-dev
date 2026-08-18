# Context: lifecycle

The identity, movement, and retention of installed product revisions.

## Version channel

A named policy for selecting a revision: `stable` follows production releases, `next` follows prereleases, and a pinned version or commit remains fixed. An offline depot resolves a channel before export and carries that exact revision; it never interprets “latest” without a source it can consult.

_Avoid_: latest version (ambiguous without a channel and source)

## Revision identity

What names one installed RedSkills revision anywhere: its version, its whole-set digest and its source commit — `3.19.5+3fcba9589ff0@626a284`. Never its path: two machines resolving the same identity through different paths are running the same software, and that is the fact worth being able to state. Recorded, with the previous revision and why the last candidate was refused, in `~/.red-skills/package-set.json` (ADR 0011).

_Avoid_: installed version (a version alone cannot tell a composed set from a published one, or one plugin payload from another)

## Trust verdict

What the machine believes about who published a revision: `trusted` (the release identity signed exactly the declared artifacts, checked by cosign against the vendored Sigstore trust root, offline), `unsigned` (a composed set — a fact to report, not a verdict to act on) or `untrusted` (a signature that is missing or does not verify — refused). A machine that resolves a trusted revision never accepts an unsigned one again.

_Avoid_: verified (says nothing about by whom), signed (a signature that does not verify is also "signed")
