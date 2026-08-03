# Context: interaction

Interacting with the machine — actions, hotkeys, tiling, workspaces, launcher.

## Semantic action

A portable unit of interaction (`terminal.new`, `window.tile.left`, `workspace.goto.N`…): identity and meaning are defined platform-neutrally; each platform provides a bindings adapter — GNOME and PowerToys/FancyZones are the first two, born together to prove the contract's portability. Hotkeys, cheat sheets, and conflict detection derive from the schema, never the other way around.
