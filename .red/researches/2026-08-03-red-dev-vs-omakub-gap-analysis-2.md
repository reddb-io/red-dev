# red-dev vs. Omakub — in-depth technical audit

Date: 2026-08-03

Query: Deep dive into red-dev and Omakub, compare everything each product installs and configures, cover programs, assets, themes, fonts, hotkeys, tiling, agents, RedDB tools and upgrades, and find gaps and opportunities for red-dev to deliver a superior workstation experience on Linux, WSL, Windows and macOS.

Scope: red-dev code and assets in commit `e7757978783fc96ec8871e5efdeddc93ee8adc06`; Omakub code and assets in commit `c873902f1a5d8b0f54e2e52d565a77274a5941ff`; official releases effective on 2026-08-03; complete inventories of manifests and scripts; behavior by platform; installation, configuration and upgrade experience. No destructive installations were performed on clean machines. When code and documentation diverged, the committed code was treated as product behavior and the divergence was recorded.

## Executive Summary

red-dev is already an architectural evolution of Omakub, but it is not yet a complete evolution of the Omakub experience.

It has a better foundation for a cross-platform enterprise product: typed manifest with 56 items, explicit providers, compiled binaries, re-executable convergence, isolated failures per item, `plan`, `doctor`, ledgered migrations, WSL/Windows shared configuration, stable/next channels, RedDB tools and agent onboarding. Omakub is narrower: Ubuntu GNOME x86, Git checkout, and imperative Bash scripts.

However, Omakub still wins handily in terms of what the user sees and feels on the first day:

- installs a complete desktop workstation, not just development tools;
- installs and configures Chrome, VS Code, LazyVim, launcher, screenshots, communication, office and utilities;
- delivers window tiling via GNOME/Tactile and terminal tiling via Zellij;
- configures six workspaces, dock, app grid, extensions and dozens of useful shortcuts;
- has ten complete theme bundles, each with Alacritty, Zellij, btop, Neovim, VS Code, GNOME, TopHat and wallpaper;
- includes ten wallpapers and nine application icons at checkout;
- offers Docker databases and languages during the first run;
- updates the product itself and performs migrations.

red-dev has ten themes and reaches more CLI surfaces, but the audit found relevant defects:

1. Seven themes do not install the corresponding Neovim plugin; some also use the wrong colorscheme name.
2. Rose Pine is a light palette, but GNOME and Windows are forced to dark mode.
3. Osaka Jade does not have VS Code integration; Omakub uses Ocean Green as an explicit approximation.
4. Only three of the ten wallpapers generated are versioned, despite the comments saying that they are all versioned.
5. `fzfColors()` exists but is not connected to any configuration.
6. On native Windows, the theme branch ignores Zellij, btop, bat, delta, lazygit, OpenCode and Herdr.
7. The chosen font is not installed on Ubuntu desktop or native Windows.
8. Changing the theme or converging again may return the font to FiraCode and size 11 because persisted preferences do not feed `ApplyContext`.

There are also catalog and asset gaps that change the priority of the roadmap:

- red-ui already publishes Windows x64 and macOS Intel/ARM, but the manifest still states that there is no Windows build;
- all main RedDB tools already have macOS assets; `red`, `tq` and `dit` also have Linux ARM;
- RedSkills v2 already supports Pi, but red-dev does not install Pi and its `doctor` only recognizes Claude, Codex and OpenCode;
- RedSkills v3 adds Gemini, while red-dev keeps calling the v2 installer;
- Hermes is not yet an official RedSkills host, although it supports external skills and MCP natively;
- macOS is recognized as `darwin`, but it falls under the Ubuntu 24 provider and has no bootstrap or release asset.

The recommended order is:

1. fix false promises and theme/font/provider defects;
2. complete a verifiable `reddb-employee` profile;
3. deliver Linux desktop at Omakub's level of finish;
4. add macOS as a real platform, taking advantage of Homebrew and existing RedDB assets;
5. transform hotkeys, themes, fonts, apps and agents into declarative contracts with E2E testing.

## Official Sources

### red-dev

- [README in the audited commit](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/README.md) — product promise, stated commands and limitations.
- [Complete manifest](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/manifest.ts) — source of truth for the 56 items and their providers.
- [Platforms and capabilities](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/platform.ts) — detection of Linux, Windows, Darwin, WSL and desktop/server.
- [RedSkills agents and integration](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/agents.ts) — recognized catalog, installers and hosts.
- [Theme Palettes](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/themes.ts) — ten ANSI themes and palettes.
- [Applying themes](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/theme-apply.ts) — surfaces and differences by platform.
- [VS Code and GNOME Themes](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/theme-editors.ts) — extensions, labels, accents and merge policy.
- [CLI themes and agents](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/theme-cli.ts) — bat, delta, lazygit, OpenCode, Herdr and unconnected fzf function.
- [Wallpapers](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/wallpaper.ts) — 2560×1440 generation and GNOME/Windows application.
- [Fonts and Windows Terminal](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/wsl.ts) — Nerd Font families, Windows registry and terminal config.
- [Hotkeys Windows](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/hotkeys.ts) — two global shortcuts.
- [Config Zellij](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/config/zellij/config.kdl) — key table, session and clipboard.
- [Web apps](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/webapps.ts) — Existing catalog but not routed in CLI.
- [Providers and updates](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/providers.ts) — downloads, unpack, apt/winget and system upgrade.
- [Release pipeline](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/.github/workflows/release.yml) — Linux/Windows x64, checksums and attestations.
- [Release v0.17.1](https://github.com/reddb-io/red-dev/releases/tag/v0.17.1) — last stable at the time of the search.

### Omakub

- [Official repository](https://github.com/basecamp/omakub) — primary source of the product.
- [README in the audited commit](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/README.md) — Ubuntu scope and installation.
- [Bootstrap](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/boot.sh) — checkout clone and ref selection.
- [Main installer](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install.sh) — terminal/desktop flow and `set -e` policy.
- [Terminal programs](https://github.com/basecamp/omakub/tree/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install/terminal) — libraries, CLIs, runtimes and databases.
- [Desktop programs](https://github.com/basecamp/omakub/tree/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install/desktop) — apps, optional apps and GNOME configuration.
- [Hotkeys GNOME](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install/desktop/set-gnome-hotkeys.sh) — bindings for workspaces, apps, launcher and utilities.
- [GNOME and Tactile Extensions](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install/desktop/set-gnome-extensions.sh) — seven extensions and tiling layout.
- [Dock](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install/desktop/set-dock.sh) — curated favorites.
- [Theme Bundles](https://github.com/basecamp/omakub/tree/c873902f1a5d8b0f54e2e52d565a77274a5941ff/themes) — ten themes with eight assets each.
- [Theme change](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/bin/omakub-sub/theme.sh) — coordinated application of surfaces.
- [Fonts](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/bin/omakub-sub/font.sh) — four families and GNOME/Alacritty/VS Code integration.
- [Update](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/bin/omakub-sub/update.sh) and [migration](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/bin/omakub-sub/migrate.sh) — Git self-update and migrations.
- [hotkey manual](https://learn.omacom.io/1/read/29/hotkeys) — reference for official use.
- [tiling manual](https://learn.omacom.io/1/read/39/tiling) — window and Tactile model.
- [Theme manual](https://learn.omacom.io/1/read/6/themes) — experience intention; contains outdated inventory.
- [Font manual](https://learn.omacom.io/1/read/16/fonts) — families and size behavior.
- [Update manual](https://learn.omacom.io/1/read/32/updating) — flow expected by the user.
- [Release v1.5.0](https://github.com/basecamp/omakub/releases/tag/v1.5.0) — last stable at the time of the search.

### 37signals/DHH Agent Initiative

- [house-skills in the audited commit](https://github.com/basecamp/house-skills/tree/d2d85abe034b0e6d4bfc3dbef646c427b05a385f) — opinionated set of practices, skills and internal plugins from 37signals.
- [house-skills README](https://github.com/basecamp/house-skills/blob/d2d85abe034b0e6d4bfc3dbef646c427b05a385f/README.md) — distribution channels and public catalogue.
- [Skill agents-md](https://github.com/basecamp/house-skills/blob/d2d85abe034b0e6d4bfc3dbef646c427b05a385f/plugins/ai/skills/agents-md/SKILL.md) — policy for always-on context, auditing and progressive disclosure.
- [Skill skill-crafting](https://github.com/basecamp/house-skills/blob/d2d85abe034b0e6d4bfc3dbef646c427b05a385f/plugins/ai/skills/skill-crafting/references/guide.md) — co-development flywheel, exemplars and evals.
- [Ralph–Lisa loop](https://github.com/basecamp/house-skills/blob/d2d85abe034b0e6d4bfc3dbef646c427b05a385f/plugins/dev/skills/ralph-lisa-loop/references/guide.md) — loop planner/implementer/self-review/Codex, rope length and close gate.
- [Repository trust boundaries](https://github.com/basecamp/house-skills/blob/d2d85abe034b0e6d4bfc3dbef646c427b05a385f/AGENTS.md) — external output is evidence, not executable instruction.
- [basecamp-cli in audited commit](https://github.com/basecamp/basecamp-cli/tree/3e86a0f0f50772eddbe0a607a5fc5c9c3809d7cf) — concrete example of a product made agent-accessible by structured CLI.
- [Basecamp Agent Skill published](https://github.com/basecamp/skills/blob/024f56a8e058c9fecdeea6aef9eb5e02c6f10022/skills/basecamp/SKILL.md) — operational surface generated using the CLI.
- [Install document for agents](https://github.com/basecamp/skills/blob/024f56a8e058c9fecdeea6aef9eb5e02c6f10022/install.md) — unattended installation with goal, completion criteria, and checks.
- [Official 37signals marketplace](https://github.com/basecamp/claude-plugins) — Basecamp, HEY, Fizzy and house-skills plugins.
- [DHH: Promoting AI agents](https://world.hey.com/dhh/promoting-ai-agents-3ee04945) — position on autonomous agents with human supervision and review.
- [DHH: Basecamp becomes agent accessible](https://world.hey.com/dhh/basecamp-becomes-agent-accessible-3ae6b949) — API + CLI + skill strategy, without requiring a specific harness.

### RedSkills, agents, macOS and RedDB assets

- [Current RedSkills in the audited commit](https://github.com/reddb-io/red-skills/tree/0cfe62c5185f0b1c82292de880111087b4266e11) — hosts and installer v3.
- [RedSkills README](https://github.com/reddb-io/red-skills/blob/0cfe62c5185f0b1c82292de880111087b4266e11/README.md) — Claude, Codex, Gemini, OpenCode and Pi.
- [Pi Coding Agent](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) and [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) — official installation and extensibility.
- [Hermes skills](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md) and [Hermes MCP](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md) — external directories and MCP servers.
- [Homebrew formula API](https://formulae.brew.sh/api/formula.json) and [cask API](https://formulae.brew.sh/api/cask.json) — official availability from the macOS catalog.
- Releases: [toon/tq v0.13.0](https://github.com/reddb-io/toon/releases/tag/v0.13.0), [RedDB v1.23.2](https://github.com/reddb-io/reddb/releases/tag/v1.23.2), [red-request v0.65.1](https://github.com/reddb-io/red-request/releases/tag/v0.65.1), [dit v0.3.2](https://github.com/reddb-io/dit/releases/tag/v0.3.2), [red-ui v0.3.2](https://github.com/reddb-io/red-ui/releases/tag/v0.3.2), [RedSkills v3.3.18](https://github.com/reddb-io/red-skills/releases/tag/v3.3.18).

## Hotlinks

- [Local manifest](../../src/manifest.ts)
- [Local themes](../../src/themes.ts)
- [Local theme application](../../src/theme-apply.ts)
- [Local editor/GNOME integrations](../../src/theme-editors.ts)
- [Local hotkeys](../../src/hotkeys.ts)
- [Local Zellij](../../config/zellij/config.kdl)
- [Local agents](../../src/agents.ts)
- [Local runtimes](../../src/runtimes.ts)
- [Local web apps](../../src/webapps.ts)
- [Local preferences](../../src/preferences.ts)
- [Local release workflow](../../.github/workflows/release.yml)

## Methodology and evidence model

This audit did not infer the product from the README alone.

1. The `TOOLS` array was imported and serialized; 56 items were found: 35 `core`, 7 `desktop`, 4 `wsl` and 10 `optional`.
2. `AGENTS`, `OFFERED_RUNTIMES`, `THEMES`, `VSCODE_THEMES`, `WEB_APPS` and `NERD_FONTS` were read directly from the code.
3. All Omakub installation scripts have been enumerated and grouped by autorun, initial choice and later menu.
4. Omakub's ten theme directories were inspected file by file.
5. Hotkeys were derived from `gsettings`, Alacritty, Zellij, Readline and official manual.
6. RedDB release assets were queried from the official GitHub API.
7. macOS availability was consulted in the official Homebrew formula/cask APIs.
8. Functions without a call site were classified as disconnected implementation, not product delivery.
9. `house-skills`, `basecamp-cli` and the published Basecamp skill were cloned, enumerated and read from the current commit; the analysis separates development method, skills distribution and operational access to the product.

Legend used in matrices:

- **default**: occurs in the happy path without the user adding the item;
- **preselected**: appears checked, but can be deselected;
- **optional**: requires deliberate choice;
- **configured**: not just installed; receives integration or baseline;
- **present-only**: the product detects or themes it if it already exists, but does not install it;
- **dead path**: there is code, but there is no command/menu/call site that reaches it.

## Key Findings

The central findings of this audit are:

1. Omakub remains far ahead as a ready workstation: apps, GNOME, tiling, hotkeys, fonts and assets are an integrated experience, not just a list of packages.
2. red-dev has a more general convergence engine and a larger CLI catalog, but there are broken promises on themes, fonts, preferences, web apps, providers and release assets.
3. The ten themes nominally exist in both products, but seven red-dev themes have incorrect Neovim integration; Rose Pine mixes a light palette with forced dark policy.
4. The actual red-dev inventory contains 56 items, but missing implicit dependencies (`wl-clipboard`, browser, FFmpeg, VS Code) prevent parts of the product from working as described.
5. Agent integration is ahead of Omakub in breadth, but red-dev calls it RedSkills v2, doesn't offer Pi, and doesn't verify Gemini/Pi/Hermes end-to-end.
6. The 37signals initiative adds a different benchmark: not just installing agents, but making products and workflows agent-accessible through structured CLIs, portable skills, evals and trust boundaries.
7. To resolve the fragility of MCPs, the most useful lesson from 37signals is CLI-first with optional MCP: JSON, introspection, non-interactive mode, `doctor`, and explicit fallback must exist before the MCP is considered part of the critical path.

## Product scorecard

| Dimension | Omakub | red-dev | Current result |
|---|---|---|---|
| OS Scope | Ubuntu 24.04+ GNOME, x86 | Ubuntu, WSL and Windows x64; Darwin just detected | red-dev on ambition; Omakub on support honesty |
| Distribution | complete Git clone | Linux/Windows compiled binaries, stable/next | red-dev |
| Installation | linear scripts, abort on first error | convergence by item, isolated failure | red-dev |
| Self-update | `git pull` + migrations | absent | Omakub |
| Preview and diagnosis | no structural equivalent | `plan`, `doctor`, drift checks | red-dev |
| Desktop Linux | full GNOME configured | theme/accent/wallpaper, few apps | Omakub |
| Windows/WSL | out of scope | true integration and shared configuration | red-dev |
| macOS | out of scope | out of scope, with dangerous fallback to apt | none; red-dev is obligated by its own promise |
| CLI programs | good Ubuntu baseline | Larger, cross-platform baseline | red-dev |
| Desktop programs | broad workstation | essentially RedDB + terminal | Omakub |
| Editor | VS Code baseline + LazyVim ready | Neovim/VS Code are present-only | Omakub |
| Themes | 10 complete bundles, 8 surfaces | 10 palettes, more CLI surfaces, integration bugs | conceptual tie; Most correct omakub today |
| Fonts | installs and synchronizes GNOME/Alacritty/VS Code | installs only on Windows host via WSL | Omakub |
| Hotkeys | system, apps, workspaces, tiling, terminal, emojis | 2 global Windows shortcuts + terminal/Zellij | Omakub |
| Tiling | windows via Tactile + terminal via Zellij | terminal via Zellij; PowerToys without config | Omakub |
| Languages | 8 choices; Ruby/Node preselected | 8 choices; Node preselected | equivalent, different catalogs |
| Databases | MySQL/Redis preselected, Postgres optional | none | Omakub |
| Agents | is not the focus | 10 entries, 3 preselected | red-dev |
| agentic method | house-skills/basecamp-cli are outside of Omakub, but belong to the same 37signals ecosystem | RedSkills is broader; lacks CLI-first contract and uniform fallback for MCP | distributed advantage; complementary patterns |
| RedDB Tools | not applicable | `red`, `tq`, red-request, dit, red-ui, RedSkills | red-dev |
| Config ownership | often overwrites files | tries to preserve/merge and keeps backups | red-dev |
| Actual validation | mature product in Ubuntu, little automation | lots of unit tests, little E2E per real OS | gap in both, more critical in red-dev |

## Complete red-dev installation inventory

Source: [`src/manifest.ts`](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/manifest.ts).

### Core — 35 items

| Item | Ubuntu/WSL provider or asset | Windows provider or asset | Observation |
|---|---|---|---|
| git | `apt:git` | `winget:Git.Git` | default |
| curl | `apt:curl` | `winget:cURL.cURL` | default |
| unzip | `apt:unzip` | skip, native expansion | default where necessary |
| ripgrep | `apt:ripgrep` | `winget:BurntSushi.ripgrep.MSVC` | comando `rg` |
| fd | `apt:fd-find` | `winget:sharkdp.fd` | normaliza `fdfind`/`fd` |
| bat | `apt:bat` | `winget:sharkdp.bat` | normaliza `batcat`/`bat` |
| eza | `apt:eza` | `winget:eza-community.eza` | aliases `ls`, `lt` |
| zoxide | `apt:zoxide` | `winget:ajeetdsouza.zoxide` | activated in the shell |
| fzf | `apt:fzf` | `winget:junegunn.fzf` | keybindings ativados |
| btop | `apt:btop` | `winget:aristocratos.btop4win` | theme only applied in the non-Windows branch |
| jq | `apt:jq` | `winget:jqlang.jq` | default |
| tq | `reddb-io/toon:tq-linux-x86_64` | `tq-windows-x86_64.exe` | RedDB, bare binary |
| red | `reddb-io/reddb:red-linux-x86_64` | `red-windows-x86_64.exe` | validates signature so as not to confuse it with GNU ed |
| starship | release `starship-x86_64-unknown-linux-gnu.tar.gz` | `winget:Starship.Starship` | main prompt |
| atuin | release `atuin-x86_64-unknown-linux-musl.tar.gz` | `winget:Atuinsh.Atuin` | history/Ctrl-R |
| carapace | release `carapace-bin_*_linux_amd64.deb` | `winget:rsteube.Carapace` | completions |
| direnv | `apt:direnv` | `winget:direnv.direnv` | hook ativado |
| delta | `apt:git-delta` | `winget:dandavison.delta` | configured as Git pager |
| yazi | release `yazi-x86_64-unknown-linux-gnu.zip` | `winget:sxyazi.yazi` | integrated `y` shell function |
| tldr | release `tealdeer-linux-x86_64-musl` | `winget:dbrgn.tealdeer` | cache inicial baixado |
| fastfetch | PPA `zhangsongcui3371/fastfetch` | `winget:Fastfetch-cli.Fastfetch` | PPA not yet validated on Ubuntu 26 |
| gh | official apt repository | `winget:GitHub.cli` | default |
| lazygit | release `lazygit_*_Linux_x86_64.tar.gz` | `winget:JesseDuffield.lazygit` | default |
| lazydocker | release `lazydocker_*_Linux_x86_64.tar.gz` | `winget:JesseDuffield.Lazydocker` | default |
| zellij | release `zellij-x86_64-unknown-linux-musl.tar.gz` | `winget:Zellij.Zellij` | automatic session and terminal tiling |
| mise | official apt repository | `winget:jdx.mise` | runtime owner |
| neovim | PPA `neovim-ppa/unstable` | `winget:Neovim.Neovim` | binary only; without starter config |
| docker | repo apt + CE/CLI/containerd/buildx/compose | `winget:Docker.DockerDesktop` | add group in Linux |
| dotfiles | builtin | builtin | 9 Bash files + Zellij config |
| alacritty-config | builtin | builtin | theme/font/shell/keys and main file |
| runtimes | builtin | builtin | Node LTS default |
| blesh | builtin | builtin | installed, disabled by default |
| shared-root | builtin | builtin | sharable WSL/Windows config |
| hotkeys | builtin, skip out of Windows/WSL | builtin | two global Windows shortcuts |
| red-skills | builtin, instalador RedSkills v2 | builtin | only runs if it finds a known supported host |

### Desktop — 7 items

| Item | Ubuntu desktop | Windows desktop | Observation |
|---|---|---|---|
| gnome-tweaks | `apt:gnome-tweaks` | skip | single GNOME utility installed |
| alacritty | `apt:alacritty` | `winget:Alacritty.Alacritty` | conceptual standard terminal |
| flatpak | `apt:flatpak` | skip | does not add Flathub or GNOME Software plugin |
| red-request | official installer `--no-color` | asset `red-request-windows-x86_64-setup.exe /S` | configured by the vendor |
| red-ui | asset `red-ui_*_amd64.deb` | **skip stale: “there is no Windows build”** | current release already has EXE/MSI Windows |
| dit | official installer `--yes --no-service` | asset `dit-windows-x86_64.exe` | Linux service deliberately disabled |
| wsl-sync | skip in Linux | builtin in Windows | install/synchronize red-dev within the distro |

### WSL — 4 items

| Item | Provider | Entrega |
|---|---|---|
| wsl-interop | builtin | preserves execution of `.exe` when systemd-binfmt clears the registry |
| nerd-font | builtin | installs the font on the Windows host, where the terminal renders |
| alacritty-host | winget through host | install Alacritty Windows from WSL |
| windows-terminal | builtin | writes profile, scheme, font and shell in Windows Terminal |

### Optional — 10 items

In the first run, all available ones are preselected, except those marked “off”.

| Item | Ubuntu | Windows | Selection default |
|---|---|---|---|
| PowerToys | skip | `winget:Microsoft.PowerToys` | preselected on Windows |
| Blender | builtin official release | `winget:BlenderFoundation.Blender` | off, aproximadamente 1.2 GB |
| RedSkills VS Code | build/install builtin | build/install builtin | off |
| RedSkills Herdr | build/install builtin | skip | off |
| just | `apt:just` | `winget:Casey.Just` | preselected |
| duf | `apt:duf` | `winget:muesli.duf` | preselected |
| dust | release `dust-*-x86_64-unknown-linux-musl.tar.gz` | `winget:bootandy.dust` | preselected |
| hyperfine | `apt:hyperfine` | `winget:sharkdp.hyperfine` | preselected |
| glow | release `glow_*_Linux_x86_64.tar.gz` | `winget:charmbracelet.glow` | preselected |
| gitui | release `gitui-linux-x86_64.tar.gz` | `winget:StephanDilly.gitui` | preselected |

### Agents — 10 catalog entries

Source: [`src/agents.ts`](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/agents.ts).

| Agent | Linux/WSL | Windows | First run | RedSkills verificado pelo red-dev |
|---|---|---|---|---|
| Claude Code | `https://claude.ai/install.sh` | `Anthropic.ClaudeCode` | preselected | Yes |
| Codex CLI | npm `@openai/codex` | `OpenAI.Codex` | preselected | Yes |
| OpenCode | official installer | `SST.opencode` | preselected | Yes |
| Gemini CLI | npm `@google/gemini-cli` | npm | optional | no; v3 supports, red-dev calls v2 |
| T3 Code | desktop-only | `T3Tools.T3Code` | optional Windows | not applicable |
| Herdr | `https://herdr.dev/install.sh` | unavailable | optional | plugin RedSkills separado, optional/off |
| OpenClaw | official installer | npm `openclaw` | optional | no |
| Hermes Agent | official installer | npm `hermes-agent` | optional | no |
| Claude Desktop | unavailable in this Linux catalog | `Anthropic.Claude` | optional Windows | not applicable |
| Codex Desktop | unavailable in this Linux catalog | Microsoft Store `9PLM9XGG6VKS` | optional Windows | not applicable |

**Critical absence:** Pi is not in the catalog, although the RedSkills v2 installer called by red-dev itself already knows how to install packages on Pi when the command `pi` exists.

### Runtimes — 8 choices

| Runtime | Version chosen by red-dev | Default |
|---|---|---|
| Node.js | `node@lts` | Yes |
| Bun | `bun@latest` | no |
| Deno | `deno@latest` | no |
| Python | `python@3.13` | no |
| Go | `go@latest` | no |
| Rust | `rust@stable` | no |
| Ruby | `ruby@3.4` | no |
| Java | `java@lts` | no |

All are managed by mise, except Rust, whose internal mise semantics can use rustup. Node enables corepack when possible.

### Web apps — 6 entries, currently a dead path

| Web app | URL | What exists |
|---|---|---|
| ChatGPT | `chatgpt.com` | `.desktop` Linux + icon CDN |
| Claude | `claude.ai` | `.desktop` Linux + icon CDN |
| Google Photos | `photos.google.com` | `.desktop` Linux + icon CDN |
| Google Contacts | `contacts.google.com` | `.desktop` Linux + icon CDN |
| Tailscale | admin web | `.desktop` Linux + icon CDN |
| GitHub | `github.com` | `.desktop` Linux + icon CDN |

The module requires Chrome/Chromium/Brave/Edge, but red-dev does not install any browsers. There is also no reference to `WEB_APPS` outside of `src/webapps.ts`; therefore, no CLI or TUI input allows you to reach this functionality. Windows and macOS do not have adapters.

## Complete Omakub installation inventory

Source: official tree [`install/`](https://github.com/basecamp/omakub/tree/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install).

### Bootstrap and terminal base

The default path does `apt update`, `apt upgrade`, install `curl`, `git`, `unzip`, and then run all scripts in `install/terminal/*.sh`.

#### Development libraries and clients

| Grupo | Pacotes default |
|---|---|
| Build | build-essential, pkg-config, autoconf, bison, clang, rustc, pipx |
| Runtime headers | libssl-dev, libreadline-dev, zlib1g-dev, libyaml-dev, libncurses5-dev, libffi-dev, libgdbm-dev, libjemalloc2 |
| Images/PDF | libvips, imagemagick, libmagickwand-dev, mupdf, mupdf-tools |
| Data clients | redis-tools, sqlite3, libsqlite3-0, libmysqlclient-dev, libpq-dev, postgresql-client, postgresql-client-common |

#### Default terminal tools

| Tool | Provider/asset | Configuration |
|---|---|---|
| fzf | apt | Bash completion/keybindings |
| ripgrep | apt | none |
| bat | apt | alias `batcat` → `bat` |
| eza | apt | aliases `ls`, `lt` |
| zoxide | apt | `cd` aliased to `z` |
| plocate | apt | none |
| apache2-utils | apt | none |
| fd-find | apt | alias `fd` |
| btop | apt | config + Tokyo Night theme |
| fastfetch | PPA | config if absent |
| GitHub CLI | official apt repo | none |
| LazyDocker | latest GitHub tarball | `/usr/local/bin` |
| LazyGit | latest GitHub tarball | config directory |
| Neovim | stable x86_64 tarball | LazyVim starter complete when missing |
| luarocks | apt | LazyVim support |
| tree-sitter-cli | apt | LazyVim support |
| Zellij | latest GitHub tarball | config + Tokyo Night |
| Docker Engine | official repo | daemon config, group, buildx, compose, rootless extras |
| mise | official apt repo | runtime owner |
| gum 0.17.0 | GitHub `.deb` pinado | Omakub UI |

### Default desktop applications

Automatically run when `XDG_CURRENT_DESKTOP` contains GNOME.

| App/capability | Provider | Configuration adicional |
|---|---|---|
| Flatpak | apt | Flathub + GNOME Software plugin |
| Alacritty | apt | complete config, theme/font/size, default terminal |
| Google Chrome | Official `.deb` | default browser |
| Flameshot | apt | Ctrl+Print global |
| GNOME Sushi | apt | Space preview in Files |
| GNOME Tweaks | apt | installed |
| LibreOffice | apt | app grid folder |
| LocalSend | GitHub `.deb` | dock when present |
| Obsidian | GitHub `.deb` | dock when present |
| Pinta | Flatpak | dock when present |
| Signal | official apt repo | dock when present |
| Typora | official apt repo | iA Writer light/dark themes |
| VLC | apt | installed |
| VS Code | repo apt Microsoft | baseline settings + Tokyo Night extension |
| wl-clipboard | apt | clipboard Neovim/Wayland |
| Xournal++ | apt | PDFs/notes |
| Ulauncher | PPA | autostart, dark theme, Super+Space |
| Fonts | Nerd Fonts + iA Writer Mono | fontconfig and GNOME integration |

### First-run preselected options

| Categoria | Preselected | Available but off |
|---|---|---|
| Apps | 1Password, Spotify, Zoom | Dropbox |
| Languages | Ruby on Rails, Node.js | Go, PHP, Python, Elixir, Rust, Java |
| Databases | MySQL 8.4, Redis 7 | PostgreSQL 16 |

The databases are Docker containers with restart `unless-stopped`, bindings only on `127.0.0.1` and simplified local authentication for development.

### Optional apps from the Omakub menu

| Categoria | Apps/capabilities |
|---|---|
| Security/sync | 1Password + CLI, Dropbox, Tailscale |
| Browser/communication | Brave, Discord, Zoom |
| Audio/video | Audacity, OBS Studio, Spotify |
| Imagem | Gimp |
| Desenvolvimento/hardware | ASDControl, Geekbench, Mainline Kernels, Ollama |
| Games/VM | Minecraft, RetroArch, Steam, VirtualBox |
| Editors | Cursor, Doom Emacs, RubyMine, Windsurf, Zed |
| Web apps | ChatGPT, Google Photos, Google Contacts, Tailscale |

There is also a Windows 11/virtio helper accessible through the installers file selector, but it does not appear as the main menu entry.

### Default desktop launchers and web apps

Omakub creates eight `.desktop` of its own during installation:

| Launcher | Destino |
|---|---|
| About | Fastfetch inside Alacritty |
| Activity | btop inside Alacritty |
| Docker | LazyDocker inside Alacritty |
| Neovim | nvim inside Alacritty |
| Omakub | Omakub panel inside Alacritty |
| Basecamp | Chrome app for 37signals Launchpad |
| HEY | Chrome app for HEY |
| WhatsApp | Chrome app for WhatsApp Web |

The four optional web apps use the same `google-chrome --app` pattern, download icons and go into the GNOME "Web Apps" folder.

## Program-by-program gap analysis

### Shared baseline

Both install Git, curl, unzip, ripgrep, fd, bat, eza, zoxide, fzf, btop, fastfetch, GitHub CLI, LazyGit, LazyDocker, Zellij, mise, Neovim and Docker.

### red-dev-only strengths

| Capability | red-dev | Valor |
|---|---|---|
| Structured data | jq + tq | JSON and TOON as baseline |
| RedDB CLI | `red` | internal stack in core |
| Shell UX | Starship, Atuin, Carapace, direnv | prompt, history, completions, env per directory |
| Git UX | delta | pager and `zdiff3` conflicts configured |
| File navigation | yazi | file manager terminal integrado ao cwd |
| Help | tealdeer/tldr | cache inicial preparado |
| Optional CLI | just, duf, dust, hyperfine, glow, gitui | toolbox moderno |
| Cross-platform | winget + WSL bridge | substantial catalog on Windows |

### Omakub-only strengths

| Capability | Omakub | Gap red-dev |
|---|---|---|
| Toolchain native | compilers, headers and image/PDF/database libs | projects may fail to build after "setup complete" |
| Database clients | Redis, SQLite, MySQL and PostgreSQL clients/dev libs | red-dev installs Docker but no client/database profile |
| Browser | Chrome default | red-dev web apps cannot work on a really clean machine |
| Editor baseline | VS Code settings + LazyVim starter | red-dev themes only if it already exists |
| Clipboard Linux | wl-clipboard | red-dev configures Zellij for `wl-copy`, but does not install the command |
| Launcher | Ulauncher | no launcher on red-dev |
| Screenshots | Flameshot + hotkey | no equivalent flow |
| Workstation | office, notes, media, communication, file transfer | incomplete corporate profile |
| GNOME polish | extensions, dock, grid, six workspaces | almost absent |
| Databases | MySQL, Redis, Postgres Docker | absent |

### Concrete dependency mismatches in red-dev

1. Zellij receives `copy_command "wl-copy"` on the Linux desktop, but `wl-clipboard` is not in the manifest.
2. The `webm2mp4` function calls `ffmpeg`, but `ffmpeg` is not installed.
3. Web apps require Chromium-family browser, but none are installed.
4. RedSkills VS Code extension can be offered without VS Code/Codium/Cursor; the code then just skips.
5. VS Code theme integration is also present-only.
6. `red-skills-herdr` requires Herdr, but both are optional and off; there is no dependent selection that marks the plugin when choosing Herdr.

## Themes — complete inventory

### Bundle shape

Each Omakub theme contains exactly eight functional assets:

1. `alacritty.toml`
2. `zellij.kdl`
3. `btop.theme`
4. `neovim.lua`
5. `vscode.sh`
6. `gnome.sh`
7. `tophat.sh`
8. `background.jpg` or `background.png`

red-dev defines each theme as a core palette of 20 colors and a Neovim name. From there, it generates Alacritty, Windows Terminal, Zellij, btop, lazygit, wallpaper and accents. Integrations that do not accept an arbitrary palette use mappings.

red-dev's core model reduces duplication and favors cross-platform adapters. Omakub's explicit bundle, however, forces each theme to prove that all surfaces exist. red-dev today allows a palette to be added without a corresponding Neovim plugin, VS Code extension or versioned wallpaper.

### Theme-by-theme compatibility

| Theme | Omakub GNOME/mode | Omakub Neovim | Omakub VS Code | red-dev Neovim | red-dev VS Code | red-dev wallpaper |
|---|---|---|---|---|---|---|
| Tokyo Night | purple/dark | `tokyonight` | `enkia.tokyo-night` | correct plugin | correct | committed + runtime |
| Catppuccin | magenta/dark | `catppuccin` | `Catppuccin.catppuccin-vsc` | correct plugin | correct | committed + runtime |
| Gruvbox | sage/dark | `ellisonleao/gruvbox.nvim` / `gruvbox` | `jdinhlife.gruvbox` | correct plugin | correct | committed + runtime |
| Everforest | bark/dark | `neanias/everforest-nvim` | `sainnhe.everforest` | **does not install plugins; fallback declares Tokyo Night** | correct | runtime-only |
| Kanagawa | purple/dark | `rebelot/kanagawa.nvim` | `qufiwefefwoyn.kanagawa` | **does not install plugin** | correct | runtime-only |
| Matte Black | orange/dark | `tahayvr/matteblack.nvim` / `matteblack` | `CleanThemes.matte-black-theme` | **uses `matte-black`, different name, and wrong plugin** | correct | runtime-only |
| Nord | blue/dark | `EdenEast/nightfox.nvim` / `nordfox` | `arcticicestudio.nord-visual-studio-code` | **uses `nord` and wrong plugin** | correct | runtime-only |
| Osaka Jade | green/dark | `ribru17/bamboo.nvim` / `bamboo` | Ocean Green approximation | **uses `osaka-jade` and wrong plugin** | **no mapping** | runtime-only |
| Ristretto | grey/dark | `gthelding/monokai-pro.nvim` / filter Ristretto | Monokai Pro Ristretto | **uses `ristretto` and wrong plugin** | correct | runtime-only |
| Rose Pine | red/**light** | `rose-pine-dawn` | Rosé Pine Dawn | **uses `rose-pine`, wrong plugin** | uses Rosé Pine, not Dawn | runtime-only; forced dark system |

"Wrong plugin" means: the file that red-dev generates declares `folke/tokyonight.nvim` as fallback and asks for another colorscheme. If the user has already installed the necessary plugin on their own, it may work; red-dev does not guarantee this. In a new configuration, the integration is not self-contained.

### Surface coverage by platform

| Surface | Omakub Ubuntu | red-dev Ubuntu | red-dev WSL | red-dev Windows |
|---|---|---|---|---|
| Alacritty | 10/10 | 10/10 | host Windows 10/10 | 10/10 |
| Windows Terminal | n/a | n/a | 10/10 | 10/10 |
| Zellij | 10/10 | 10/10 | 10/10 | **not called by the Windows branch** |
| btop | 10/10 | 10/10 | 10/10 | **not called** |
| Neovim | 10/10 self-contained | 3/10 guaranteed | 3/10 guaranteed | 3/10 guaranteed |
| VS Code | 10/10 | 9/10, present-only | 9/10, host-aware | 9/10, present-only |
| GNOME mode/accent | 10/10 + GTK/icon/cursor | 10 applied, Rose incorrect | n/a | n/a |
| Windows dark/accent | n/a | n/a | 10 applied, Rose incorrect | 10 applied, Rose incorrect |
| TopHat | 10/10 | does not install or theme | n/a | n/a |
| Wallpaper | 10 images | 10 generated at runtime | 10 generated on the host | 10 generated |
| bat | no | 10 approaches | 10 approaches | **not called** |
| delta | no | 10 approaches | 10 approaches | **not called** |
| lazygit | no | 10 when config is manageable | same | **not called** |
| OpenCode | no | segue `system` | segue `system` | **not called** |
| Herdr | no | 4 native themes, 6 follow terminal | idem | unavailable |
| fzf | no | color function exists, without call site | idem | idem |

### Theme semantics and correctness gaps

- Omakub changes GTK theme, icon theme, cursor theme, accent, light/dark, TopHat and wallpaper. red-dev on GNOME only changes `color-scheme` and `accent-color`.
- Rose Pine is explicitly light in Omakub. The red-dev background is `#FAF4ED`, also clear, but `applyGnomeTheme()` and `applyWindowsDesktopTheme()` state that all themes are dark and force dark mode.
- Omakub brings Osaka Jade closer in VS Code with Ocean Green. red-dev prefers to jump; this honesty is acceptable, but the coverage needs to appear in the UI as 9/10, not as "theme applied everywhere".
- bat and delta do not receive the exact palette; receive the closest built-in theme. The UI should label this as approximation.
- lazygit receives exact colors, but if the config already exists and does not have the red-dev marker, it is left intact.
- VS Code settings with comments/trailing commas are valid for the editor, but red-dev uses `JSON.parse` and doesn't apply anything. Omakub avoids this because it creates its own baseline, although its `sed` also depends on the key already existing.

## Assets — complete comparison

### Distribution assets

#### red-dev v0.17.1

| Asset | Bytes | Role |
|---|---:|---|
| `red-dev-linux-x64` | 95,537,280 | Linux and WSL x86_64 |
| `red-dev-windows-x64.exe` | 99,427,840 | Windows x86_64 |
| `SHA256SUMS` | 174 | canonical checksums |
| `checksums.txt` | 174 | naming compatibility |

The release workflow also attempts to publish build provenance attestation. Bootstraps, however, do not validate SHA256 or attestation: Linux downloads and moves; Windows only validates the size returned by the API.

#### Omakub v1.5.0

The release does not publish its own binaries or bundles. `boot.sh` removes `~/.local/share/omakub`, clones the full repository and checks out the stable/master ref. Assets travel in Git checkout.

### Static/configuration assets

#### red-dev repository

- 3 PNG wallpapers committed: Tokyo Night, Catppuccin and Gruvbox, all 2560×1440;
- 3 documentation SVGs: hero, stack and themes;
- 9 embedded Bash files: rc, path, init, aliases, functions, prompt, shared, zellij autostart and inputrc;
- 1 base Zellij config with 287 lines;
- 1 hook Castle MCP;
- Alacritty/Windows Terminal/theme/wallpaper settings are generated by code, not static files.

The `generate-wallpapers.ts` script cycles through ten themes, but seven PNGs are unversioned. This contradicts `wallpaper.ts`'s comment and leaves the visual review incomplete. The runtime is still capable of generating all ten.

#### Omakub repository

- 80 theme assets: 10 themes × 8 files;
- 10 photographic/illustrated wallpapers, from 2912×1632 to 6930×3960;
- 9 PNG icons suitable for launchers;
- static configs for Alacritty, btop, fastfetch, inputrc, LazyVim, Typora, Ulauncher, VS Code, XCompose and Zellij;
- 8 own `.desktop` scripts;
- 16 timestamped migrations in the audited commit.

### Wallpaper strategy

| Aspecto | Omakub | red-dev |
|---|---|---|
| Source | image curated by theme | deterministic palette gradient |
| Quantity delivered to the repo | 10 | 3 out of 10 |
| Network dependency when applying | no | no |
| Resolution | variable, mostly high | fixed 2560×1440 |
| Visual identity | strong and distinct | coherent, but more generic |
| Licensing/provenance | not documented by asset | own generation avoids doubt |
| Windows | no | Yes |
| macOS | no | no |

Opportunity: keep generated wallpapers as universal fallback, but allow art-directed assets by theme with license metadata, author, hash, aspect ratios and crop/focal point.

### Current RedDB release assets by platform

| Product | Linux x64 | Linux ARM | Windows | macOS Intel | macOS ARM | Gap in red-dev manifest |
|---|---|---|---|---|---|---|
| tq/toon v0.13.0 | Yes | aarch64 | x64 | Yes | Yes | only Linux/Windows x64 |
| RedDB `red` v1.23.2 | Yes | aarch64 + armv7 | x64 | Yes | Yes | only Linux/Windows x64 |
| red-request v0.65.1 | deb/AppImage | aarch64 | setup x64 | DMG | DMG | no mac; Linux ARM missing |
| dit v0.3.2 | Yes | aarch64 + armv7 | x64 + ARM | Yes | Yes | only Linux/Windows x64 |
| red-ui v0.3.2 | deb/AppImage | aarch64 | EXE + MSI | DMG/universal | DMG/universal | Windows incorrectly marked skip; mac absent |
| RedSkills v3.3.18 | scripts/assets JS | universal | via Bash/Git Bash | via shell | via shell | red-dev calls v2 and only checks 3 hosts |

This changes the viability assessment: most of the RedDB stack is already ready for macOS and ARM. The bottleneck is in red-dev, not in the dependent products.

## Fonts — complete comparison

| Product | Family | Asset Nerd Fonts | Default |
|---|---|---|---|
| Omakub | Caskaydia Mono | CascadiaMono.zip | Yes |
| Omakub | Fira Mono | FiraMono.zip | no |
| Omakub | JetBrains Mono | JetBrainsMono.zip | no |
| Omakub | Meslo | Meslo.zip | no |
| red-dev | FiraCode | FiraCode.zip | Yes |
| red-dev | JetBrains Mono | JetBrainsMono.zip | no |
| red-dev | Hack | Hack.zip | no |
| red-dev | Caskaydia Cove | CascadiaCode.zip | no |

Both offer size 7–14. Omakub starts at 9; red-dev outputs 11 when no size is passed.

### Omakub font behavior

- installs files in `~/.local/share/fonts` and runs `fc-cache`;
- configures GNOME monospace;
- exchange `font.toml` from Alacritty;
- exchange `editor.fontFamily` from VS Code;
- size affects Alacritty and apps inside the terminal, not VS Code.

### red-dev font behavior and defects

- the actual installation implementation calls the Windows font store and is only executed in the WSL scope;
- Ubuntu desktop receives Alacritty pointing to a family that red-dev did not install;
- Native Windows does not run the WSL scope and may also receive a missing family;
- `doctor` checks font only on Windows/WSL and responds to `n/a` on Ubuntu;
- the menu saves `font` and `fontSize`, but `ApplyContext` only contains the invocation defaults;
- `configureAlacritty()` uses size 11 when `fontSize` is not passed;
- changing the theme or running converge/update can overwrite `font.toml` with FiraCode size 11, even if preferences register another choice.

P0: transform source into resource per platform with `install`, `apply`, `verify` and `current`, and make every command read the persisted preference before assembling the plan.

## Hotkeys — complete comparison

### Omakub system/navigation hotkeys

Source: [GNOME code](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install/desktop/set-gnome-hotkeys.sh) and [manual](https://learn.omacom.io/1/read/29/hotkeys).

| Hotkey | Action |
|---|---|
| Super+Space | Ulauncher |
| Super+A | app grid GNOME |
| Super+W | close window |
| Super+Up | maximize |
| Super+Backspace | start resize |
| Shift+F11 | fullscreen with chrome/title |
| Super+1…6 | ir ao workspace 1…6 |
| Shift+Super+1…4 | move window to workspace; documented in the manual, but not explicitly reset by the audited script |
| Alt+1…9 | open/focus app pinned to dock |
| Shift+Alt+1 | new Chrome window |
| Shift+Alt+2 | new Alacritty window |
| Ctrl+Print | Flameshot region capture |
| Shift+AudioPlay | next track |
| Ctrl+F1 | Apple display brightness down |
| Ctrl+F2 | shine up |
| Ctrl+Shift+F2 | maximum brightness |

The manual still shows Super+1…4, but the current code configures six workspaces. This is a documentation discrepancy.

### Omakub window tiling hotkeys

| Hotkey | Action |
|---|---|
| Super+Left | GNOME left half |
| Super+Right | GNOME right half |
| Super+Up | maximize |
| Super+T | overlay Tactile |
| Super+Shift+T | settings Tactile |
| Super+T, W, S | centro vertical |
| Super+T, Q, A | left column |
| Super+T, E, D | right column |
| Super+T, Q, Q | upper left |
| Super+T, A, A | lower left |

Tactile is configured as four columns with weights `1,2,1,0`, two rows `1,1`, and gap 32. The effective visual model has six useful regions.

### red-dev global hotkeys

| Platform | Hotkey | Action |
|---|---|---|
| Windows/WSL host | Ctrl+Alt+T | Alacritty when available; WSL fallback |
| Windows/WSL host | Ctrl+Alt+Shift+T | Elevated PowerShell, with UAC |
| Ubuntu | — | no global hotkey configured |
| macOS | — | no support |

The Windows shortcuts are `.lnk` in the Start Menu and do not require AutoHotkey/PowerToys. It's a neat and small implementation, but it only covers terminal/admin opening.

### Alacritty hotkeys

| Action | Omakub | red-dev |
|---|---|---|
| Fullscreen | F11 | F11 |
| Paste Windows muscle memory | Alacritty defaults | Ctrl+V and Ctrl+Shift+V |
| Copy | defaults | Ctrl+Shift+C |
| New terminal instance | GNOME Shift+Alt+2 | Ctrl+Shift+N inside the terminal |
| Increase font | not customized | Ctrl+= |
| Decrease font | not customized | Ctrl+- |
| Reset font | not customized | Ctrl+0 |

### Zellij terminal tiling

The two projects essentially share the same binding table, in locked mode:

| Hotkey/mode | Action |
|---|---|
| Ctrl+G | unlock and enter normal mode |
| Alt+Arrow or Alt+H/J/K/L | navigate panes/tabs without leaving locked |
| Alt+N | new pane |
| Alt+= / Alt+- | increase/decrease pane |
| Alt+[ / Alt+] | switch swap layout |
| Alt+F | toggle floating panes |
| Ctrl+G, P, R | new pane to the right |
| Ctrl+G, P, D | new pane below |
| Ctrl+G, P, X | close pane |
| Ctrl+G, P, F | toggle fullscreen |
| Ctrl+G, T, N | new tab |
| Ctrl+G, T, R | rename tab |
| Ctrl+G, T, 1…9 | go to tab |
| Ctrl+G, O, D | detach |
| Ctrl+G, O, W | session manager |
| Ctrl+G, S, E | editar scrollback |
| Ctrl+G, R, H/J/K/L | resize direcional |
| Ctrl+Q in unlocked mode | leave Zellij |

red-dev improves the base with:

- Automatic Zellij in any compatible interactive shell, not just Alacritty;
- exclusions for VS Code, JetBrains, Neovim, Emacs and tmux;
- fallback to Bash if Zellij fails;
- session serialization and pane viewport serialization;
- scrollback 50.000;
- clipboard `clip.exe` on WSL/Windows and `wl-copy` on the Linux desktop;
- sharable WSL/Windows configuration.

The problem is one of framing: Zellij solves tiling **within the terminal**. It does not replace tiling of browser windows, editors, Red Request and desktop apps. The manifesto comment uses Zellij as the cross-platform answer to Tactile/FancyZones, but they are different layers.

### Readline, history and text input

Both configure Up/Down as prefix history search, completion case-insensitive, visible completions and better behavior of symlinks/hidden files.

- Omakub delivers Ctrl+R via fzf and an extensive XCompose, including CapsLock shortcuts for emojis.
- red-dev delivers Ctrl+R via Atuin, Carapace completions, autocd/cdspell/globstar/direnv and does not have XCompose/emoji layer.

### Hotkey product gap

red-dev needs a semantic catalog, not three independent files:

```ts
type ActionId =
  | "launcher.open"
  | "terminal.new"
  | "terminal.admin"
  | "window.close"
  | "window.maximize"
  | "window.tile.left"
  | "window.tile.right"
  | "window.tile.grid"
  | "workspace.goto.1"
  | "workspace.move.1"
  | "app.focus.1"
  | "screenshot.region";
```

Each GNOME, Windows and macOS adapter must declare binding, dependency, conflict detection, apply and verify. The cheat sheet must be generated from the same schema.

## Tiling and desktop coherence

### Omakub model

1. GNOME native split/maximize for laptop.
2. Tactile for larger grids.
3. Six fixed workspaces for task isolation.
4. Dock numerado via Alt+1…9.
5. Zellij for crashes/tabs/session inside the terminal.
6. Ulauncher to open any application without visual navigation.

### red-dev model today

1. Zellij is the only truly configured tiling.
2. PowerToys is preselected on Windows, but FancyZones does not receive layout/config/hotkeys.
3. Windows Snap Layouts are at the OS defaults.
4. GNOME does not receive Tactile, workspaces, dock or launcher.
5. macOS does not have an adapter.

### Recommended coherent model

- **Terminal tiling:** Zellij on all platforms.
- **Window tiling:** Tactile or GNOME equivalent; FancyZones/Snap on Windows; an official choice via ADR on macOS.
- **Workspace semantics:** 1–6 with equivalent actions, even if the mechanism varies.
- **Launcher semantics:** Super/Win/Cmd+Space or a conflict-free combination, adapted by platform.
- **Layout presets:** laptop 2-column, ultrawide 3-column, focus, presentation.
- **Generated docs:** a single visual map of hotkeys per platform.

## GNOME and desktop assets

### Omakub GNOME extensions

| Extension | Role | Main configuration |
|---|---|---|
| Tactile | tiling grid | 3 useful columns × 2 rows, gap 32 |
| Just Perfection | shell polish | animation, workspace, popup |
| Blur My Shell | visual | blur in overview/dock |
| Space Bar | workspaces | names and shortcuts |
| Undecorate | remove title bars | window menu |
| TopHat | metrics | colors by theme, network bits |
| Alphabetical App Grid | organization | folders ao final |

Omakub disables Tiling Assistant, AppIndicators, Ubuntu Dock and Desktop Icons NG before installing its layer.

### red-dev GNOME behavior

- install `gnome-tweaks` and Flatpak;
- adjust light/dark and accent in the theme switch;
- aplica wallpaper;
- does not install extensions, launcher, clipboard package, screenshots, dock, app grid or workspace policy;
- does not register GNOME hotkeys;
- README admits absence and lack of validation on real hardware.

### Windows behavior

red-dev is more advanced than Omakub by definition:

- dark mode of apps and system;
- DWM accent and prevalence;
- wallpaper with immediate refresh via `SystemParametersInfo`;
- Windows Terminal theme/font/profile;
- Alacritty with Git Bash or WSL chosen;
- PowerToys available;
- shared config and distro sync.

But the experience is still not an opinionated desktop: there is no FancyZones config, launcher/remapper config, dock/taskbar policy, workspace mapping or equivalent GNOME shortcuts.

## Shell, aliases and functions

### Shared Omakub lineage

Both provide aliases `ls/lsa/lt/lta`, navigation `../...`, `n`, `g`, `d`, `lzg`, `lzd`, `ff`, `compress/decompress` and `webm2mp4` functions, `iso2sd`, `web2app`.

### red-dev additions

- Complete Git aliases: status, diff, staging, commits, switch, branches, secure push, pull rebase, fetch prune, logs, stash, rebase and worktrees;
- `gdm` for diff from merge-base;
- `mkcd`, `fe`, `fcd` and `y` wrapper;
- `winopen` and `winpath` equivalents in WSL/Git Bash;
- PATH preserved/deduplicated, without deleting WSL interop;
- Starship, Atuin, Carapace, direnv and mise activated;
- config sharing for Starship, mise, Zellij, yazi, Atuin, bat and Git include.

### Ownership difference

Omakub moves `~/.bashrc` to backup and replaces it entirely. red-dev backs up, adds a source line, and maintains its own versioned files in `~/.local/share/red-dev`. The red-dev policy is safer for an enterprise tool that will be updated repeatedly.

## Agents and RedSkills readiness

### Current RedSkills host support

| Host | RedSkills v2 called by red-dev | RedSkills v3 current | red-dev installs host | red-dev doctor verifies |
|---|---|---|---|---|
| Claude Code | Yes | Yes | Yes | yes, source GitHub |
| Codex | Yes | Yes | Yes | yes, marketplace wiring |
| OpenCode | Yes | Yes | Yes | yes, manifest file |
| Pi | Yes | Yes | **no** | no |
| Gemini | no | Yes | Yes | no |
| Hermes | no | no | Yes | no |

The first report underestimated Pi: the RedSkills v2 installer already supports Pi packages. The gap is in `AGENTS` and `SKILL_HOSTS`, not in the lack of upstream integration.

### What “ready” must mean

A host is not ready just because the executable responds:

1. installed executable;
2. registered version;
3. RedSkills wired in the correct scope;
4. skills `dev`, `memory`, `brain` visible;
5. MCPs initialize;
6. hooks/plugins/statusline installed when supported;
7. source points to GitHub/updatable channel, not frozen snapshot;
8. smoke command per host passes;
9. Pending authentication is displayed as explicit HITL.

### Hermes path

Hermes allows `skills.external_dirs` and MCPs in configuration. An initial adapter can point to a shared skills directory. This does not automatically equate to full Claude/Codex/OpenCode surfaces; the correct path is to add official support in the RedSkills repository and consume this host adapter in red-dev.

### Agent roadmap

1. add Pi to `AGENTS` with official installer;
2. move red-dev to RedSkills v3;
3. add Pi and Gemini to `SKILL_HOSTS`/doctor;
4. create contract `SkillHostAdapter` with install/wire/verify/update/uninstall;
5. implement Hermes upstream in RedSkills;
6. select Herdr and automatically select/offer the RedSkills Herdr plugin;
7. ensure a single RedSkills version per machine and report skew.

## DHH/37signals agent initiative — deep comparison

### Which repository the request refers to

There are two official initiatives nearby, but with different roles:

| Repository | Role | Distributed Unit |
|---|---|---|
| [`basecamp/house-skills`](https://github.com/basecamp/house-skills) | opinionated method of working with agents | 11 skills in four plugins |
| [`basecamp/basecamp-cli`](https://github.com/basecamp/basecamp-cli) + [`basecamp/skills`](https://github.com/basecamp/skills) | make the Basecamp product operable by agents | Versioned CLI + automatically published skill |

The first is the "super opinionated" repository on how to configure and run agents. The second is the materialization of DHH's public thesis: comprehensive API, machine-friendly CLI and skill that teaches any harness to operate the product.

Commits audited on August 3, 2026:

- `house-skills`: `d2d85abe034b0e6d4bfc3dbef646c427b05a385f`;
- `basecamp-cli`: `3e86a0f0f50772eddbe0a607a5fc5c9c3809d7cf`, release `v0.8.0`;
- `basecamp/skills`: `024f56a8e058c9fecdeea6aef9eb5e02c6f10022`, synchronized from `basecamp-cli v0.8.0`.

### The 37signals stack is three layers, not one

```text
human intent
  -> harness (Claude Code, Codex, OpenCode, Gemini, etc.)
  -> house method (AGENTS.md + house-skills + hooks/evals)
  -> product skill (Basecamp/HEY/Fizzy workflow knowledge)
  -> structured CLI (JSON, introspection, auth, doctor, non-interactive mode)
  -> product API
```

This separation is important. The skill does not implement the API, the MCP is not the required transport and the `AGENTS.md` does not load the entire manual. Each layer has a smaller, verifiable contract.

### house-skills inventory

The repository contains four Claude plugins and a portable unified view in `skills/`:

| Plugin | Audited version | Skills | Function |
|---|---:|---|---|
| `ai` | 1.2.1 | `agents-md`, `install-md`, `skill-crafting` | always-on context, executable documentation and skill creation/evolution |
| `dev` | 1.1.1 | `address-pr-reviews`, `consult-outside-expert`, `ralph-lisa-loop` | review, external consultation and iterative execution |
| `security` | 1.1.1 | `harden-github-actions` | GitHub Actions pinning and hardening with `zizmor` |
| `recap` | 0.1.1 | `basecamp-activity`, `git-activity`, `github-activity`, `recap` | collection in daily atoms and synthesis by period/audience |

Total: 11 skills. The actual files live in `plugins/<plugin>/skills`; `skills/` contains symlinks. This simultaneously meets:

- marketplace nativo Claude via `git-subdir`, incluindo hooks;
- other agents via `npx skills add basecamp/house-skills`, which dereferences flat vision;
- development without duplicating the content of skills.

The `bin/ci` CI validates this topology: every symlink resolves, no manifest improperly declares a `skills` field, and no actual files are created in the flat view.

### The opinionated AGENTS.md model

The `agents-md` skill is based on a correct premise: repository instructions enter every session before the first question, therefore they are the most expensive context. Each line is classified:

| Classe | Teste | Recommended Action |
|---|---|---|
| `OBVIOUS` | derivable from `ls`, `--help` or framework convention | remove |
| `GOTCHA` | repo specific and would cost a lost round | maintain, starting with the symptom |
| `TASTE` | preference not recoverable by code | maintain only when it contradicts the model prior |
| `POINTER` | depth required in some cases | point to canonical file and when to open it |

Outras regras fortes:

- default target of approximately 100 lines/2.5 thousand always-on tokens;
- do not repeat README, help, scripts or global rules already loaded;
- prefer real paths to invented examples;
- keep the ephemeral state of PR, branch, blocker or task out of the file;
- move depth to on-demand skills and path-scoped rules;
- check every command, path, link, literal and contradiction before publishing;
- in an untrusted repository, only do static auditing and reject symlinks/traversal;
- `AGENTS.md` is the portable name; Claude needs `CLAUDE.md`/`.claude/CLAUDE.md` by importing or pointing to it.

This model should influence red-dev. Installing RedSkills is not enough if RedDB projects load duplicate, long, contradictory or unverified instructions.

### Skill-crafting flywheel

`skill-crafting` rejects the idea of writing an entire skill in the abstract. The process is:

```text
problema real
  -> minimum v0
  -> execute on real target
  -> observe repeated failure/decision
  -> atualizar guide/eval/exemplar
  -> execute on another target
  -> repeat until it passes early and with little intervention
```

Artifacts mature through use:

- repeated failure becomes eval;
- repeated decision becomes the rule;
- output bom vira exemplar;
- large explanation leaves `SKILL.md` and goes to `references/`;
- design tradeoff pause for human decision;
- maturity means zero open H/M and two consecutive rounds without new H/M in the described review process.

There is direct overlap with `dev:write-a-skill`, `dev:audit-skills`, and `memory:improve-skills`. The opportunity is not to copy another creation skill: it is to adopt the requirement for real examples and executable evals as a common contract of the RedSkills ecosystem.

### Ralph–Lisa: the strongest and most coupled idea

The Ralph–Lisa loop is the most opinionated element in the repository:

```text
implement
  -> independent self-review
  -> external review by Codex
  -> reconciliation
  -> synthesis
  -> derived close gate
  -> new round or closure
```

Roles:

- Claude as orchestrator;
- planner/implementer subagent;
- read-only self-reviewer subagent;
- Codex as independent external reviewer;
- human as steering authority and binding decisions.

The user chooses a `rope length` from 0 to 5. The number changes only when the loop interrupts the human; does not reduce the quality standard. Even in rope 5, external authorization, scope change, destructive/irreversible action, security/authentication and lack of convergence continue to be mandatory escalations.

The close gate is derived from the records of findings and disputes, not from mutable counters:

```text
close = open_findings == 0
     && open_disputes == 0
     && implementation_complete
     && eval_passed
```

If cache and branch diverge, the gate fails closed. Findings receive IDs, status, evidence and `supersedes` string; three rounds without solving the same chain force human intervention. The log preserves the three most recent rounds and compresses old history after the eighth.

Codex is accessed preferably via MCP, maintaining the thread between rounds. However, the design requires explicit fallback:

1. try MCP;
2. repeat once on error/timeout;
3. use `codex exec` only after opt-in;
4. go to self-review only in that round, register finding M and try to restore MCP in the next one;
5. Never degrade silently.

This is the most relevant pattern for `castle`, `navigator`, and `rsp`: a broken MCP should reduce capacity in a visible and recoverable way, not prevent the entire environment from starting or feign readiness.

### Product accessibility: API + CLI + skill, not MCP-first

The Basecamp CLI shows how 37signals makes a product accessible to agents:

| Capacidade | Contrato exposto |
|---|---|
| output | human in TTY; JSON when pipe; `--json`, `--quiet`, `--agent`, `--md` explicit |
| envelope | `{ok, data, summary, breadcrumbs, meta}` |
| descoberta | every command supports `--help --agent`; complete catalog at `basecamp commands --json` |
| navigation | `breadcrumbs` return valid next commands |
| non-interaction | `--agent` and `BASECAMP_NONINTERACTIVE=1` turn prompts into actionable errors |
| filtro | Built-in `--jq` avoids external dependency/process and operates over the envelope |
| diagnosis | `basecamp doctor --json` includes health, auth, connectivity and Claude/Codex integration |
| authentication | OAuth 2.1, refresh, device flow/fallback and isolated profiles |
| repo security | authority keys in `.basecamp/config.json` are locked until `basecamp config trust` |
| integration | native Claude/Codex plugins; generic skill for any agent that runs shell |

The published skill covers 155 endpoints and records invariants, decision trees, pagination, defaults, errors and workflows. It is automatically synchronized from `basecamp-cli` with each release. This avoids the classic drift in which the binary changes and the skill continues teaching old flags.

`install.md` is also written for agent execution: `OBJECTIVE`, `DONE WHEN`, checklist, steps, verification after each step and a manual section explicitly prohibited without prompting. It is documentation as a verifiable protocol, not a narrative tutorial.

### How this changes the MCP diagnosis

The 37signals model does not prove that MCP is bad. It defines MCP's place better:

- CLI is the universal and debuggable contract;
- skill is progressive disclosure and workflow knowledge;
- plugin adds host-specific ergonomics;
- hook enforces behavior when the host supports it;
- MCP is a highly integrated channel, but must have a CLI equivalent or clear degradation;
- `doctor --json` measures readiness instead of assuming that a process started correctly.

For red-dev, every managed MCP should publish the same state machine:

```text
not_installed
  -> installed
  -> configured
  -> transport_started
  -> initialized
  -> smoke_passed
  -> ready

any failure
  -> degraded(reason, fallback, remediation)
```

`process exists` or `command found` should not mean ready. The error displayed at the beginning of this search — broken pipe during `initialize` — is exactly a failure between `transport_started` and `initialized`.

### Direct comparison with RedSkills

| Dimension | house-skills/37signals | RedSkills/red-dev | Leitura |
|---|---|---|---|
| amplitude | 11 very focused skills | much larger collection: engineering, memory, brain and operation | RedSkills is a broader platform |
| distribution | four Claude plugins + generic Agent Skills | bundles/plugins for five hosts in v3 | RedSkills covers more hosts natively |
| single source | real files per plugin, symlinks for flat view | own bundles per host | both combat duplication, with different mechanisms |
| repo instructions | specific skill, budget and audit of literals/paths | `dev:context` and setup, without the same explicit publishing contract | incorporate `agents-md` principles |
| skill creation | flywheel by real target + exemplars + evals | write/audit/telemetry/improve | unite local evals with RedSkills telemetry |
| autonomous execution | Ralph–Lisa with rope 0–5 and derived close gate | manager/implement/afk/code-review | RedSkills is more operational; Ralph–Lisa has a more formal gate |
| second opinion | Codex fixed as Claude reviewer | flow-dependent multi-agent/review | avoid fixed coupling to vendors |
| product tooling | Structured CLI + release-generated skill | RedDB tools installed, but no uniform CLI agent contract | greater practical opportunity |
| MCP | optional in review, `codex exec` fallback | Core MCPs may fail at startup | adopt fallback and structured readiness |
| trust boundaries | appear in AGENTS and skills that process external input | guardrails exist, but vary by skill | normalize in schema/audit |

### Internal contradictions and limits in the 37signals design

The initiative is strong, but should not be copied without criticism:

1. The `agents-md` reference itself states that `triggers:` is not part of the Agent Skills spec or the Claude documentation; several skills from the same repository still carry extensive lists of `triggers`. This is documentable internal drift.
2. Complete plugins are Claude-first. Other agents receive standalone skills, but do not automatically receive the stop hook or all of the plugin's ergonomics.
3. Ralph–Lisa sets Claude as orchestrator, Codex as reviewer and `xhigh` as policy. It's a good concrete implementation, but not a vendor-neutral protocol.
4. `house-skills` does not publish tags/releases; installing from the main branch reduces reproducibility. The manifests have versions, but the generic consumption is not pinned.
5. The loop generates state in `tmp/ralph-lisa-loop-session.md`; the guide says to delete or ignore, but the repository is unable to impose this on consumers. There is a risk of accidental commit of sensitive content.
6. Untrusted audit mode is safe but operationally rigid: if the target `AGENTS.md` has already influenced the session, the skill requires starting over in neutral cwd.
7. Structural evals detect format and state, do not guarantee semantics. The material itself recognizes that an existing example may fail to exemplify and that an actual flag may be incorrectly described.
8. Basecamp CLI continues to require human authentication and credentials; "autonomous" does not eliminate HITL nor does it justify expanding the scope of access.

### What red-dev should adopt

Adopt:

1. `AGENTS.md` as a minimal, auditable and portable context; CLAUDE explicit bridge.
2. CLI-first for all RedDB capabilities, with `--json`, `--agent`, `--help --agent`, non-interactive and stable exit codes.
3. `doctor --json` with complete readiness states for agents, plugins, hooks and MCPs.
4. Skills generated/tested with the CLI release, not maintained manually at a different pace.
5. `install.md` executable with objective/done-when/checkpoints for red-dev and RedDB products.
6. Close gates derived from real records, failing closed in inconsistency.
7. Mandatory trust boundaries for skills that read issue, PR, web, MCP, chat or output from another model.
8. MCP Fallback → CLI registered, tested and visible in the doctor.
9. Executable evals and real examples as a skill maturity requirement.
10. A simple autonomy level, with invariant mandatory escalations.

Do not take literally:

1. vendor lock Claude-orchestrator/Codex-reviewer;
2. non-portable `triggers:` lists as activation mechanism;
3. mutable `main` branch as default production channel;
4. another parallel collection of skills that doubles RedSkills;
5. MCP as a requirement for a flow whose basic operation fits in CLI;
6. Session logs within the repo without lifecycle and data policy.

### Proposed RedDB agent-accessibility contract

Each RedDB CLI should satisfy the same contract:

```text
<tool> commands --json
<tool> <command> --help --agent
<tool> doctor --json
<tool> auth status --json        # when applicable
<tool> ... --agent              # stable output, no prompt
<tool> ... --dry-run            # for relevant mutations
```

Each host/MCP integration should declare:

```text
install -> configure -> start -> initialize -> smoke -> ready
                                          \-> degraded + fallback + remediation
```

And each release should publish, as a compatible unit:

- binary;
- schema/command catalog;
- Agent Skill;
- plugin adapters;
- checksum/provenance;
- drift tests between commands and skills;
- minimum host/hook/MCP version.

This leverages the best of the DHH initiative without weakening the RedSkills differentiator: a universal layer of engineering, memory, and knowledge on top of truly agent-accessible RedDB tools.

## Update, migration and supply-chain comparison

### Omakub

- `Omakub > Update > Omakub` does `git pull` at checkout;
- compares timestamp of the last previous commit with migration names;
- executes new migrations in order;
- menu offers manual updating of Ollama, LazyGit, LazyDocker, Neovim and Zellij;
- apt/Flatpak packages continue under Ubuntu mechanisms;
- migrations can replace configs and request interaction/logout;
- bootstrap removes previous checkout before cloning again.

### red-dev

- `update` executes `apt full-upgrade/autoremove` or `winget upgrade --all`;
- reexecuta instalador RedSkills;
- the manifesto converges;
- has two font repair migrations with ledger in preferences;
- does not update the binary itself;
- does not maintain binary/config rollback;
- releases have checksums and provenance, but installers do not check checksums;
- `gh` dependency downloads also do not validate published checksums.

### Preference/state bug affecting upgrades

The first run writes theme, font and fontSize. After him:

- `contextFor()` mounts the context from the CLI defaults, not from `readPreferences()`;
- `red-dev update` calls converge with these defaults;
- `red-dev theme <outro>` uses the requested name, but maintains default font/size;
- declared state and applied state can silently diverge.

This needs to be P0 because it makes update potentially regressive for visual preferences.

### Required update contract

```text
resolve channel/version
  -> download platform+arch asset
  -> verify SHA256 + provenance/signature
  -> stage next binary
  -> run preflight
  -> atomically swap
  -> run migrations
  -> converge persisted desired state
  -> doctor/readiness
  -> retain previous binary/config snapshot for rollback
```

## Platform matrix and macOS feasibility

### Actual support today

| Capability | Ubuntu 24 | Ubuntu 26 | WSL | Windows x64 | macOS Intel | macOS ARM |
|---|---|---|---|---|---|---|
| red-dev release binary | Yes | same asset, not validated | Yes | Yes | no | no |
| bootstrap | Yes | yes conceptual | Yes | PowerShell | no | no |
| provider package manager | apt | apt with gaps | apt + winget | winget | **falls in apt/u24** | **falls in apt/u24** |
| desktop integration | partial GNOME | not validated | host Windows | partial | no | no |
| architecture | x64 | x64 | x64 | x64 | — | — |
| E2E clean-machine | partial/manual | no | better exercised | bootstrap not validated clean | no | no |

### macOS is technically tractable

The official Homebrew query found formulas for all these core/optional items: Git, curl, unzip, ripgrep, fd, bat, eza, zoxide, fzf, btop, jq, Starship, Atuin, Carapace, direnv, git-delta, yazi, tealdeer, fastfetch, gh, LazyGit, LazyDocker, Zellij, mise, Neovim, just, duf, dust, hyperfine, glow and gitui.

There are official casks for Alacritty, Docker Desktop, VS Code, Blender and the four Nerd Fonts chosen by red-dev. RedDB tools already offer macOS Intel/ARM assets.

Therefore, macOS does not require inventing stack distribution; requires implementing:

- `Env = "macos"` and own capabilities;
- providers `brew`, `cask`, `gh-dmg`, `gh-binary`, `builtin-macos`;
- release targets Darwin x64/arm64;
- bootstrap universal;
- paths/config/shell;
- installation/registration of DMG apps;
- hotkeys, tiling, launcher, dark/accent/wallpaper;
- tests on Intel and Apple Silicon.

### Immediate safety fix

Before any macOS support, `providerFor()` must reject Darwin. Trying `apt` on macOS is worse than declaring unsupported.

## First-run experience

### Omakub sequence

1. validates Ubuntu/architecture;
2. asks about optional apps;
3. asks about languages;
4. asks about databases;
5. collects Git identification;
6. install terminal;
7. install desktop and customize GNOME;
8. offers reboot.

The user ends up with a strong opinion applied. The cost is that one failure aborts everything and multiple files are overwritten.

### red-dev sequence

1. on Windows/WSL, offers shared config and target shell;
2. preselect Claude/Codex/OpenCode;
3. preselect Node LTS;
4. preselect optional compatible CLI tools;
5. leaves ble.sh off;
6. chooses Nerd Font;
7. choose theme with preview;
8. converge core/desktop/WSL and choices.

The flow is more sophisticated for cross-platform and agents, but the desktop result is smaller. It does not ask for workstation apps, browser, baseline editor, databases, hotkey profile or tiling profile.

### Recommended profiles

| Profile | Content |
|---|---|
| `minimal` | shell, Git, terminal, mise, Node, essential CLI |
| `desktop` | minimal + browser, editor baseline, fonts, themes, hotkeys, tiling, launcher, screenshots, web apps |
| `reddb-employee` | desktop + `red`, `tq`, red-request, dit, red-ui, RedSkills and enterprise agents |
| `ai-heavy` | reddb-employee + extensive set of agents, Ollama and extensions |

Profiles must be persisted intent. Removing an item from your profile is a registered choice, not drift. Personal items remain outside of red-dev's property.

## Critical gaps ranked

### P0 — correctness and honesty

1. Darwin cannot use Ubuntu provider.
2. Persisted theme/font/fontSize need to feed all `plan/install/update/theme`.
3. Fix the seven Neovim adapters and their colorscheme names.
4. Treat Rose Pine as light in GNOME and Windows.
5. Fix red-ui Windows from skip to real asset.
6. Install and check Nerd Font on Ubuntu, Windows and future macOS.
7. Install `wl-clipboard` before configuring `wl-copy`.
8. Connect or remove dead functions: web apps and fzf colors.
9. Show real surface matrix by theme in UI.
10. Implement verified self-update and rollback.

### P0 — RedDB employee readiness

1. Add Pi.
2. Update RedSkills v2 → v3.
3. Check Pi and Gemini at the doctor.
4. Create official RedSkills path to Hermes.
5. Install all available RedDB assets per platform/arch.
6. Add real smoke tests, including MCP startup.
7. Display auth-required separately from failed.

### P1 — desktop parity with Omakub

1. Browser Chromium-family.
2. Secure VS Code baseline and governed LazyVim starter.
3. GNOME extensions, Tactile, launcher, workspaces, dock and app grid.
4. Screenshots and clipboard.
5. Web apps integrated into the CLI/TUI.
6. Selectable Docker databases/services.
7. Workstation catalog in profile, not in core.
8. Own RedDB templates/launchers with icons.

### P1 — cross-platform interaction model

1. Semantic hotkey schema.
2. GNOME adapter.
3. PowerToys/FancyZones adapter and configuration export.
4. macOS tiling/launcher ADR + adapter.
5. Conflict detection and generated cheat sheet.

### P2 — visual system and assets

1. Theme manifest with status exact/approximate/follow-system/unsupported per surface.
2. CI requiring adapter completeness for new theme.
3. Version the ten generated wallpapers.
4. Optional wallpaper metadata and art-directed assets.
5. Font manifest with install/apply/verify per OS.
6. Consistent icons and launchers for red-dev and RedDB products.

## Proposed internal contracts

```ts
interface DesiredProfile {
  id: "minimal" | "desktop" | "reddb-employee" | "ai-heavy";
  tools: string[];
  agents: string[];
  runtimes: string[];
  services: string[];
  theme: string;
  font: { family: string; size: number };
  hotkeyProfile: string;
  tilingProfile: string;
}

interface Installable {
  id: string;
  supports(platform: Platform): Support;
  plan(desired: DesiredState): Promise<PlanStep[]>;
  apply(step: PlanStep): Promise<void>;
  verify(desired: DesiredState): Promise<HealthResult>;
  uninstall?(): Promise<void>;
}

interface ThemeSurface {
  id: string;
  support(theme: Theme, platform: Platform):
    | "exact"
    | "approximate"
    | "follow-system"
    | "unsupported";
  apply(theme: Theme, platform: Platform): Promise<void>;
  verify(theme: Theme, platform: Platform): Promise<HealthResult>;
}

interface SkillHostAdapter {
  id: "claude" | "codex" | "opencode" | "gemini" | "pi" | "hermes";
  install(): Promise<void>;
  wireRedSkills(version: string): Promise<void>;
  verifySkills(): Promise<HealthResult>;
  verifyMcp(): Promise<HealthResult>;
  update(): Promise<void>;
}
```

## Acceptance criteria and E2E matrix

### Per platform

| Target | Required lane |
|---|---|
| Ubuntu 24 desktop x64 | clean VM + GNOME session |
| Ubuntu 26 desktop x64 | clean VM + GNOME session |
| Ubuntu server x64 | headless |
| WSL Ubuntu 24 | Windows host crossing |
| Windows 11 x64 | clean VM, no preinstalled Git/Bun |
| macOS Intel | clean runner/hardware |
| macOS ARM | Apple Silicon runner/hardware |

### Test sequence

1. bootstrap verified by checksum;
2. apply `reddb-employee`;
3. capture plan/result/readiness;
4. run second converge and assert zero unexpected mutations;
5. verify every binary/app/agent/MCP;
6. change all ten themes and inspect declared surfaces;
7. change all fonts and preserve size through theme/update;
8. exercise semantic hotkeys;
9. start selected databases;
10. update N-1 → current;
11. rollback;
12. uninstall selected item without deleting unrelated configuration.

### Agent accessibility and MCP sequence

1. enumerate commands and schemas without performing mutations;
2. run each CLI in `--agent`/non-interactive and validate JSON + exit code;
3. install the skill from the same CLI version and test command/flag drift;
4. check `AGENTS.md`/Claude bridge and budget always-on;
5. exercise MCP until `initialize` and functional smoke, not just process spawn;
6. kill the MCP during an operation and confirm state `degraded` + CLI fallback;
7. restore the MCP and confirm reconnection without reinstalling the environment;
8. inject hostile content via issue/PR/MCP and confirm that it is treated as data, not instruction;
9. verify that remote actions, auth and destructive changes continue to require adequate authority;
10. run N-1 CLI with skill N and vice versa to prove mismatch fails with actionable diagnostics.

### SLOs

- setup completed in up to 30 minutes, excluding human authentication;
- at most one reboot/sign-out;
- second converges without drift;
- 100% of items chosen in `healthy`, `auth-required` or `unsupported-with-reason`;
- no "success" based only on existing file;
- every new theme passes completeness checks;
- N-1 update and rollback proven before stable.

## API / CLI / Config Details

```text
red-dev profile list
red-dev profile show reddb-employee
red-dev profile apply reddb-employee --plan
red-dev self-update --channel stable
red-dev rollback
red-dev theme matrix
red-dev hotkeys list
red-dev hotkeys conflicts
red-dev services
red-dev agents doctor
red-dev agents doctor --json
red-dev mcp doctor --json
red-dev mcp status --json
red-dev tools doctor
red-dev doctor --readiness
red-dev webapps
```

`red-dev update` should continue to be the happy path, orchestrating self-update, migrations, desired profile convergence and readiness.

Config ownership must be explicit:

| Mode | Significado |
|---|---|
| owned | entire generated and updateable file |
| merged | somente chaves declaradas pertencem ao red-dev |
| adopted | existing config was imported after consent |
| external | red-dev apenas verifica/orienta |

## Version Notes

- red-dev checkout declares `0.19.0`; the most recent stable is `v0.17.1`, published on 2026-08-02.
- Audited Omakub master continues at `1.5.0`; the release was published on 2025-11-09.
- The Omakub manual talks about seven themes, but the code has ten.
- The Omakub manual talks about workspaces 1–4, but the code configures 1–6.
- RedSkills latest is `v3.3.18`; red-dev explicitly calls the major tag v2.
- `house-skills` was audited in `d2d85ab` and has no tags/releases; its internal manifests declare `ai 1.2.1`, `dev 1.1.1`, `security 1.1.1`, and `recap 0.1.1`.
- `basecamp-cli v0.8.0` and `basecamp/skills` synchronized from this release were audited on 2026-08-03; the surface changes quickly and needs to be pinned by commit/release on any adoption.
- The RedDB releases consulted are current on the date of the report and may gain new assets; the manifest should consume a contract manifest published by each product, instead of maintaining manual phrases like "there is no Windows build".

## Gotchas

- "Installed" does not mean configured, authenticated or healthy.
- "Theme supports Neovim" does not mean that the colorscheme plugin has been installed.
- "Zellij resolve tiling" is only valid within the terminal.
- A persisted preference that does not feed the next converge is documentation, not desired state.
- Dark/light should be theme property, not global assumption.
- An asset existing in the release does not guarantee silent install; DMG/MSI/NSIS need their own adapters.
- The desktop catalog must be profile-driven so as not to transform the core into an installation weighing tens of GB.
- Do not silently overwrite existing VS Code/Neovim.
- Global hotkeys need conflict detection; a global key can break browser/editor.
- macOS should fail closed until the provider exists.
- Downloads must verify hash/provenance before running.
- Installed plugin does not guarantee equivalence between hosts: hooks and lifecycle Claude may not exist in standalone Agent Skills mode.
- MCP that spawned but failed the handshake is not ready; the granularity needs to reach `initialize` and smoke.
- Extensive `triggers:` are not a portable activation mechanism according to the `agents-md` reference itself; the description remains the interoperable contract.
- Output from another agent or reviewer is unreliable input and should not be executed as an instruction.

## Open Questions

1. Which apps are mandatory for the `reddb-employee` profile?
2. Will Chrome, Brave or Edge be the default browser per platform?
3. Does the enterprise editor baseline include VS Code, Neovim, or both?
4. Will the editorial template be owned or an adoptable starter?
5. Which databases are default for RedDB contributors?
6. Which agents are mandatory, recommended and experimental?
7. Should Hermes receive official integration within RedSkills before entering the profile?
8. Which macOS tool will be default for tiling and launcher?
9. Will macOS use Bash for parity or Zsh for nativeness?
10. Which wallpapers can be distributed with explicit license/source?
11. Will PowerToys be mandatory on Windows or just adapter optional?
12. How will corporate credentials be handled without being stored by red-dev?
13. Which RedDB CLIs will be prioritized for the `--agent`/`doctor --json` contract?
14. Will MCP be mandatory, preferred or optional-with-fallback by capacity?
15. Which compatibility matrix will include CLI, skill, plugin, host and MCP protocol?
16. Will the level of autonomy be global, per profile or per operation?

## Source-by-Source Notes

### red-dev source notes

- `manifest.ts` is a good source of truth, but it still mixes installation, desktop reach and asset assumptions that are stale.
- `themes.ts` centralizes palettes, but the schema does not require light/dark mode, Neovim plugin or adapter coverage.
- `theme-apply.ts` has a Windows branch that unduly reduces surfaces.
- `theme-editors.ts` has good and host-aware VS Code mappings, but does not support JSONC and forces dark in GNOME.
- `theme-cli.ts` improves Omakub in CLI, but `fzfColors()` is dead.
- `preferences.ts` persists correct choices; `main.ts/contextFor()` does not consume them in the next commands.
- `webapps.ts` is a competent implementation without product route.
- `agents.ts` has a wide catalog, but uses RedSkills v2 and maintains doctors for only three hosts.
- `providers.ts` has good asset matching and timeout, but it does not check checksums and does not self-update.
- release pipeline produces checksums/attestation and two x64 targets; bootstraps do not consume the check.

### Omakub source notes

- Omakub maximizes coherence by choosing a single OS/desktop.
- The workstation catalog is much broader and applied automatically.
- Each theme is a complete, self-contained bundle.
- GNOME/hotkeys/tiling/dock forms an interaction model, not a list of tweaks.
- LazyVim and VS Code make the user productive immediately.
- Scripts replace configs and `set -e` aborts the rest; is less resilient than red-dev.
- Self-update and migrations close a cycle that red-dev has not yet closed.

### DHH/37signals agent source notes

- `house-skills` separates physical content by plugin and exposes a flat view by symlink; this inversion exists because the marketplace extracts subdirectories.
- `agents-md` is the most universal contribution: spending always-on context only with verifiable gotchas, counter-priors and pointers.
- `skill-crafting` connects instruction, real target, exemplar and eval; maturity is evidenced by execution, not by length of documentation.
- Ralph–Lisa formalizes autonomy without relaxing the close gate, but is deliberately coupled to Claude + Codex.
- The stop hook prevents termination during an active loop only in the Claude plugin; Standalone skills do not automatically inherit this guarantee.
- Trust boundaries are explicit: PR comments, external content and model output remain untrusted data.
- `basecamp-cli` demonstrates the most concrete agent-accessible architecture: stable JSON, breadcrumbs, introspection, non-interactive, auth profiles, config trust and doctor.
- `basecamp/skills` is synchronized with each CLI release, a standard that RedDB should adopt to avoid drift between binary and skill.
- DHH's public strategy is supervised collaboration: agents produce real contributions, but review, guidance and decisions remain human.
- Manual and code diverged in themes and workspaces, showing the need for generated docs.

### RedSkills source notes

- v2 already supports Claude, Codex, OpenCode and Pi.
- v3 adds Gemini and keeps Pi packages published.
- Hermes does not appear as an official host.
- The current source has release assets for OpenCode, Pi packages, VS Code and Herdr plugin.

### RedDB release notes

- The top five products already publish more coverage than red-dev consumes.
- red-ui Windows is the clearest example of provider stale.
- macOS and ARM assets greatly reduce the cost of implementing the new provider.

## Recommended Next Steps

### Immediate remediation tickets

1. `fix(platform): reject darwin until a mac provider exists`
2. `fix(preferences): hydrate ApplyContext from persisted theme/font/fontSize`
3. `fix(theme): make light/dark explicit and correct Rose Pine`
4. `fix(theme): install exact Neovim plugin/config for every theme`
5. `fix(theme): restore CLI surfaces on native Windows`
6. `fix(font): install and verify Nerd Fonts on Ubuntu and Windows native`
7. `fix(clipboard): add wl-clipboard to desktop manifest`
8. `fix(red-ui): consume current Windows release asset`
9. `feat(agent): add Pi and RedSkills verification`
10. `chore(red-skills): move universal installer from v2 to v3`
11. `feat(webapps): wire catalog into CLI/TUI and add browser dependency`
12. `feat(update): verified atomic self-update and rollback`
13. `feat(mcp): model install/configure/initialize/smoke/readiness and explicit CLI fallback`
14. `feat(agent-cli): standardize --agent, --help --agent, doctor --json and non-interactive behavior`
15. `test(skills): generate/version product skills with their CLI releases and fail on command drift`
16. `docs(agents): add verified minimal AGENTS.md plus Claude bridge and agent-executable install.md`

### Product epics

1. RedDB Employee Profile.
2. Theme/Font Contract.
3. Semantic Hotkeys and Cross-platform Tiling.
4. Desktop Linux Parity.
5. macOS Intel/ARM.
6. Clean-machine E2E Fleet.
7. Generated Capability and Asset Documentation.
8. RedDB Agent Accessibility: CLI contracts, generated skills, host plugins, MCP fallback and readiness.

## Final assessment

The first report was wrong in depth because it compared intentions and architecture, not the product that actually reaches the machine. The full inspection changes the conclusion in important ways.

red-dev is more advanced as an engine. Omakub is more advanced as a workstation. Today, saying that red-dev is the spiritual evolution of Omakub is a product direction, not yet a complete description of the experience delivered.

The good news is that the most difficult foundation already exists: providers, convergence, WSL/Windows, state, doctor, themes as data, releases and multiplatform RedDB products. The gaps found are concrete and plannable. Correcting correctness first, transforming the RedDB setup into a verifiable profile and then porting the complete Omakub interaction model will allow red-dev to surpass the original without losing its differentiator: a coherent, updatable and recoverable workstation on any supported system.
