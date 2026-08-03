# red-dev vs. Omakub: comparative analysis and opportunities

## Date

2026-08-03

## Query

Compare what Omakub delivers today with what red-dev delivers, validate the thesis that red-dev is a multiplatform spiritual evolution, identify gaps for the initial setup of RedDB.io contributors and propose a product path for installation, desktop experience, agents, internal tools and upgrades.

## Scope

- red-dev in commit `e7757978783fc96ec8871e5efdeddc93ee8adc06`, package version `0.19.0`.
- Latest published stable release of red-dev at the time of research: `v0.17.1`.
- Omakub in commit `c873902f1a5d8b0f54e2e52d565a77274a5941ff`, version/release `1.5.0`.
- Ubuntu, WSL, Windows and the aspiration to support macOS.
- Initial installation, convergence, updating, themes, fonts, hotkeys, tiling, applications, languages, databases, AI agents and RedDB tools.
- Only official documentation, repositories and releases were used as external sources.

Manual testing on clean hardware, subjective evaluation of each theme or the final choice of native tools for tiling and launcher on macOS are not part of this study.

## Executive Summary

The thesis of "spiritual evolution of the Omakub" is defensible, but it is still partially realized.

red-dev already has a more ambitious engineering foundation: typed model of platform and capabilities, compiled binaries, providers per platform, convergent and re-executable installation, `plan`, `doctor`, fault isolation, persistent preferences, migrations, WSL/Windows integration and a much more agent- and RedDB ecosystem-oriented offering. This is a real evolution of Omakub's Ubuntu-focused Bash scripting model.

Omakub, however, still delivers a more complete and coherent Linux desktop experience on day one. It configures GNOME, workspaces, tiling, launcher, dock, shortcuts, applications, LazyVim, VS Code, web apps, languages and databases as a single experience. red-dev has great pieces, but several still don't form an end-to-end journey.

The five main blockers are:

1. `red-dev update` does not update the red-dev binary itself.
2. macOS is not supported and today may fall incorrectly into Ubuntu providers; must explicitly fail until there is a real Darwin provider.
3. Pi is not in the catalog and Hermes is installed without receiving RedSkills integration; the uniform agent environment promise still effectively only covers Claude Code, Codex, and OpenCode.
4. The Ubuntu desktop does not port or validate the layer that makes Omakub memorable: hotkeys, tiling, workspaces, dock, launcher and GNOME extensions.
5. The editorial and workstation experience is incomplete: there is no LazyVim bootstrap, full VS Code template, database selector and the web apps module is not connected to any commands or menus.

The recommendation is not to indiscriminately copy all Omakub applications. It's about preserving red-dev's converged architecture and organizing the product into declarative profiles - for example `minimal`, `desktop`, `reddb-employee`, and `ai-heavy` - with a common semantic layer for themes, fonts, hotkeys, tools, agents, and readiness checks.

## Official sources

### red-dev

- [README and product promise](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/README.md)
- [Platform detection and capabilities](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/platform.ts)
- [Tool manifest and provider selection](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/manifest.ts)
- [Agent catalog and installation](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/agents.ts)
- [Installation and update providers](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/providers.ts)
- [Update CLI](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/commands/update.ts)
- [Migrations](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/migrations.ts)
- [Hotkeys](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/hotkeys.ts)
- [Web apps](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/webapps.ts)
- [Stable release v0.17.1](https://github.com/reddb-io/red-dev/releases/tag/v0.17.1)

### Omakub

- [Official website](https://omakub.org/)
- [Official manual](https://learn.omacom.io/1/read)
- [Official repository](https://github.com/basecamp/omakub)
- [Main installer](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install.sh)
- [Main menu](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/bin/omakub)
- [GNOME configuration and hotkeys](https://github.com/basecamp/omakub/tree/c873902f1a5d8b0f54e2e52d565a77274a5941ff/defaults)
- [Theme catalog](https://github.com/basecamp/omakub/tree/c873902f1a5d8b0f54e2e52d565a77274a5941ff/themes)
- [Update and migrations](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/bin/omakub-sub/update.sh)
- [Release v1.5.0](https://github.com/basecamp/omakub/releases/tag/v1.5.0)

### Pi and Hermes

- [Pi Coding Agent - official README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
- [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Hermes - installation](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/installation.md)
- [Hermes - skills](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md)
- [Hermes - MCP](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md)

## Hotlinks

- [red-dev README](../../README.md)
- [Platforms](../../src/platform.ts)
- [Manifest](../../src/manifest.ts)
- [Agents](../../src/agents.ts)
- [Providers](../../src/providers.ts)
- [Hotkeys](../../src/hotkeys.ts)
- [Web apps](../../src/webapps.ts)
- [Migrations](../../src/migrations.ts)

## Product Comparison

| Dimension | Omakub | red-dev today | Verdict |
|---|---|---|---|
| Platform | Ubuntu GNOME x86_64; deliberately narrow focus | Ubuntu 24.04, path to 26.04, WSL and Windows x64; aspirational macOS | red-dev has the broader architecture, but still doesn't ship macOS/ARM |
| Distribution method | Checkout Git + scripts Bash | Linux/Windows compiled binaries and typed manifest | red-dev |
| Reexecution | Linear installation with `set -e` | Idempotent convergence, independent steps, `plan` and `doctor` | red-dev |
| Update | Updates the checkout itself and performs migrations | Updates system, tools and RedSkills, but not red-dev itself | Draw with critical gap in red-dev |
| Desktop Linux | Complete GNOME: extensions, tiling, dock, launcher, workspaces and hotkeys | Apps, themes and fonts; GNOME configuration not yet ported/validated | Omakub |
| Windows/WSL | Not an objective | Host integration, shared config, winget and basic hotkeys | red-dev |
| Themes | Ten themes about terminal, editor and GNOME | Same ten, plus multiple CLI surfaces and agents | red-dev in coverage; Omakub in GNOME finish |
| Fonts | Four families, configurable sizes | Four families, persistent sizes 7–14 | Equivalent, with different family choices |
| Editor | Neovim/LazyVim and VS Code configured | Install Neovim/VS Code and apply themes, without complete baseline | Omakub |
| Languages | Ruby/Node and selection of Go, PHP, Python, Elixir, Rust and Java | Node, Bun, Deno, Python, Go, Rust, Ruby and Java via mise | red-dev on modern runtimes; Omakub includes PHP/Elixir |
| Databases | MySQL, Redis and PostgreSQL selectable via Docker | No database/service journey | Omakub |
| Applications | Extensive workstation catalog | Smaller, development-centric catalog/RedDB | Omakub in scope; red-dev has better internal identity |
| Web apps | Integrated into the menu and desktop | Implementation exists, but has no CLI/menu route and is Linux-only | Omakub |
| Agents | Not the center of the product | Ten options, RedSkills on three hosts, RedDB extensions | red-dev, with Pi/Hermes gaps |
| RedDB Tools | Not applicable | `red`, `tq`, red-request, dit and red-ui depending on platform | red-dev |
| Diagnosis | Scripts/migrations, without equivalent drift model | `doctor`, capabilities, providers and persistent preferences | red-dev |

## Main findings

### 1. red-dev's structural advantage is real

Omakub is a vertical product: choose Ubuntu GNOME and transform it profoundly. This restriction is responsible for much of its coherence. The official installer validates Ubuntu and x86 architecture and runs Bash scripts in sequence.

red-dev separates platform, environment and capabilities; uses different providers for `apt`, `winget`, GitHub Releases and own installers; preferences and migrations persist; and treats WSL and Windows as coordinated sides of the same workstation. The design allows for growth without duplicating the entire product per operating system.

This advantage must be protected. Porting ad hoc scripts from Omakub directly would weaken red-dev's main differentiator. Each new delivery should follow the same manifesto, capacity, ownership, convergence and diagnosis model.

### 2. macOS is not yet a product platform

`platform.ts` recognizes `darwin`, but there is no Darwin environment or macOS provider column in the manifest. The current selection chooses `u24` for any non-Windows system that doesn't fall into the Ubuntu 26 branch. In other words, macOS is not just missing: without an additional guard, it may receive an installation attempt with Ubuntu providers.

The bootstraps and releases reinforce this: there are Linux/WSL and Windows x64 paths, without macOS x64/arm64 artifacts. The first fix should be to fail closed and explain "macOS not yet supported". Only then should Homebrew/casks, configuration paths, bootstrap, themes, fonts, hotkeys and universal artifacts be included.

### 3. The update has a hole in the most important component

The `red-dev update` command upgrades the system by `apt` or `winget`, updates RedSkills, and converges the installed items. It does not download a new release from red-dev itself.

Omakub updates its own checkout with Git and performs migrations after the previous commit. red-dev already has a better typed migration infrastructure, but it only reaches the user if the new binary is installed by another means.

A reliable upgrade trail needs to include:

- channel and version discovery (`stable`, optionally `preview`);
- download the correct artifact for system and architecture;
- validation by checksum and, ideally, signature;
- binary atomic swap;
- execution of migrations;
- rollback to previous binary;
- `doctor` detecting divergence between binary, manifest and installed version of RedSkills.

### 4. "Every agent ready" still means three hosts

The red-dev catalog offers Claude Code, Codex, OpenCode, Gemini, T3 Code, Herdr, OpenClaw, Hermes, Claude Desktop, and Codex Desktop. Pi is not present.

RedSkills integration is coded for Claude Code, Codex and OpenCode. Hermes can be installed, but does not receive the shared skills directory or MCP configuration from RedSkills. This creates an important difference between "installed agent" and "enterprise ready agent".

Official sources show a practical path:

- Pi discovers skills in `~/.agents/skills/`, in addition to its own directories, and accepts packages to distribute skills, extensions, prompts and themes. The first integration can share skills; a complete integration can use a package/extension for hooks, MCP and theme.
- Hermes allows you to declare external skill directories in `~/.hermes/config.yaml` and has native MCP configuration. Therefore, it can point to `~/.agents/skills` and receive the RedSkills servers without duplicating the content.

The recommended model is to replace the hard list with a `SkillHostAdapter` with common operations: detect, install, connect shared directory, configure MCP/hooks/extensions, measure version/freshness, and run a health check.

### 5. Omakub Wins in Integrated Linux Desktop Experience

Omakub configures six fixed workspaces, keyboard navigation, terminal/browser/launcher shortcuts, dock favorites, and extensions like Tactile, Just Perfection, Blur My Shell, Space Bar, Undecorate, and TopHat. This is not a set of isolated details; it is a consistent model of interaction.

In red-dev, the hotkey layer implemented today covers two Windows shortcuts to open terminal. The README acknowledges that GNOME hotkeys, extensions, and dock have not yet been ported, and that the Ubuntu desktop has not been validated on real hardware.

The opportunity is stronger than a key copy: create a semantic catalog of actions, for example `terminal.new`, `terminal.workspace`, `launcher.open`, `window.tile.left`, `workspace.goto.1` and `screenshot.region`. Each platform receives equivalent bindings, conflict validation and a generated cheat sheet. Thus, muscle memory remains coherent even when GNOME, PowerToys and the chosen manager on macOS use different formats.

### 6. Themes and fonts are a strong point, but they need to become a contract

The two projects currently offer ten theme families: Tokyo Night, Catppuccin, Gruvbox, Everforest, Kanagawa, Matte Black, Nord, Osaka Jade, Ristretto and Rose Pine.

red-dev applies the theme to zellij, btop, Neovim when already configured, VS Code, bat, delta, lazygit, OpenCode, Herdr, and OS surfaces. Tool coverage is excellent. Omakub applies particularly cohesively to GNOME, terminal, zellij, Neovim, btop, TopHat, VS Code and wallpaper.

To sustain expansion, the theme must be treated as a contract of tokens and capabilities, not just as a collection of files. Each surface should declare support, ownership, merge strategy and verification. Pi, Hermes, macOS, PowerToys/AeroSpace and wallpapers per platform are included as adapters for this contract.

### 7. The editor experience is below the promise of "awesome setup"

Omakub installs a working Neovim setup based on LazyVim and configures VS Code. red-dev installs the executables and knows how to theme, but only touches Neovim when a configuration already exists. There is no bootstrap from an editorial baseline nor a complete and governed VS Code template.

For a new contributor, "editor installed" does not equate to "editor ready". Safe behavior is:

- when there is no configuration, install a versioned RedDB starter;
- when there is, never overwrite: show plan, offer adoption and merge only explicitly owned fields;
- separate corporate baseline, personal preferences and generated state;
- test re-execution and upgrade of the template.

### 8. Applications, databases and web apps do not form a single journey

Omakub offers an initial selection of apps, languages and databases. Its catalog includes browser, password manager, communication, media, office, screenshots, VPN, editors and development tools.

red-dev has a modern set of CLI, great runtimes and the internal RedDB tools, but there is no database/service selector. There is also a module with ChatGPT, Claude, Google Photos, Contacts, Tailscale and GitHub as web apps, but it is not called by command or menu and only generates Linux shortcuts.

Copying the entire catalog would increase maintenance costs and unwanted opinions. Profiles solve better:

- `minimal`: essential shell, terminal, Git, mise and CLI;
- `desktop`: apps, fonts, themes, hotkeys, editor and web apps;
- `reddb-employee`: desktop + RedDB stack + approved agents + corporate configurations;
- `ai-heavy`: expanded set of agents, runtimes and extensions.

The first run selects a profile, allows differences, and writes the intent. Later updates reconcile this intent without turning personal preferences into drift.

### 9. The RedDB stack is the most valuable differentiator and must have an SLO ready

red-dev already distributes `red`, `tq`, red-request, dit and red-ui, in addition to RedSkills and extensions. This is the point that transforms it from "sophisticated dotfiles" into the company’s onboarding platform.

Today availability varies by platform, with red-ui limited to Linux and no macOS providers. The installation needs to end with a readiness report, not just successful processes:

- each selected CLI responds to `--version` or `--help`;
- each selected desktop app has compatible artifact and can launch;
- Docker is active;
- each selected agent sees the same version of RedSkills;
- Mandatory MCPs initialize;
- pending authentications appear as clear human actions without storing secrets in red-dev;
- skips have an explicit reason and distinguish "not chosen", "not supported" and "failed".

### 10. Real validation needs to achieve matrix ambition

The README itself notes validation limitations: Ubuntu desktop and Ubuntu 26 have not yet been exercised as a full target, and the Windows bootstrap has not been validated on a completely clean machine. Current releases only cover Linux x64 and Windows x64.

The minimum CI/E2E contract per target must be:

1. clean machine;
2. `plan` before installation;
3. profile installation;
4. second installation with zero unexpected changes;
5. `doctor` verde;
6. changing theme/font and checking surfaces;
7. update from N-1 to current;
8. rollback testado;
9. smoke test of RedDB agents and tools.

## API, CLI and configuration details

### Proposed CLI

```text
red-dev self-update [--channel stable|preview] [--version X]
red-dev profile list
red-dev profile show reddb-employee
red-dev profile apply reddb-employee [--plan]
red-dev agents doctor
red-dev tools doctor
red-dev hotkeys list
red-dev hotkeys apply [--plan]
red-dev webapps
red-dev doctor --readiness
red-dev rollback
```

`red-dev update` should orchestrate `self-update`, migrations and convergence, preserving a single command to the happy path.

### Proposed internal contracts

```ts
interface PlatformProvider {
  platform: "ubuntu" | "windows" | "macos";
  architecture: "x64" | "arm64";
  detect(): Promise<CapabilitySet>;
  plan(item: DesiredItem): Promise<PlanStep[]>;
  apply(step: PlanStep): Promise<Result>;
  verify(item: DesiredItem): Promise<HealthResult>;
}

interface SkillHostAdapter {
  id: "claude" | "codex" | "opencode" | "hermes" | "pi";
  detect(): Promise<HostState>;
  install(): Promise<Result>;
  wireSharedSkills(path: string): Promise<Result>;
  configureIntegrations(): Promise<Result>;
  verify(): Promise<HealthResult>;
}

interface SemanticHotkey {
  action: string;
  description: string;
  bindings: Partial<Record<"gnome" | "windows" | "macos", string>>;
}
```

### Configuration Property

Every adapter must declare one of these strategies:

- `owned`: file entirely generated by red-dev;
- `merged`: only explicit keys are managed;
- `adopted`: existing file is imported after confirmation;
- `external`: red-dev just checks and guides.

This distinction is essential for secure upgrades of VS Code, Neovim, agent configurations, GNOME, PowerToys, and macOS.

## Release Notes

- The audited red-dev checkout states `0.19.0`, while the latest stable release found is `v0.17.1`. The report evaluates the current code and flags the difference because it affects the upgrade experience.
- The analyzed Omakub is in `1.5.0`, with corresponding official release.
- Omakub's manual documentation may lag behind the repository in inventories such as number of themes; when there was divergence, the code fixed in the analyzed commit was considered the source of truth.
- Pi is currently published under `earendil-works/pi`; Historical links or packages may point to earlier names.

## Gotchas

- Multiplatform does not mean artificial parity. Some features must have semantic equivalents, not identical implementations.
- Do not configure `darwin` to "use whatever works on Linux". Providers must fail closed to prevent `apt` calls on macOS.
- Sharing the skills directory does not guarantee full RedSkills integration; MCP, hooks, plugins and update cycle need per-host verification.
- Changing existing dotfiles silently would destroy trust. `plan`, ownership and explicit adoption are product requirements.
- Many core applications make installation slow and fragile. Profiles must keep the shortest path small.
- Global hotkeys conflict with system, accessibility and apps. The schema needs to detect collisions before applying.
- A successful download does not prove readiness. `doctor` must test for observable behavior.
- Automatic update without rollback turns an installer into a workstation's single point of failure.

## Open questions

1. What is the mandatory baseline for the `reddb-employee` profile and which items remain optional?
2. Should macOS standardize Bash for parity, adopt native Zsh, or offer both under the same contract?
3. Which macOS combination will be official for tiling and launcher? This decision deserves a spike with real hardware.
4. Does RedDB want to fully govern the Neovim/VS Code template or just distribute updatable starters?
5. Which MCPs and authentications are required per agent, and which are personal?
6. Will preview releases be consumed by everyone or just by an internal channel?
7. Should the corporate profile install security apps/VPN/password manager or just prepare the integration hooks?
8. What onboarding metrics can be collected opt-in and without exposing machine information?

## Source-to-source notes

### red-dev

- The README defines five current/planned targets, commands, core stack, agents, themes, RedDB tools, and known limitations.
- `platform.ts` proves the presence of `darwin` in the OS type, but the absence of a macOS environment/provider.
- `manifest.ts` checks the Ubuntu 24, Ubuntu 26 and Windows columns and the inappropriate selection of Ubuntu for all non-Windows.
- `providers.ts` and the update command show system/tools upgrades without changing the red-dev binary.
- `agents.ts` proves the current catalog and the absence of Pi.
- RedSkills integration limits hosts to Claude, Codex, and OpenCode; additional paths cover VS Code extension and Herdr plugin.
- `hotkeys.ts` only covers the two current Windows shortcuts.
- `webapps.ts` contains the implementation, but there is no reference to it in command/menu.
- `migrations.ts` demonstrates that an appropriate basis for state upgrades already exists.

### Omakub

- README/site/manual define the deliberately opinionated proposal for Ubuntu.
- `install.sh` demonstrates the linear Bash pipeline and the terminal/desktop distinction.
- The repository defaults show GNOME, extensions, dock, workspaces and hotkeys.
- The menus show selection of apps, languages, databases, themes, fonts, install/uninstall and update.
- The theme catalog in the analyzed commit contains ten themes.
- The update flow uses Git checkout and performs migrations by timestamp/commit.

### Pi

- The official README documents installation, skill directories, and extensible template.
- Package documentation shows distribution and updating of skills, extensions, prompts and themes.
- The project philosophy does not include MCP in the core; an extension is the path to further integration.

### Hermes

- The official documentation covers Linux, macOS, WSL and Windows.
- External skills can be declared in configuration, allowing sharing `~/.agents/skills`.
- MCPs are natively configurable, offering a direct path to RedSkills services.

## Recommended next steps

### P0 - make the promise honest and updatable

1. Make macOS crash closed immediately; never select Ubuntu provider for Darwin.
2. Implement atomic `self-update` with checksum, rollback and release channel.
3. Incorporate `self-update` into the happy path of `red-dev update`.
4. Generate a public capability/platform matrix from the manifest.
5. Add `doctor --readiness` and distinguish installed/configured/healthy/auth-required.

### P0 - complete RedDB Day One profile

1. Define and version the `reddb-employee` profile.
2. Add Pi to catalog.
3. Introduce `SkillHostAdapter` for Claude, Codex, OpenCode, Hermes and Pi.
4. Connect Hermes to the shared directory and RedSkills MCPs.
5. Connect Pi to shared skills and build package/extension for complete integration.
6. Ensure providers and health checks for `red`, `tq`, red-request, dit, red-ui and RedSkills on each supported target.

### P1 - achieving Omakub finish on Linux

1. Port Omakub's GNOME intent to red-dev converged adapters.
2. Create the semantic schema of hotkeys and generated cheat sheet.
3. Deliver tiling, workspaces, launcher and dock as part of the desktop profile.
4. LazyVim's secure bootstrap and VS Code baseline when there is no configuration.
5. Connect `webapps.ts` to CLI/menu and add Windows/macOS adapters.
6. Offer development databases/services as an optional module.

### P1 - truly deliver macOS

1. Create Darwin environment/capabilities and providers Homebrew/cask/builtin/GitHub Releases.
2. Publish x64 and arm64 with bootstrap and checksums.
3. Adapt paths, shell, terminal, fonts, themes and applications.
4. Make spike and ADR for tiling, launcher and hotkeys.
5. Port the entire RedDB stack before declaring corporate profile parity.

### P2 - prove and support

1. CI/E2E on Ubuntu 24/26, WSL, Windows and macOS Intel/ARM.
2. Test clean installation, second convergence, N-1 update, rollback and doctor.
3. Generate docs, theme/app/agent inventories and support matrix from code.
4. Establish onboarding SLOs:
   - profile ready in up to 30 minutes, excluding downloads and human authentications;
   - second convergence without unexpected changes;
   - `doctor` green after setup;
   - every chosen agent sees the expected version of RedSkills;
   - every RedDB tool chosen passes smoke test;
   - proven N-1 upgrade and rollback on each platform.

## Conclusion

red-dev doesn't need to compete with Omakub for the number of scripts or applications. Its opportunity is to be the governed, verifiable, cross-platform version of the same idea: an excellent development workstation as an ongoing product.

Today it already has the best foundation for this. To transform the thesis into experience, the priority must be to complete the full cycle - install, configure, verify, update and recover - first on the RedDB Day One profile, then on the Linux desktop and finally on macOS. When agents, internal tools, themes, fonts, hotkeys, and editors are expressed as declarative contracts on this foundation, red-dev will stop being just a spiritual evolution of Omakub and become a workstation platform that Omakub, by choice of scope, is not intended to be.
