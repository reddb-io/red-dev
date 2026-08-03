# 0001 — red-dev stays cross-platform and absorbs Omarchy/Omakub in phases, via contracts and adapters

- Status: accepted
- Date: 2026-08-03
- Sources: `.red/researches/2026-08-03-omarchy-deep-dive-and-red-dev-opportunities.md`, `.red/researches/2026-08-03-red-dev-vs-omakub-gap-analysis.md`, `.red/researches/2026-08-03-red-dev-vs-omakub-gap-analysis-2.md`

## Context

Three studies compared red-dev with Omakub, Omarchy, and the 37signals ecosystem. Each proposed a different, mutually incompatible prioritization philosophy as the starting point:

- **Doc 1 (Omarchy):** contracts-first — a semantic action registry, an atomic theme contract, and graphical E2E as the foundation (P0) before any feature work.
- **Doc 2 (Omakub v1):** honesty/profile-first — self-update, macOS fail-closed, and the `reddb-employee` Day-One profile as the product goal.
- **Doc 3 (Omakub v2, correcting Doc 2):** defects-first — 8+ concrete defects found (7 broken Neovim theme adapters, Rose Pine forced to dark, preferences not hydrated into `ApplyContext`, stale red-ui Windows provider, fonts not installed outside WSL, missing implicit dependencies) make any new promise dishonest while they exist.

There was also the implicit temptation to follow Omarchy's path (become an opinionated Linux distribution/environment) or to port Omakub's scripts directly.

## Decision

red-dev **stays cross-platform** (Linux, Windows/WSL, and eventually macOS) and absorbs Omarchy/Omakub ideas **via semantic contracts + per-platform adapters + profiles**, never becoming a distro nor porting ad-hoc scripts. All three philosophies from the studies are adopted, **phased** in this order:

1. **Phase 1 — Defects:** only Doc 3's mechanical correctness fixes (Neovim themes, explicit light/dark, preference hydration, fonts on Ubuntu/native Windows, `wl-clipboard`, red-ui Windows, macOS fail-closed, dead code). Atomic self-update + SHA256 verification of bootstraps move to a dedicated update/security track.
2. **Phase 2 — Profile:** profile mechanism + **only** `reddb-employee`, with required/recommended/experimental tiers and a readiness report born as `doctor --json`. Wires all 6 agent hosts (Claude, Codex, OpenCode, Gemini, Pi, Hermes — the latter assumes upstream delivery in RedSkills). The agent-accessibility contract for the other RedDB products is a separate program, outside this phasing.
3. **Phase 3 — Desktop parity:** the Omakub layer (Chrome as default browser, adoptable editor starter, GNOME extensions, web apps, screenshots), covering Linux and Windows together. The semantic action schema is **pulled forward** into this phase and is born with two adapters — GNOME and PowerToys/FancyZones — to prove portability. No databases module: RedDB (`red`) + Docker suffice.
4. **Phase 4 — Contracts:** the remaining contracts (atomic per-surface theme contract, lifecycle/transactions, asset provenance, full command registry).
5. **Phase 5 — macOS:** Darwin is born as an adapter of the Phase 4 contracts, never as a third ad-hoc implementation.

Cross-cutting: MCP is **optional-with-fallback**: every required capability has a stable CLI path.

**Amendment (2026-08-03):** the incremental clean-machine E2E fleet originally decided here was dropped by maintainer decision before any lane was built (#17, #18 closed as not planned). red-dev is a development environment for developers; validation happens by provisioning real environments — converge followed by a second converge with zero planned changes, plus the readiness report — not by CI-hosted clean-VM lanes. A phase closes when its promised behaviors are true on real environments and covered by the unit/integration suite.

## Consequences

- No contract is designed in the abstract: the profile and the desktop act as forcing functions, except the action schema (deliberately pulled forward to avoid rewriting GNOME hotkeys in Phase 4).
- Phase 2 is coupled to one upstream RedSkills release (Hermes) — accepted consciously, and limited to that single external dependency.
- Visible product value lands before the full architecture; the cost is potential rework on Phase 3 surfaces not covered by the action schema.
- Study items explicitly **not adopted**: the Omakub-style databases module, DHH personal taste in the neutral core, and everything on Doc 1's "do not copy" list (permission-bypass defaults, unsigned channels, etc.).
