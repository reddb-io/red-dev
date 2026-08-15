# 0006 — One chord family on every target, and it is not Super

- Status: accepted
- Date: 2026-08-15
- Sources: `.red/contexts/interaction/CONTEXT.md`, the Omarchy Quattro comparison session of 2026-08-15

## Context

Omarchy Quattro's interaction model is Super-centric — `Super+Return` terminal,
`Super+Space` menu, `Super+K` keybinding viewer, `Super+W` close, `Super+Ctrl+W`
network panel — and it is the most praised part of the product. red-dev is
about to grow its own semantic actions (menu, keys viewer, panels, emoji, default
agent) and needs default chords for them on Ubuntu desktop and on Windows.

Both hosts reserve most of the Super/Win space. GNOME takes `Super` itself
(overview), `Super+Space` (input source), `Super+A/V/L`, `Super+arrows`,
`Super+1..9`. Windows takes `Win+Space` (language), `Win+V` (clipboard history),
`Win+K` (cast), `Win+W`, `Win+C` (Copilot), `Win+E/R/L/D/X/I/A/N/H/P/S/G/Tab`,
`Win+arrows`, `Win+1..9`. Copying Omarchy's map literally collides on both, and
choosing "the nearest free chord" per host gives every action a different key on
every machine.

## Decision

**Every semantic action has one default chord, identical on every target, drawn
from the `Ctrl+Alt` family** — where `Ctrl+Alt+T` (terminal) and
`Ctrl+Alt+Shift+T` (elevated shell) already live. red-dev never claims a
`Super`/`Win` chord. A platform adapter changes how a chord is registered
(GNOME custom keybinding, Windows Start Menu `.lnk` hotkey, PowerToys); it never
changes which chord it is. Where a host cannot register the chord, the adapter
reports the action unbound and does not invent a local substitute.

## Consequences

- "The same experience on each target" stays literally true for the keyboard,
  which is the surface a person's hands remember across machines.
- Someone arriving from Omarchy or from stock GNOME will reach for `Super` and
  find nothing; the keys viewer (`red-dev keys`) is the remedy, not a second map.
- The `Ctrl+Alt` family is finite and partly spoken for on GNOME
  (`Ctrl+Alt+arrows` workspaces, `Ctrl+Alt+Del`, `Ctrl+Alt+L`); every new chord
  is checked against both hosts' reserved lists before it ships, and the schema
  is where that check lives.
- Universal clipboard (`Super+C/V/X`) is out of scope for the same reason and
  because the terminal layer already unifies copy/paste everywhere.
