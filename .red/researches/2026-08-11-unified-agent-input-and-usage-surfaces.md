# Unified Agent Input and Usage Surfaces

**Date:** 2026-08-11

**Query:** What should red-dev adapt from Omakub, Omarchy and the current
37signals agent work so Claude Code, Codex and OpenCode feel like one
workstation, and how should GitHub rate-limit state appear on Redwall?

**Scope:** Current official Omakub, Omarchy Quattro, house-skills, Claude Code,
OpenCode, Codex CLI and GitHub API sources. The earlier broad product audits in
this directory remain the baseline; this note is deliberately limited to input
gestures and cached operational status.

## Executive Summary

red-dev already has most of the hard newline path: Alacritty and Windows
Terminal emit CSI-u for Shift+Enter, Readline understands it, and Claude Code is
configured to bind it to `chat:newline`. Omakub adds nothing in this area.
Omarchy independently converged on the same CSI-u sequence and, in Quattro,
also enables tmux extended keys and passthrough.

The remaining product opportunity is to make the behavior an explicit
cross-agent contract rather than a collection of incidental settings:

1. **Shift+Enter inserts a newline** in Claude Code, Codex and OpenCode.
2. **Alt+V offers image paste** wherever the agent supports clipboard images;
   Ctrl+Shift+V remains terminal text paste. Plain Shift+V cannot be used: it is
   the ordinary uppercase `V` input and stealing it would break typing.
3. red-dev converges both the terminal and configurable CLI layers, preserves
   conflicting user bindings, and diagnoses the complete key path.
4. Provider/API collectors write small atomic snapshots on a restrained TTL;
   visual surfaces only read snapshots and never launch provider processes.
5. GitHub must show separate `api` and `gql` percentages. GitHub documents them
   as separate resources, and this audit observed GraphQL at 0% while core REST
   remained above 95%; a single percentage would have hidden the failure.

## Official Sources

- [Omakub](https://github.com/basecamp/omakub/tree/c873902f1a5d8b0f54e2e52d565a77274a5941ff), pinned at `c873902f1a5d8b0f54e2e52d565a77274a5941ff`.
- [Omarchy Quattro](https://github.com/basecamp/omarchy/tree/08204846ef6c2e2de8eba873d5888749e1d46ba5), pinned at `08204846ef6c2e2de8eba873d5888749e1d46ba5`.
- [house-skills](https://github.com/basecamp/house-skills/tree/29d5989d565f77c3a1feed535da993a677280f10), pinned at `29d5989d565f77c3a1feed535da993a677280f10`.
- [DHH: Promoting AI agents](https://world.hey.com/dhh/promoting-ai-agents-3ee04945).
- [Claude Code terminal configuration](https://code.claude.com/docs/en/terminal-config).
- [Claude Code keybindings](https://code.claude.com/docs/en/keybindings).
- [OpenCode keybindings](https://dev.opencode.ai/docs/keybinds).
- [OpenCode configuration](https://opencode.ai/docs/config/).
- [GitHub rate-limit endpoint](https://docs.github.com/en/rest/rate-limit/rate-limit).
- [GitHub REST rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
- [Codex documentation](https://developers.openai.com/codex/).

## Hotlinks

- [Omarchy Alacritty configuration](https://github.com/basecamp/omarchy/blob/08204846ef6c2e2de8eba873d5888749e1d46ba5/config/alacritty/alacritty.toml)
- [Omarchy tmux configuration](https://github.com/basecamp/omarchy/blob/08204846ef6c2e2de8eba873d5888749e1d46ba5/config/tmux/tmux.conf)
- [Omarchy agent usage contract](https://github.com/basecamp/omarchy/blob/08204846ef6c2e2de8eba873d5888749e1d46ba5/shell/plugins/agents/README.md)
- [Omarchy usage updater](https://github.com/basecamp/omarchy/blob/08204846ef6c2e2de8eba873d5888749e1d46ba5/bin/omarchy-agent-usage-update)
- [Omarchy Codex collector](https://github.com/basecamp/omarchy/blob/08204846ef6c2e2de8eba873d5888749e1d46ba5/bin/omarchy-agent-usage-codex)
- [Omarchy Claude collector](https://github.com/basecamp/omarchy/blob/08204846ef6c2e2de8eba873d5888749e1d46ba5/bin/omarchy-agent-usage-claude)
- [Local Shift+Enter contract](../../src/shift-enter.test.ts)
- [Local Alacritty bindings](../../src/alacritty.ts)
- [Local Windows Terminal convergence](../../src/wsl.ts)
- [Local Claude keybindings convergence](../../src/claude-keybindings.ts)
- [Local OpenCode convergence](../../src/terminal-surfaces.ts)
- [Local Redwall state](../../src/redwall.ts)

## Key Findings

### Omakub

The current Omakub Alacritty shared configuration binds F11 but does not
normalize Shift+Enter or agent image paste. Its Readline configuration also
does not carry the CSI-u newline mapping. red-dev is already ahead here.

### Omarchy

The current Quattro Alacritty configuration maps Shift+Return to
`ESC[13;2u`, the same sequence red-dev emits. Its tmux configuration enables
`allow-passthrough`, extended keys and CSI-u formatting. This validates the
two-layer terminal design: the emulator must preserve the modifier and the
multiplexer must forward it.

Quattro's agent usage panel is more strategically useful than its individual
bindings. Provider collectors own authentication, parsing and expensive scans;
they write one JSON record each under user state. The QML panel watches those
records. Its normal refresh is 900 seconds, updates are single-flight, and
retry-advised providers get a bounded 30-second retry. The interface therefore
does not know provider formats.

The pattern should be adapted, not copied mechanically. Omarchy's Codex
collector starts the Codex app-server to read account limits. Given red-dev's
process-explosion incident, no Redwall repaint may start an app-server or
unbounded worker tree. Collectors need deadlines, cross-process locks and
stale-cache fallback.

### house-skills and DHH's agent direction

house-skills is about portable agent working practices and progressive
disclosure, not terminal input normalization. Its useful lesson is contract
ownership: the invariant should be stated once, installed through host
adapters, and verified. DHH's published direction emphasizes autonomous
terminal agents under human supervision and names OpenCode as the interface
being promoted in Omarchy. That makes a harness-neutral input contract a
better red-dev boundary than special-casing one favored CLI.

### Claude Code

Claude Code documents Ctrl+J as the universal newline fallback and Shift+Enter
as terminal-dependent. It documents the exact tmux settings needed to preserve
extended keys. Its configurable `chat:newline` action defaults to Ctrl+J and
its `chat:imagePaste` action defaults to Ctrl+V, with Alt+V on Windows and WSL.
red-dev already writes Shift+Enter to `chat:newline`; it should keep Alt+V as
the cross-platform image gesture and leave Ctrl+Shift+V to the terminal.

### OpenCode

OpenCode already defaults `input_newline` to Shift+Return, Ctrl+Return,
Alt+Return and Ctrl+J. Its documented `input_paste` is Ctrl+V and can be
represented as an object with `preventDefault: false`. red-dev should converge
these two keys explicitly in `tui.json`, preserving unrelated keys and refusing
to overwrite a conflicting user choice. This makes the workstation contract
auditable even if upstream defaults later change.

### Codex

The installed Codex CLI is 0.147.0 and accepts images for an initial prompt via
`--image`. The current official Codex documentation does not publish a
user-configurable TUI keybinding schema equivalent to Claude Code or OpenCode.
Consequently red-dev can guarantee delivery of terminal key sequences to Codex,
but must not claim a configurable in-CLI image binding that the official
surface does not expose. This is an explicit documentation/API gap.

### GitHub

GitHub's `/rate_limit` response categorizes limits by resource. `core` covers
ordinary REST calls, `graphql` is separate, and search resources have their own
budgets. The endpoint does not consume the primary REST budget, although
GitHub warns it may count toward secondary limits and recommends using response
headers when possible.

For Redwall, the useful compact contract is therefore:

```text
github api 95% · gql 0%
```

Percentages mean `remaining / limit`, rounded down and clamped to 0–100. The
snapshot retains reset timestamps even though the compact card does not draw
them, so a richer status surface can later explain when a depleted bucket
returns.

## API, CLI and Configuration Details

| Layer | Newline contract | Image/paste contract | Ownership |
|---|---|---|---|
| Alacritty | Shift+Enter → `ESC[13;2u` | Alt+V → Ctrl+V; Ctrl+Shift+V → text paste | generated `keys.toml` |
| Windows Terminal | Shift+Enter → `ESC[13;2u` | Alt+V → Ctrl+V; preserve conflicts | merged `settings.json` |
| Readline | CSI-u/xterm forms insert LF | ordinary shell behavior | generated inputrc |
| Zellij | forward keys in locked mode | OSC 52/text clipboard remains separate | installed config |
| Claude Code | Shift+Enter → `chat:newline` | Alt+V/Ctrl+V → `chat:imagePaste` upstream | merged keybindings JSON |
| OpenCode | explicit `input_newline` | explicit raw `input_paste` | merged `tui.json` |
| Codex | terminal sequence delivered | upstream/native behavior only | no supported keymap file found |

GitHub snapshot rules:

- stored in red-dev's machine-local state, never the shared configuration root;
- 15-minute normal TTL;
- one exclusive lock across concurrent Redwall hooks;
- a short absolute deadline around `gh api rate_limit`;
- atomic replacement after a fully parsed response;
- stale valid data is preferable to no data when refresh fails;
- no retry loop inside a wallpaper generation.

## Version Notes

- Omakub was audited at its current `master` commit dated 2026-03-07.
- Omarchy was audited on the unreleased/current `quattro` branch at the pinned
  2026-08-11 commit. Its agent panel is not represented here as a stable
  Omarchy 3.x feature.
- house-skills was audited at its current 2026-08-11 commit.
- Claude Code and OpenCode documentation was read on 2026-08-11.
- Local Codex observations apply to CLI 0.147.0; absence of an official
  keybinding contract must be rechecked before adding Codex-specific config.

## Gotchas

- Shift+V is not a distinct terminal gesture from typing uppercase V.
- A correct Claude keybindings file cannot repair a terminal that emits plain
  carriage return for both Enter variants.
- A multiplexer can erase or swallow the modifier even when the outer terminal
  is correct.
- Clipboard image support is an agent capability, not something a terminal can
  manufacture. The terminal can only avoid consuming the key.
- A single GitHub percentage is incorrect because REST, GraphQL and search
  resources deplete independently.
- A live provider query in a renderer recreates the exact lifecycle pressure
  this project is trying to eliminate.

## Open Questions

1. Codex needs an official, stable TUI keybinding contract before red-dev should
   write Codex-specific input configuration.
2. A future richer status panel may want reset times and GitHub search budget;
   the wallpaper should remain limited to REST and GraphQL.
3. A physical-key acceptance test still requires a real terminal session. The
   generated-config tests catch drift, but cannot prove which bytes a user's
   currently focused emulator sends.

## Source-by-Source Notes

- Omakub confirms that broad workstation polish does not automatically solve
  terminal protocol details.
- Omarchy confirms CSI-u and demonstrates a clean collector/display boundary,
  a long default refresh, provider isolation and atomic records.
- house-skills reinforces portable contracts and agent-readable documentation.
- Claude Code provides the clearest formal action names for newline and image
  paste, plus the terminal/multiplexer compatibility matrix.
- OpenCode exposes a mergeable TUI keymap with the desired newline defaults.
- Current official Codex docs expose image attachment but no comparable TUI
  keymap contract.
- GitHub documents why API and GraphQL must be displayed independently.

## Recommended Next Steps

1. Converge OpenCode `tui.json` for newline and raw paste without replacing
   unrelated or conflicting bindings.
2. Add Alt+V passthrough to Windows Terminal, matching Alacritty and Claude's
   documented Windows/WSL convention.
3. Add a bounded, locked, TTL-cached GitHub collector and render API/GQL
   remaining percentages on Redwall.
4. Extend the keyboard regression suite across terminal and CLI artifacts.
5. Add an interactive `red-dev keys` probe later so a user can press a key and
   see the exact bytes delivered through their current terminal stack.
