# 0007 — Every owned file has a user layer a converge never writes

- Status: accepted
- Date: 2026-08-15
- Sources: `.red/contexts/visual/CONTEXT.md` (Config ownership modes, User layer), the Omarchy Quattro comparison session of 2026-08-15

## Context

Omarchy Quattro's biggest structural change is "everything is a package":
Omarchy lives in `/usr/share/omarchy`, the person's changes live in
`~/.config/omarchy/*` and `~/.config/hypr/*.lua`, plugins are cloned to
override, and an update can replace every shipped file without touching a
person's work. That is the fix for what Omarchy 1–3 got wrong (a git checkout
in the home directory that updates trampled).

red-dev already has the ownership vocabulary — `owned`, `merged`, `adopted`,
`external` — but not the layer. `alacritty.toml` is the one surface done right:
written once, loaded after the regenerated `keys.toml`, so anything the person
puts there wins. `~/.config/red-dev/env.sh` does the same for bash. zellij's
`config.kdl` is owned and regenerated on every converge, and zellij has no
include mechanism, so any edit a person makes to it is silently lost.

## Decision

**For every `owned` file there is a user layer: a companion the person authors,
loaded after red-dev's, that a converge never writes.** Where the program can
include (Alacritty, bash, git), the layer is a real file the program reads last.
Where it cannot (zellij), red-dev composes base + layer into the file it owns
and treats the layer as the source of truth for the person's half. Each owned
surface documents where its layer lives; a converge may replace everything
red-dev wrote and must leave the layer untouched.

## Consequences

- This is Omarchy's clone-to-override without a plugin system, which red-dev
  does not have and does not need: there is no shell to plug into.
- Regenerating an owned file stops being a data-loss risk, so the ownership
  warning currently attached to `keys.toml` becomes the rule rather than the
  exception.
- The composition path (zellij) makes red-dev responsible for merge semantics
  it did not have before; the test is that a converge is a no-op on a machine
  where only the layer changed.
- Adopting an existing file (`adopted`) now means: take over the owned half and
  move what the person had into the layer, with their consent and a plan — not
  overwrite.
