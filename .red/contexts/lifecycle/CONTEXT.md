# Context: lifecycle

The identity, movement, and retention of installed product revisions.

## Version channel

A named policy for selecting a revision: `stable` follows production releases, `next` follows prereleases, and a pinned version or commit remains fixed. An offline depot resolves a channel before export and carries that exact revision; it never interprets “latest” without a source it can consult.

_Avoid_: latest version (ambiguous without a channel and source)
