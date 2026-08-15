# Context: interaction

Interacting with the machine — actions, hotkeys, tiling, workspaces, launcher.

## Semantic action

A portable unit of interaction (`terminal.new`, `window.tile.left`, `workspace.goto.N`…): identity and meaning are defined platform-neutrally; each platform provides a bindings adapter — GNOME and PowerToys/FancyZones are the first two, born together to prove the contract's portability. Hotkeys, cheat sheets, and conflict detection derive from the schema, never the other way around. The schema is born now, seeded with the bindings red-dev already writes (zellij, Alacritty, Windows Terminal, readline, agent hosts, the global hotkeys), and `red-dev keys` — the searchable viewer, where Enter fires the action — is its first consumer (decision of 2026-08-15). The first schema carries what already exists (terminal, elevated shell, Shift+Enter/Alt+V, zellij) plus the menu, the keys viewer, the Panels, the Emoji picker, and two agent actions — `agent.launch` (the Default agent) and `agent.multiplex` (herdr, reported absent where it is not installed); per-web-app chords are catalogue, not default. The `red-dev` menu grows by flat sections — Keys, Panels, Agents (default · usage · update), Learn (README by anchor, RedSkills, keys) — not by Omarchy's tree.

## Chord

The key combination a bindings adapter attaches to a semantic action. The default chord for an action is **the same on every target**, drawn from the `Ctrl+Alt` family where `Ctrl+Alt+T` already lives; red-dev never claims `Super`/`Win` chords, because GNOME and Windows both reserve most of them and an identical experience across machines outranks matching Omarchy's muscle memory (decision of 2026-08-15). The adapter changes *how* a chord is registered, never *which* chord it is.

_Avoid_: hotkey (the colloquial term — fine in prose, not as the concept), shortcut, keybinding (reserved for the file a program reads)

## Panel

A red-dev terminal surface for one host subsystem — network and DNS, audio input/output, power, bluetooth — driving the platform's first-party CLI so the same panel behaves the same on every target. Where a target has no first-party CLI for that subsystem (audio devices and bluetooth on Windows), the action opens the host's native panel instead of promising a red-dev one. When an act inside a Panel needs rights (changing DNS), the Panel asks inline, at that moment — sudo or UAC — because it is an operator asking; it never queues the act into the converge's privileged batch (decision of 2026-08-15).

_Avoid_: applet, widget, control center (Omarchy's Quickshell vocabulary — a red-dev Panel is a TUI, not a bar plugin)

## Emoji picker

A red-dev terminal surface that searches emoji and puts one on the clipboard through the same three-route clipboard the terminal layer already uses — identical on every target, opened by a semantic action. Keyboard compose sequences (Omarchy's CapsLock `m s` → 😄) are out of scope: they exist only on Linux (decision of 2026-08-15).

## Web app

A page in its own window, with its own icon and alt-tab entry, installed and removed from the catalogue like any optional item; desktop sessions only, because it needs a menu (Linux `.desktop`) or a shortcut (Windows `--app`) to live in. Three are recommended and pre-ticked — ChatGPT, Claude, GitHub — the rest (Google Photos, Google Contacts, Tailscale, custom URLs) stay in the catalogue (decision of 2026-08-15).

_Avoid_: PWA (a browser feature red-dev does not rely on), web2app (the retired shell function)

## Relationships

- A **Semantic action** has at most one default **Chord**, identical on every target; a platform adapter may leave it unbound when the host cannot honour it, and says so.
- A **Panel** is opened by a **Semantic action** and reached from the `red-dev` menu as well; so is the **Emoji picker**.
- A **Web app** is a catalogue item, and may be given a chord by the person — never by default.
- Universal clipboard (Omarchy's terminal-aware `Super+C/V/X`) is **out of scope**: the terminal layer already unifies copy/paste on every target and Windows makes `Ctrl+C/V` universal by itself (decision of 2026-08-15).

## Example dialogue

> **Dev:** "On GNOME I'd bind the network **Panel** to `Super+Ctrl+W` like Omarchy."
> **Maintainer:** "No — the **Chord** is `Ctrl+Alt+…` on GNOME *and* on Windows, or it isn't a chord we ship. If GNOME can't register it, the adapter reports it unbound; it doesn't invent a local one."
