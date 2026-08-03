# Omarchy Deep Dive — Product, UX, Agents, Assets, Hotkeys and red-dev Opportunities

**Research date:** 2026-08-03

**Scope:** Omarchy as a Linux distribution and desktop product, its stable 3.8.4 release, the in-development 4.0 “Quattro” branch, its ISO/package delivery chain, and the ideas red-dev should adapt or reject.

**Method:** official-source-only audit of the repositories, release artifacts, product site and manual. File counts and inventories were recomputed from pinned checkouts rather than copied from marketing copy.

## Executive Summary

Omarchy is not simply “Omakub for Arch”. Omakub configures an existing Ubuntu installation; Omarchy owns nearly the entire workstation experience: bootable ISO, installer, partitioning, encryption, package repositories, update channels, boot loader, snapshots, recovery, hardware adaptation, login, compositor, desktop shell, launcher, panels, themes, hotkeys, default applications, web apps, developer tools and agent tooling.

That larger ownership produces the most coherent keyboard-first Linux workstation examined in this study. The coherence is built from a few strong product decisions:

1. One discoverable action system connects hotkeys, a hierarchical menu, a machine-readable CLI and shell IPC.
2. Themes are semantic token sets rendered into application-specific templates, staged atomically and applied across the desktop.
3. Installation, removal, updates, migrations and recovery are treated as product surfaces rather than isolated scripts.
4. Hardware differences are represented as detected capabilities and adapters.
5. AI agents are part of the standard workstation: Omarchy installs several agent CLIs, ships an Agent Skill describing safe customization, themes agent interfaces and exposes command metadata agents can inspect.
6. The distribution is validated through a real graphical clean-machine installation harness using VM keystrokes, OCR, screenshots and post-install acceptance checks.

The highest-value lesson for red-dev is not to turn into an Arch distribution. It is to define an equivalent **cross-platform workstation contract**: semantic actions, capability-driven adapters, an atomic theme pipeline, a manifest-backed control center, command metadata for humans and agents, lifecycle symmetry and clean-machine graphical acceptance tests.

The audit also found important limits that must not be copied:

- Omarchy’s default aliases deliberately start Claude and Codex with permission bypasses.
- Secure Boot is not currently delivered; users are instructed to disable it.
- Omarchy package repositories are configured with permissive signature policies even though packages are signed.
- The stable ISO’s documented detached-signature URL returned 404 during this audit.
- Documentation, stable 3.8.4 and the future 4.0 alpha disagree on themes, terminal, networking, workspaces and firewall behavior.
- The 4.0 branch is a large architectural rewrite and must not be represented as stable functionality.
- Omarchy’s opinionated personal app/hotkey choices are excellent for a single “omakase” product but unsuitable as an unconditional enterprise default.

The recommended direction is therefore: **adapt Omarchy’s contracts and testing discipline; do not clone its package list, security compromises or Linux-only implementation.**

## Official Sources

### Pinned repositories and releases

| Source | Pinned state | Purpose in this audit |
|---|---|---|
| [basecamp/omarchy](https://github.com/basecamp/omarchy) | stable tag [`v3.8.4`](https://github.com/basecamp/omarchy/tree/v3.8.4), commit `8fcc9d6048af4cb0e3af8512c78049857a3b53dd`; Quattro commit [`12af188304793b65551b5c43d20f02961dc938a9`](https://github.com/basecamp/omarchy/tree/12af188304793b65551b5c43d20f02961dc938a9) | Runtime, commands, configuration, themes, shell, packages, migrations and tests |
| [Omarchy releases](https://github.com/basecamp/omarchy/releases) | latest stable `v3.8.4`, published 2026-07-21 | Stable product boundary and ISO checksum |
| [omacom-io/omarchy-iso](https://github.com/omacom-io/omarchy-iso) | commit [`17532793fdccea862b6c9a080b55b85c7a4b5321`](https://github.com/omacom-io/omarchy-iso/tree/17532793fdccea862b6c9a080b55b85c7a4b5321) | ISO build, signing, installer and graphical acceptance harness |
| [omacom-io/omarchy-pkgs](https://github.com/omacom-io/omarchy-pkgs) | commit [`7a5f347a8b95639de8b3a79b67b0bc197caeb21a`](https://github.com/omacom-io/omarchy-pkgs/tree/7a5f347a8b95639de8b3a79b67b0bc197caeb21a) | Custom package source, build, signing and promotion |
| [omacom-io/omarchy-site](https://github.com/omacom-io/omarchy-site) | commit [`2844c11632b0a48ab1339c062a89a13087a03274`](https://github.com/omacom-io/omarchy-site/tree/2844c11632b0a48ab1339c062a89a13087a03274) | Download experience and public positioning |
| [omacom-io/omarchy-mirror](https://github.com/omacom-io/omarchy-mirror) | current official repository | Mirror tooling and package delivery context |

### Product and manual

- [Omarchy product site](https://omarchy.org)
- [The Omarchy Manual](https://learn.omacom.io/2/the-omarchy-manual/)
- [Welcome to Omarchy](https://learn.omacom.io/2/the-omarchy-manual/91/welcome-to-omarchy)
- [Getting started](https://learn.omacom.io/books/2/pages/50)
- [Navigation](https://learn.omacom.io/2/the-omarchy-manual/51/navigation)
- [Hotkeys](https://learn.omacom.io/books/2/pages/53)
- [Updates](https://learn.omacom.io/2/the-omarchy-manual/68/updates)
- [Extra themes](https://learn.omacom.io/books/2/pages/90)
- [Making a theme](https://learn.omacom.io/2/the-omarchy-manual/92/making-your-own-theme)
- [Security](https://learn.omacom.io/2/the-omarchy-manual/93/security)
- [System snapshots](https://learn.omacom.io/2/the-omarchy-manual/101/system-snapshots)
- [Fingerprint and FIDO2 authentication](https://learn.omacom.io/2/the-omarchy-manual/77/fingerprint-fido2-authentication)
- [Mac support](https://learn.omacom.io/2/the-omarchy-manual/97/mac-support)
- [Manual installation](https://learn.omacom.io/2/the-omarchy-manual/96/manual-insta)
- [Troubleshooting](https://learn.omacom.io/2/the-omarchy-manual/88/troubleshooting)

## Hotlinks

- Stable package manifest: [`install/omarchy-base.packages`](https://github.com/basecamp/omarchy/blob/v3.8.4/install/omarchy-base.packages)
- Quattro package manifest: [`install/omarchy-base.packages`](https://github.com/basecamp/omarchy/blob/12af188304793b65551b5c43d20f02961dc938a9/install/omarchy-base.packages)
- Quattro AI/tool installation: [`install/user/mise.sh`](https://github.com/basecamp/omarchy/blob/12af188304793b65551b5c43d20f02961dc938a9/install/user/mise.sh)
- Agent aliases: [`default/bash/aliases`](https://github.com/basecamp/omarchy/blob/12af188304793b65551b5c43d20f02961dc938a9/default/bash/aliases)
- Omarchy Agent Skill: [`default/omarchy-skill/SKILL.md`](https://github.com/basecamp/omarchy/blob/12af188304793b65551b5c43d20f02961dc938a9/default/omarchy-skill/SKILL.md)
- Application bindings: [`default/hypr/bindings/applications.lua`](https://github.com/basecamp/omarchy/blob/12af188304793b65551b5c43d20f02961dc938a9/default/hypr/bindings/applications.lua)
- Tiling bindings: [`default/hypr/bindings/tiling.lua`](https://github.com/basecamp/omarchy/blob/12af188304793b65551b5c43d20f02961dc938a9/default/hypr/bindings/tiling.lua)
- Utility bindings: [`default/hypr/bindings/utilities.lua`](https://github.com/basecamp/omarchy/blob/12af188304793b65551b5c43d20f02961dc938a9/default/hypr/bindings/utilities.lua)
- Universal clipboard: [`default/hypr/bindings/clipboard.lua`](https://github.com/basecamp/omarchy/blob/12af188304793b65551b5c43d20f02961dc938a9/default/hypr/bindings/clipboard.lua)
- Atomic theme application: [`bin/omarchy-theme-set`](https://github.com/basecamp/omarchy/blob/12af188304793b65551b5c43d20f02961dc938a9/bin/omarchy-theme-set)
- Update orchestration: [`bin/omarchy-update`](https://github.com/basecamp/omarchy/blob/12af188304793b65551b5c43d20f02961dc938a9/bin/omarchy-update)
- ISO configurator: [`configs/airootfs/root/configurator`](https://github.com/omacom-io/omarchy-iso/blob/17532793fdccea862b6c9a080b55b85c7a4b5321/configs/airootfs/root/configurator)
- ISO test architecture: [`README.md`](https://github.com/omacom-io/omarchy-iso/blob/17532793fdccea862b6c9a080b55b85c7a4b5321/README.md)

## Version Discipline: Stable Product vs Quattro

This distinction is essential because the default GitHub branch is not the stable release.

| Dimension | Stable 3.8.4 | Quattro checkout audited |
|---|---|---|
| Product status | released 2026-07-21 | `4.0.0.alpha` in repository version file |
| Desktop shell | Hyprland plus Waybar, Walker, Mako, SwayOSD and related processes | one Quickshell-based Omarchy shell with a plugin/IPC architecture |
| Terminal in package manifest | Alacritty | Foot |
| Network stack | iwd/Impala-oriented stable manifest | NetworkManager plus integrated shell panel |
| Lock/idle | Hyprlock/Hypridle | shell/service integration |
| Themes found in source | 19 | 22 |
| Command files | 283 | 397 |
| Legacy/current migrations | 330 | 54 current migrations after rewrite/consolidation |
| Tests found | one older test file | 150 files across shell and acceptance areas |
| Base package entries | 149 | 144 |
| Other/ISO-support entries | 60 | 60 |

Additional version notes:

- The stable tag and GitHub release are named `v3.8.4`, but the `version` file at that tag contains `3.8.3`. This is a release-engineering inconsistency, not evidence that the tag is unofficial.
- Manual pages lag both source lines. Examples include theme count, workspace count, default terminal and SSH/firewall behavior.
- Any Quattro capability in this document is labeled as such and is an architectural preview, not a promise that stable users receive it today.

## Key Findings

The detailed audit supports five conclusions that should guide the red-dev roadmap:

1. Omarchy’s advantage comes from shared contracts—actions, capabilities, themes and lifecycle—not from any single package.
2. Its Quattro architecture makes the operating system unusually legible to both people and agents through one CLI/menu/hotkey/Skill vocabulary.
3. Its semantic theme engine, user-overlay model and graphical acceptance harness are mature patterns worth adapting almost directly.
4. Its strongest implementation choices depend on owning Arch, Wayland and Hyprland; red-dev must preserve the intent through platform adapters rather than copy the mechanism.
5. Omarchy’s security compromises are meaningful enough that a RedDB implementation needs stricter artifact verification, safer agent defaults and clearer data-loss metadata.

### What Omarchy Actually Delivers

The useful unit of analysis is a product stack, not a dotfiles repository:

```text
Product site + manual
        ↓
Signed bootable ISO + interactive configurator
        ↓
Arch base + Omarchy stable/RC/edge/dev package channels
        ↓
LUKS2 + Btrfs + Limine + Snapper + system services
        ↓
Hyprland + Omarchy shell/menu/panels/plugins
        ↓
Themes + assets + semantic hotkeys + default apps
        ↓
Developer tools + AI agents + Agent Skill + command metadata
        ↓
Updates + migrations + snapshots + rollback + reinstall
        ↓
QMP/OCR clean-machine graphical acceptance testing
```

Omarchy can make stronger coherence guarantees than red-dev or Omakub because it owns every layer. The cost is equally real: it assumes Arch Linux, Wayland, Hyprland, a rolling package base and a specific opinionated workflow.

## Installation and First-Run Experience

### Supported delivery path

The ISO repository now states that the bootable ISO is the only supported installation path. The manual-install page remains an advanced fallback, not the normal product funnel. This removes a large class of “unknown starting state” failures.

The stable 3.8.4 release publishes an externally hosted ISO of 7,957,577,728 bytes, approximately 7.96 GB, with SHA-256:

```text
7bc1dc7d98f3d088e57dc06581a494ea441fb15f3edd191360fd1696931bd895
```

The size reflects an unusually complete offline payload: the installer can carry the Omarchy runtime, settings and a package mirror rather than depending on a fragile live network bootstrap.

### Configurator flow

The current configurator asks for and validates:

1. Keyboard layout, including Brazilian Portuguese (`br-abnt2`) and many international layouts.
2. Username, with syntax validation and rejection of reserved system accounts.
3. A password, confirmation and yescrypt hash.
4. Optional full name and email for Git identity.
5. Hostname.
6. Timezone, with a geolocation-assisted default when available.
7. Target disk and a visible partition summary.
8. Full-disk or free-space installation mode when the machine supports it.
9. Encrypted-by-default confirmation; the unencrypted path is intentionally less prominent.

The password is explicitly reused for the user, root and LUKS encryption when encryption is enabled. That reduces cognitive load but couples three security boundaries to one secret.

### Disk behavior

Stable documentation emphasizes a dedicated drive and destructive full-disk installation. Quattro’s current ISO configurator adds a protected free-space mode:

- Selects the largest contiguous unallocated region.
- Requires at least 32 GB total allocation.
- Creates a dedicated 2 GB `OMARCHY_EFI` partition and an `OMARCHY_ROOT` partition.
- Leaves an existing Windows ESP untouched.
- Detects the `-FVE-FS-` BitLocker signature and refuses to proceed.
- Creates LUKS2 encryption by default.
- Creates Btrfs subvolumes `@`, `@home`, `@log` and `@pkg`.
- Uses `/boot` as the dedicated ESP mount for encrypted installs and `/efi` for unencrypted installs.
- Does not automatically shrink an existing filesystem; the user must create free space first.

This is careful engineering, but it belongs to the unreleased Quattro line. The repository also contains detailed **plans** for dual boot, protected recovery partitions, OEM installation, factory reset, AArch64 and consumer Secure Boot. Those plan documents are not delivered product features.

### Authentication and login

Encrypted installations can auto-login through SDDM because disk unlock is treated as the physical authentication boundary. Unencrypted installs retain the visible login prompt. This is a deliberate reduction of duplicate authentication rather than an accidental bypass.

The tradeoff should be documented clearly: possession of an already-unlocked machine grants the local session, and the single password has unusually broad impact.

### First-run integrations

The user setup path applies:

- Wi-Fi/network checks.
- Hardware-specific fixes.
- Matching speaker tuning.
- User systemd units.
- User theme and agent theme activation.
- Omarchy Skill installation for supported agents.
- Git identity when supplied.
- Desktop and application defaults.

The product does not attempt to configure every account. 1Password, GitHub, Signal, Spotify, browser sync and agent-provider credentials remain user-owned authentication steps.

## Installed Programs and Packages

### Stable 3.8.4: what users receive today

The stable base manifest contains 149 packages. Its major end-user programs and tools include:

| Area | Stable packages/programs |
|---|---|
| Browser and credentials | Chromium, 1Password beta, 1Password CLI |
| Communication/media | Signal Desktop, Spotify, LocalSend, OBS Studio, Kdenlive, mpv |
| Documents/creation | LibreOffice Fresh, Obsidian, Typora, Pinta, Xournal++, Evince |
| Files/system | Nautilus, GNOME Disk Utility, Sushi, GNOME calculator, system-config-printer |
| Terminal/dev | Alacritty, Neovim, tmux, GitHub CLI, Docker/Buildx/Compose, Ruby, Rust, LLVM/Clang, mise |
| Terminal utilities | bat, eza, fd, fzf, ripgrep, jq, lazygit, lazydocker, btop, fastfetch, dust, zoxide, tldr |
| Desktop | Hyprland, Waybar, Omarchy Walker, Mako, Hyprlock, Hypridle, SwayOSD, SDDM |
| Capture/input | grim, slurp, Satty, GPU Screen Recorder, Hyprpicker, Tesseract OCR, wl-clipboard |
| Connectivity | iwd, Impala, Bluetui, Wiremix, Avahi, GVFS SMB/NFS/MTP |
| AI | Claude Code as a package, plus user-level agent tools installed separately |

### Quattro base manifest: complete 144-package inventory

This is the exact non-comment inventory from the pinned `install/omarchy-base.packages`, grouped here only for readability:

**Desktop, session and system integration:** `aether`, `alsa-utils`, `asdcontrol`, `avahi`, `bluez`, `bluez-tools`, `bluez-utils`, `bolt`, `brightnessctl`, `cups`, `cups-browsed`, `cups-filters`, `cups-pdf`, `ddcutil`, `dosfstools`, `exfatprogs`, `fcitx5`, `fcitx5-gtk`, `fcitx5-qt`, `fontconfig`, `gnome-keyring`, `gnome-themes-extra`, `gvfs-mtp`, `gvfs-nfs`, `gvfs-smb`, `hyprland`, `hyprland-guiutils`, `hyprland-preview-share-picker`, `hyprsunset`, `kernel-modules-hook`, `networkmanager`, `nss-mdns`, `pacman-contrib`, `pamixer`, `plocate`, `plymouth`, `power-profiles-daemon`, `python-gobject`, `quickshell-git`, `sddm`, `socat`, `system-config-printer`, `tzupdate`, `udiskie`, `ufw`, `ufw-docker`, `usage`, `uwsm`, `wireless-regdb`, `wireplumber`, `wl-clipboard`, `wtype`, `xdg-desktop-portal-gtk`, `xdg-desktop-portal-hyprland`, `xdg-terminal-exec`, `yaru-icon-theme`.

**Desktop applications and media:** `chromium`, `evince`, `imv`, `kdenlive`, `libreoffice-fresh`, `localsend`, `moonlight-qt`, `mpv`, `mpv-mpris`, `nautilus`, `nautilus-python`, `gnome-disk-utility`, `obs-studio`, `obsidian`, `omacalc`, `omacut`, `omawrite`, `pinta`, `sushi`, `xournalpp`.

**Development and terminal:** `bash-completion`, `bat`, `btop`, `clang`, `cliamp`, `docker`, `docker-buildx`, `docker-compose`, `dotnet-runtime`, `dua-cli`, `expac`, `eza`, `fakeroot`, `fastfetch`, `fd`, `foot`, `fzf`, `git`, `gum`, `inetutils`, `inotify-tools`, `inxi`, `jq`, `lazydocker`, `lazygit`, `less`, `libsecret`, `libyaml`, `llvm`, `lua51`, `luarocks`, `man-db`, `mariadb-libs`, `mise`, `nvim`, `omarchy-nvim`, `postgresql-libs`, `python-poetry-core`, `python-terminaltexteffects`, `qemu-user-static-binfmt`, `qrencode`, `ripgrep`, `ruby`, `starship`, `tensaku`, `tldr`, `tree-sitter-cli`, `tmux`, `tobi-try`, `unzip`, `whois`, `yay`, `yt-dlp`, `zoxide`.

**Capture and transformation:** `ffmpegthumbnailer`, `grim`, `gpu-screen-recorder`, `hyprpicker`, `imagemagick`, `slurp`, `tesseract`, `tesseract-data-eng`.

**Fonts and icons:** `noto-fonts`, `noto-fonts-cjk`, `noto-fonts-emoji`, `ttf-ia-writer`, `ttf-jetbrains-mono-nerd-basic`, `woff2-font-awesome`.

### Quattro ISO/hardware support: complete 60-entry inventory

The secondary manifest makes the ISO and hardware breadth explicit:

`autoconf-archive`, `asusctl`, `base`, `base-devel`, `broadcom-wl`, `btrfs-progs`, `dkms`, `egl-wayland`, `gst-plugin-pipewire`, `gtk4-layer-shell`, `libpulse`, `intel-ipu7-camera`, `intel-lpmd`, `intel-media-driver`, `libva-intel-driver`, `libva-nvidia-driver`, `limine`, `limine-mkinitcpio-hook`, `limine-snapper-sync`, `linux`, `linux-firmware`, `linux-headers`, `linux-ptl`, `linux-ptl-headers`, `macbook12-spi-driver-dkms`, `nvidia-580xx-dkms`, `nvidia-dkms`, `nvidia-open-dkms`, `nvidia-580xx-utils`, `nvidia-utils`, `lib32-nvidia-580xx-utils`, `lib32-nvidia-utils`, `pipewire`, `pipewire-alsa`, `pipewire-jack`, `pipewire-pulse`, `qt6-wayland`, `snapper`, `sof-firmware`, `thermald`, `webp-pixbuf-loader`, `yay-debug`, `tuxedo-drivers-nocompatcheck-dkms`, `yt6801-dkms`, `zram-generator`, `libvpl`, `vpl-gpu-rt`, `vulkan-intel`, `vulkan-radeon`, `vulkan-asahi`, `linux-firmware-marvell`, `dell-xps-touchpad-haptics`, `lsp-plugins-lv2`, `apple-bcm-firmware`, `apple-t2-audio-config`, `linux-t2`, `linux-t2-headers`, `t2fanrd`, `tiny-dfr`, `qmk-hid`.

### Stable-to-Quattro program changes

The rewrite is not just a package refresh:

- Alacritty moves to Foot as the base terminal, while multiple terminals remain optional and themeable.
- Waybar, Walker, Mako, SwayOSD, Swaybg, Hyprlock and Hypridle give way to the integrated Quickshell architecture.
- iwd/Impala move toward NetworkManager and an integrated network panel.
- Stable packages such as 1Password, Signal, Spotify, Typora, Rust, GitHub CLI and Claude Code are no longer all system-base entries; several move to optional or user-managed installation.
- New first-party programs appear: Omawrite, Omacut and Omacalc.
- `dust` becomes `dua-cli`; `neovim` becomes the custom `nvim` package; the Nerd Font package is narrowed to the basic variant.
- Moonlight, yt-dlp, QR generation, ddcutil, udiskie, inotify tools and Quickshell enter the core.

This is a positive ownership shift: the immutable/base layer gets smaller while personal and fast-moving developer tools move to user-level management. red-dev should use the same separation explicitly.

## AI and Developer Tooling

### Installed agent surface in Quattro

`install/user/mise.sh` installs the following user-level tools:

- Codex
- Claude Code
- Gemini CLI
- GitHub CLI
- GitHub Copilot CLI
- OpenCode
- Playwright
- Pi
- Oh My Pi (`omp`)
- `ghui`
- Hunk

Stable Omarchy also installs a comparable agent/tool set, though some packaging locations differ. The important product decision is that agent readiness is not an optional afterthought.

### Opinionated aliases

Omarchy makes autonomous agent execution a one-letter workflow:

```bash
alias c='opencode --auto'
alias cx='claude --permission-mode bypassPermissions'
alias cy='codex -s danger-full-access -a never'
```

It also provides `tdl`/`tdlm` tmux layouts for one or two agent panes and an editor/diff/terminal/agent workspace.

This is extremely efficient for DHH’s trusted personal machine model. It is not an acceptable corporate default. red-dev can ship ergonomic aliases or profiles, but permission bypass must be explicit, visible, scoped and preferably time-limited.

### The Omarchy Agent Skill

Quattro ships an extensive host-agnostic Skill and symlinks it into agent-specific locations for Codex, Claude and Pi, plus the general `.agents` convention. The Skill teaches an agent to:

- Inspect the packaged source under `/usr/share/omarchy`.
- Write user changes under `~/.config` rather than mutating managed defaults.
- Prefer the stable `omarchy` CLI.
- Back up existing configuration.
- Validate changes.
- Respect trust boundaries and privilege escalation.
- Discover supported customization paths for hotkeys, themes, plugins and system behavior.

This is one of Omarchy’s strongest contributions. It turns undocumented “dotfile folklore” into an agent-operable public contract. It is directly compatible with the earlier DHH/37signals finding: products should expose API/CLI primitives and teach agents how to compose them safely, instead of making MCP the only access route.

### Agent-aware visual integration

The theme engine includes templates or hooks for Claude and Pi, while OpenCode is restarted on theme changes. The Quattro bar includes a `model-usage` plugin. AI is therefore integrated into both operation and presentation.

### Implication for MCP reliability

Omarchy suggests a useful hierarchy for red-dev and RedDB:

1. Stable local CLI with structured output.
2. Product-owned Agent Skill explaining safe workflows.
3. Optional MCP for richer discovery and UI integration.
4. Health/readiness commands and a CLI fallback when MCP startup fails.

That structure would have reduced the severity of the original `castle`, `navigator` and `rsp` startup failures: the agent could still inspect health and execute supported actions through a stable command surface.

## CLI, Menu and Discoverability

### Machine-readable command system

The Quattro checkout contains 397 command files. Its command registry successfully described 393 commands, including 339 public commands, 54 hidden implementation commands and 73 commands requiring sudo. It supports:

- Hierarchical command groups.
- Summaries, arguments, examples and aliases embedded as source metadata.
- `omarchy commands --all --json` for machine-readable discovery.
- Metadata validation through `omarchy commands --check`.
- Group-level help.
- A distinction between public product surface and internal plumbing.

The largest command families cover installation, hardware, Hyprland, launch, removal, themes, restart, update, menus, refresh, toggles, developer tooling, audio, packages and plugins.

red-dev should adopt this exact concept: every action should carry stable ID, human label, description, platform availability, privilege level, destructive flag, arguments, result schema and health dependencies. The CLI, menus, hotkey help and Agent Skill should all derive from the same registry.

### Hierarchical control center

Quattro’s root menu is data-driven JSONC with nested routes and runtime predicates. Its top-level areas are:

- Apps
- Learn
- Trigger
- Style
- Setup
- Install
- Remove
- Update
- About
- System

Entries can have `when` conditions and `checked` state, so the menu is both launcher and control surface. User extensions live outside packaged defaults. This is a much more scalable model than independent install scripts and undocumented shortcuts.

### Install surface

The current CLI exposes optional installation for:

- **Browsers:** Chrome, Brave, Brave Origin, Edge, Firefox and Zen.
- **Developer environments:** Ruby, Node, Bun, Deno, Go, Laravel, Symfony, PHP, Python, Elixir, Phoenix, Rust, Java, Zig, OCaml, .NET, Clojure and Scala.
- **Databases:** containerized database setup.
- **Editors:** Emacs, Helix, VS Code and Zed, with related menu variants in the product line.
- **Gaming:** Battle.net, GeForce Now, Heroic, Lutris, RetroArch, Steam, Xbox Cloud and Xbox controllers.
- **Services:** 1Password, Dropbox, NordVPN, ONCE, Signal, Spotify, Sunshine and Tailscale.
- **Terminals:** Alacritty, Foot, Ghostty and Kitty.
- **Fonts:** Cascadia Mono, Meslo LG, Fira Code, Victor Code, Bitstream Vera and Iosevka.
- **Chromium helpers:** Copy URL native integration, Google account integration and yt-dlp.

### Removal symmetry

Omarchy exposes matching removal flows for browsers, development environments, gaming, services, security features, web apps, TUIs and preinstalls. This matters more than it first appears: a workstation product must know what it owns and how to unwind it.

Some removal operations can delete substantial state. A red-dev action registry should explicitly tag:

- package-only removal;
- configuration removal;
- credential/session removal;
- user-data deletion;
- reversible vs irreversible operations;
- confirmation phrase and dry-run requirements.

## Default Apps and Web Apps

Quattro’s default web-app surface includes Basecamp, ChatGPT, Discord, Google Contacts, Google Maps, Google Messages, Google Photos, HEY, WhatsApp, X, YouTube and Zoom, with launch aliases for compose/new-message variants. Stable packaging also includes items such as GitHub, Figma and Fizzy in parts of its web-app inventory.

Web apps are not crude bookmarks. Omarchy creates app launchers, retrieves high-resolution icons where possible, assigns matching/focus behavior and integrates hotkeys. It also exposes user-managed creation and removal.

This model is useful for red-dev if separated into profiles:

- A neutral core should provide the web-app mechanism.
- An employee profile can provide RedDB-approved defaults.
- A personal/DHH-inspired profile can include HEY, Basecamp and opinionated shortcuts.
- User-created apps must remain first-class and removable.

## Hotkeys — Complete Interaction Model

The Quattro bindings are split into semantic Lua modules rather than one opaque compositor file. They feed a built-in keybinding help surface (`Super+K`), making the keyboard model learnable.

### Application launchers

| Hotkey | Action |
|---|---|
| `Super+Enter` | Terminal |
| `Super+Shift+Enter` | Browser |
| `Super+Shift+F` | File manager |
| `Super+Alt+Shift+F` | File manager at current working directory |
| `Super+Shift+B` | Browser alternate binding |
| `Super+Alt+Shift+B` | Private browser |
| `Super+Shift+N` | Editor |
| `Super+Alt+Enter` | tmux terminal |
| `Super+Shift+M` | Spotify/music |
| `Super+Alt+Shift+M` | CLI music player |
| `Super+Shift+D` | Docker/lazydocker |
| `Super+Shift+G` | Signal |
| `Super+Shift+O` | Obsidian |
| `Super+Shift+W` | Omawrite |
| `Super+Shift+/` | Password manager |

Opinionated preinstalled web-app bindings include ChatGPT, Grok, HEY calendar/email/new email, YouTube, WhatsApp, Google Messages, Google Photos, Google Maps and X/new post. The source allows the preinstalled binding layer to be disabled.

### Universal clipboard

| Hotkey | Behavior |
|---|---|
| `Super+C` | Copy; emits `Ctrl+C` in GUI apps and `Ctrl+Insert` in terminals |
| `Super+V` | Paste; emits `Ctrl+V` in GUI apps and `Shift+Insert` in terminals |
| `Super+X` | Cut |
| `Super+Ctrl+V` | Clipboard manager |

This is a subtle but excellent usability layer. It gives Linux a macOS-like universal convention without breaking terminal interrupt semantics.

### Tiling and workspaces

| Area | Hotkeys and behavior |
|---|---|
| Close | `Super+W`; `Ctrl+Alt+Delete` closes all windows |
| Layout | `Super+J` split, `Super+P` pseudo, `Super+T` float/tile, `Super+L` dwindle/scrolling |
| Fullscreen | `Super+F` full screen, `Super+Ctrl+F` tiled full screen, `Super+Alt+F` full width |
| Pop/pin | `Super+O` floats and pins; width save/restore on `Super+Alt+Home`/`Super+Home` |
| Focus | `Super+Arrow` directional focus; `Alt+Tab` cycles windows |
| Swap | `Super+Shift+Arrow` swaps windows |
| Workspaces | `Super+1…0` selects 1–10; add Shift to move window; add Shift+Alt for silent move |
| Workspace history | `Super+Tab`, `Super+Shift+Tab`, `Super+Ctrl+Tab` |
| Scratchpad | `Super+S` toggle; `Super+Alt+S` move window |
| Monitors | `Ctrl+Alt+Tab`; directional monitor/workspace movement variants |
| Resize | three increments: 25, 100 and 300 pixels through modifier variants |
| Mouse | `Super+left-drag` moves; `Super+right-drag` resizes; wheel changes workspace |
| Groups | `Super+G` groups; directional group insertion, group cycling and direct positions 1–5 |
| Scaling | `Super+/` up; `Super+Alt+/` down |

The manual describes fewer workspaces in places, but the audited Quattro source binds all ten.

### System, style and capture

| Hotkey | Action |
|---|---|
| `Super+Space` | Omarchy menu |
| `Super+Escape` | System menu |
| `Super+K` | Keybinding reference |
| `Super+Alt+K` | tmux keybinding reference |
| `Super+Ctrl+E` | Emoji picker |
| `Super+Ctrl+C` | Capture menu |
| `Super+Ctrl+O` | Toggle menu |
| `Super+Ctrl+H` | Hardware menu |
| `Super+Shift+Space` | Top bar |
| `Super+Ctrl+Space` | Background switcher |
| `Super+Ctrl+Shift+Space` | Theme menu |
| `Super+Backspace` | Window transparency |
| `Super+Shift+Backspace` | Gaps |
| `Print` | Screenshot |
| `Alt+Print` | Screen recording menu/stop |
| `Super+Print` | Color picker |
| `Super+Ctrl+Print` | OCR selection to clipboard |
| `Super+Ctrl+S` | Share menu |
| `Super+Ctrl+.` | Transcode |
| `Super+Ctrl+R` | Reminder creation |
| `Super+Ctrl+L` | Lock |

There are dedicated panels for audio, Bluetooth, display, calendar, network, power and activity, plus notification dismissal/history/silencing, nightlight, idle locking, internal-monitor control, mirror mode, zoom, battery, weather and time.

### Hardware media keys

Omarchy handles volume, mute, microphone mute, display brightness, keyboard backlight, touchpad on/off, media next/play/pause/previous, output switching and source switching. `Alt` variants provide one-unit precision instead of the normal larger step.

### Dictation

When VoiceType is present, `Super+Ctrl+X` toggles dictation and `F9` works as push-to-talk. Conditional binding prevents a dead shortcut when the capability is absent.

### red-dev lesson

Do not copy this key map literally across Windows, WSL, Linux and macOS. Define semantic actions such as `window.focus.left`, `app.terminal`, `capture.ocr`, `clipboard.history` and `theme.next`, then provide platform bindings, collision detection, a searchable overlay and an exportable machine-readable registry.

## Themes, Fonts and Assets

### Built-in theme inventory

Stable 3.8.4 contains 19 themes:

`catppuccin`, `catppuccin-latte`, `ethereal`, `everforest`, `flexoki-light`, `gruvbox`, `hackerman`, `kanagawa`, `lumon`, `matte-black`, `miasma`, `nord`, `osaka-jade`, `retro-82`, `ristretto`, `rose-pine`, `tokyo-night`, `vantablack`, `white`.

Quattro contains 22, adding:

`last-horizon`, `lupine`, `solitude`.

The manual’s smaller advertised theme count is therefore stale.

### Asset inventory

The pinned Quattro repository contains:

- 91 theme background images.
- 131 PNG files overall.
- 60 JPG/JPEG files overall.
- 5 SVG files overall.
- Per-theme preview and lock-preview imagery.
- Plymouth boot graphics and scripts.
- App/extension icons.
- Font packages for Noto Latin/CJK/emoji, JetBrains Mono Nerd Basic and iA Writer.
- Optional font installers for Cascadia Mono, Meslo LG, Fira Code, Victor Code, Bitstream Vera and Iosevka.

Licensing/provenance is not obvious for every bundled wallpaper and derivative theme asset. red-dev should require an asset manifest with origin, author, license, checksum, intended surfaces and redistribution status.

### Semantic color architecture

Each Quattro theme centers on `colors.toml`, not a pile of unrelated app fragments. It describes:

- dark or light mode;
- background and foreground;
- accent color;
- semantic red, orange, yellow, green, cyan, blue, purple and magenta;
- neutral ramps;
- gradients;
- optional per-surface overrides.

Theme-specific files can override generated output for Chromium, btop, Hyprland, Neovim, VS Code and icons.

### Generated surfaces

Quattro carries 17 default theme templates:

- Alacritty
- btop
- Chromium
- Claude
- Foot
- Ghostty
- Gum
- Helix
- Hyprland preview picker CSS
- Hyprland
- keyboard RGB
- Kitty
- Neovim
- Obsidian
- Pi
- Omarchy shell
- VS Code

Additional apply hooks cover tmux, GNOME/GTK and application restarts. Theme changes therefore propagate far beyond the terminal.

### Atomic theme application

The theme setter:

1. Resolves the selected official or user theme.
2. Builds a clean `next-theme` staging directory.
3. Copies explicit theme files first.
4. Renders default templates only where an explicit file did not already win.
5. Atomically swaps the completed theme directory into place.
6. Tells the live shell to adopt the palette immediately.
7. Runs application-specific hooks in parallel.
8. Refreshes tmux, terminal, GNOME, browser/editor and agent surfaces as appropriate.

This avoids half-applied themes and establishes a clear precedence rule: packaged semantic default → selected theme override → user override.

### Theme extension model

Themes can be installed from Git repositories, updated and removed. Aether provides a GUI path for creation. Community themes are documented separately from first-party themes.

For red-dev, the missing contract should be:

```text
semantic tokens
  → generated per-app configuration
  → user override
  → staged validation
  → atomic activation
  → restart/reload only affected surfaces
  → visual acceptance screenshot
```

## Quattro Desktop Shell and Plugin Platform

Quattro replaces a collection of independent desktop processes with a long-running Quickshell application. The checkout contains 102 QML files and 26 first-party plugin manifests, including nested panel/service plugins.

First-party plugin capabilities include:

- background and transitions;
- top bar;
- active window;
- workspaces;
- system tray;
- keyboard layout;
- microphone;
- update status;
- clipboard;
- emoji and image pickers;
- lock screen;
- launcher/menu;
- model usage;
- notifications and history;
- on-screen display;
- audio, Bluetooth, network, monitor, power and weather panels;
- Dropbox and Tailscale panels;
- polkit prompts;
- reminders;
- battery, idle, media and nightlight services;
- developer gallery.

The default shell configuration places menu/workspaces on the left, clock/weather/update in the center and model usage/connectivity/audio/display/power on the right. Default idle timings observed were 150 seconds to screensaver and 300 seconds to lock.

### Plugin ownership model

Third-party and cloned plugins live under `~/.config/omarchy/plugins/<id>` with a manifest schema. Commands support add, clone, enable, disable, update, validate, list and remove. A user can clone a built-in plugin before modifying it rather than patching `/usr/share/omarchy`.

This packaged-default/user-overlay split is highly reusable. The Quickshell implementation is not portable, but the manifest and IPC contracts can be.

## Updates, Migrations and Recovery

### Channels

Omarchy exposes four operating postures:

- **stable:** curated Omarchy packages and an Arch base intentionally delayed by roughly a month according to the manual;
- **RC:** release-candidate validation;
- **edge:** newer Arch/package content;
- **dev:** source checkout plus edge-like dependencies.

The stable delay is a risk-control mechanism for rolling release, not a conventional fixed release branch.

### Update transaction

Quattro’s `omarchy update` sequence is explicit:

1. Capture terminal output in `/tmp/omarchy-update.log`.
2. Acquire a per-user runtime lock so two updates cannot run concurrently.
3. Require sufficient free space.
4. Ask for confirmation unless `-y` is supplied.
5. Create a Snapper snapshot when available.
6. Inhibit sleep during the transaction.
7. Update a dev checkout if applicable.
8. Update signing keyring.
9. Update system packages.
10. Run migrations.
11. Run post-update hooks.
12. Update AUR and mise-managed packages.
13. identify/remove or retain orphan packages through the product flow.
14. Analyze logs and update status.
15. Release the sleep inhibitor.
16. Offer or perform the appropriate restart.

An ALPM pre-transaction guard blocks an ordinary direct `pacman -Syu` path and instructs the user to use `omarchy update`, with an escape mechanism for deliberate bypass. This protects lifecycle hooks but reduces standard Arch autonomy.

### Migration model

Stable history contains 330 migration scripts; Quattro’s reorganized branch has 54 current migrations. Fresh installs mark shipped migrations as already applied, while upgrades run only pending items. Multi-user handling can notify another user when system updates advanced migrations outside their session.

The design is good, but configuration migration remains difficult. The manual acknowledges incomplete `.pacnew`/`.pacsave` handling, and the refresh command’s path validation is not strong enough to reject every `..` traversal into locations outside the intended `~/.config` subtree.

### Recovery

Omarchy combines:

- Btrfs subvolumes;
- Snapper snapshots;
- Limine boot integration;
- pre-update snapshots;
- rollback documentation;
- a reinstall command for restoring managed packages/configuration.

Reinstall and some removal flows are intentionally destructive. A future internal recovery-partition/factory-reset design exists in plan documents, but it is not current product functionality.

## Hardware and Platform Adaptation

### Delivered adapters

The Quattro source contains detection or setup paths for:

- NVIDIA open/proprietary/legacy and hybrid GPU configurations.
- Intel Panther Lake kernels, Wi-Fi 7, IPU7 cameras, SOF audio, media drivers, thermald and low-power behavior.
- AMD and Intel Vulkan drivers.
- ASUS ROG, Zenbook, ExpertBook and Flow Z13 behaviors.
- Framework 16/QMK input.
- Dell XPS haptic touchpads, OLED/text scaling and speaker behavior.
- Microsoft Surface firmware/kernel support.
- Lenovo Yoga speaker tuning.
- Apple T1/T2 keyboard, NVMe, Wi-Fi, audio, fan and display support.
- Broadcom Wi-Fi.
- Tuxedo keyboard/backlight hardware.
- Synaptics input devices.
- YT6801 Ethernet.
- Laptop touchpad, touchscreen, webcam, lid and internal display behavior.

### Audio tuning

Audio deserves separate mention. Omarchy matches hardware against tuning data and launches an LV2 PipeWire filter chain in a separate user service. A malformed speaker profile therefore does not have to crash or poison the main PipeWire graph. Matching profiles can be enabled, disabled and changed independently.

This is a model for red-dev adapters: isolate fragile vendor tuning from the core service and expose deterministic match/explain/disable commands.

### Mac support

The manual supports Intel Macs, including significant T1/T2 accommodations. Apple Silicon direct installation is not a currently delivered mainstream path. Although the package repository has x86_64 and AArch64 capabilities and `vulkan-asahi` appears in the support manifest, the existence of an AArch64 plan must not be confused with an official M-series ISO.

### Input caveat

Full-disk encryption requires input before the normal Bluetooth stack is running. The manual recommends a wired or 2.4 GHz keyboard for the LUKS prompt. That is an important first-run compatibility constraint.

## Security and Supply Chain Assessment

### Positive controls

- LUKS2 encryption is the default path.
- Btrfs/Snapper snapshots protect update recovery.
- UFW defaults to deny incoming and allow outgoing.
- LocalSend receives narrow TCP/UDP rules on port 53317.
- Docker receives dedicated firewall handling.
- SSH setup is opt-in in the current source, uses key-oriented setup and opens a rate-limited port only when enabled.
- FIDO2 and fingerprint authentication are supported as optional setup flows.
- The ISO release process computes SHA-256 and uses a GPG signing key stored through the team’s 1Password vault.
- Omarchy’s package build system supports signed packages and promotion of tested artifacts between channels.
- Managed defaults and user customization are separated.

### Material gaps and contradictions

#### Secure Boot and TPM

Current installation guidance instructs users to disable Secure Boot and TPM-related protections. The ISO repository contains a thorough consumer Secure Boot plan, but no delivered implementation was found. This is acceptable as a clearly documented alpha/enthusiast limitation, not as a long-term enterprise baseline.

#### Package signature enforcement

Official stable/RC/edge pacman configurations use `SigLevel = Optional TrustAll` for the Omarchy repository. The Mac-specific repository path uses `SigLevel = Never`; the offline ISO mirror also trusts ISO integrity instead of enforcing package signatures. The package project says artifacts are signed and imports the key, but the client configuration does not require valid signatures.

Signed-but-optional is weaker than signature enforcement. red-dev should require signatures for all network-delivered managed artifacts and treat an offline bundle’s signed manifest as a separate verified root.

#### ISO detached signature availability

The release pipeline signs and uploads both ISO and `.sig`, and the manual tells users to append `.sig` to the ISO URL. During this audit, the exact stable 3.8.4 `.sig` URL returned HTTP 404. The SHA-256 in the release notes remains available, but a checksum shown on the same delivery channel is not equivalent to an independently verified signature.

#### Firewall documentation drift

The current source makes SSH opt-in. The Security manual says port 22 is allowed by default. The implementation should be treated as ground truth, and the documentation needs correction.

#### Unrestricted agents

The `cx` and `cy` aliases explicitly bypass normal approval/sandbox controls. This is intentional but high-risk, especially when combined with an agent Skill that can execute system configuration commands.

#### Shared secret

One password protects user, root and encrypted disk. A compromised or shoulder-surfed secret crosses all three boundaries.

#### Configuration path containment

The config refresh path check confirms existence but is not a complete canonical-path containment check. A crafted relative path containing `..` can escape the intended user config subtree. This is especially relevant once agents compose commands automatically.

#### Asset provenance

Wallpaper and theme origin/license metadata is not consistently obvious from the asset directories. A corporate distribution needs machine-readable provenance.

## Services and Runtime Behavior

System setup enables or configures:

- CUPS and CUPS browsing;
- Avahi/mDNS;
- Docker socket activation;
- systemd-resolved;
- NetworkManager in Quattro;
- power-profiles-daemon;
- SDDM;
- systemd-oomd;
- kernel cleanup hooks;
- PipeWire/WirePlumber;
- zram;
- UFW.

`NetworkManager-wait-online` is masked to avoid delaying boot on a workstation. The shell and user services handle idle, lock, notifications, media, nightlight, model usage and hardware panels.

## Testing and Quality Strategy

Quattro represents a major increase in test ambition. The checkout contains 150 files in test areas, including CLI/shell tests and graphical acceptance coverage.

The ISO harness is especially valuable:

1. Boots a real ISO in a headless VM.
2. Reads installer screens through QMP screendumps and OCR.
3. Responds with virtual keystrokes, exercising the actual wizard.
4. Validates install progress, reboot and SDDM login.
5. Boots the installed workstation.
6. Sends real keyboard shortcuts.
7. Runs the in-guest acceptance suite.
8. Checks package manifest, services, defaults, launchers, menus, panels, live weather, notifications, clipboard and interactive shell behavior.
9. Saves ordered `success-*` or `failure-*` screenshots plus serial/install logs.
10. Continues independent checks after a failure so one defect does not hide the rest.
11. Supports a reusable base disk for faster local iteration.
12. Can test the encrypted boot flow, including the LUKS password.

This is the most directly reusable Omarchy idea for red-dev. Unit tests cannot prove a theme rendered correctly, a shortcut reached the intended app, an MCP error was legible, or an installer survived an actual clean machine.

## Omarchy vs Omakub vs red-dev

| Dimension | Omakub | Omarchy | red-dev opportunity |
|---|---|---|---|
| Starting point | Existing Ubuntu/GNOME | Owned Arch ISO/distribution | Existing Windows/WSL/Linux/macOS hosts with explicit capability detection |
| Desktop ownership | GNOME customization and apps | Boot-to-desktop ownership with Hyprland/Quickshell | Cross-platform semantic action layer and native adapters |
| Package lifecycle | install scripts and Ubuntu packages | custom repos, channels, updates, migrations, removal, snapshots | signed manifests, transactional steps, rollback and ownership registry |
| Themes | coherent app configs/assets | semantic tokens, templates, previews, atomic swap, plugins | one portable token schema with per-platform renderers |
| Hotkeys | opinionated GNOME shortcuts | comprehensive discoverable keyboard OS | semantic actions, collision detection and searchable overlay |
| Apps | strong curated bundle | base/optional/web-app/TUI layers | profiles: neutral, employee, creator, DHH-inspired |
| Agents | not the main product layer | installed agents, Skill, themed interfaces and model-usage panel | CLI-first product contract, Agent Skill and MCP as optional adapter |
| Testing | script-oriented | clean-ISO graphical acceptance | clean Windows/WSL/Linux/macOS VM matrix plus screenshots |
| Hardware | relies heavily on Ubuntu | explicit hardware adapter catalogue | capability manifest and explainable adapter selection |
| Recovery | reinstall/script rerun | snapshot, rollback, reinstall | checkpointed reversible provisioning and repair |

## Opportunities for red-dev

### P0 — foundational contracts

#### 1. Semantic action registry

Create one registry for every user/system action:

```yaml
id: capture.ocr
label: Copy text from screen
platforms: [windows, linux, macos]
capabilities: [screen_capture, ocr, clipboard]
privilege: user
destructive: false
bindings:
  linux: Super+Ctrl+Print
  windows: Win+Ctrl+Shift+O
result_schema: clipboard-text
```

Generate CLI help, control-center entries, hotkey overlays, conflict checks, docs and agent metadata from it.

#### 2. Command metadata and structured health

Every red-dev command should advertise summary, arguments, examples, supported hosts, privilege, mutations, destructive effects, prerequisites, fallback and structured result. Add:

- `red-dev commands --json`
- `red-dev commands --check`
- `red-dev doctor --json`
- `red-dev mcp status --json`
- CLI fallbacks for core MCP actions

#### 3. Product-owned Agent Skill

Ship a RedDB/red-dev Skill that teaches agents:

- managed vs user-owned paths;
- platform capability discovery;
- safe use of package/theme/hotkey APIs;
- backup and rollback expectations;
- how to diagnose unavailable MCPs;
- when privilege is required;
- how to avoid unrestricted mode by default.

This should complement RedSkills rather than duplicate its process skills.

#### 4. Atomic theme contract

Replace disconnected terminal/editor themes with semantic tokens, generated adapters, asset provenance, staging, validation and atomic activation. Add a completeness check that fails when a required surface has no renderer.

#### 5. Clean-machine graphical acceptance

Build VM fixtures for Windows, WSL and Linux first. Exercise first run, terminal, clipboard, menus, themes, hotkeys, MCP failure/recovery and uninstall using actual UI input and screenshot artifacts.

### P1 — product coherence

#### 6. Manifest-backed control center

Generate a searchable control center from the same action/capability manifest. Support conditional availability, installed/checked state, install/remove symmetry and a Learn section.

#### 7. Lifecycle transaction engine

Provisioning and updates should have:

- global/per-host lock;
- free-space and dependency preflight;
- checkpoint/snapshot where supported;
- ordered migrations;
- captured log;
- rollback/repair;
- post-update validation;
- restart classification;
- dry run;
- explicit bypass with audit trail.

#### 8. Capability-driven hardware adapters

Represent host facts independently from actions: GPU, display, audio codec, laptop model, input devices, package manager, compositor, WSL version and corporate policy. Every adapter should support `match`, `explain`, `apply`, `validate`, `disable` and `rollback`.

#### 9. Profile architecture

Recommended profiles:

- `core`: shell, terminal, Git, clipboard, fonts, common CLI.
- `reddb-employee`: company apps, credentials, policies and approved agents.
- `linux-workstation`: Omarchy-inspired interaction layer where Hyprland/Wayland is available.
- `creator`: OBS, capture, video/image/document tools.
- `dhh-inspired`: HEY/Basecamp-style apps, keyboard map and optional autonomous-agent ergonomics.

The mechanism belongs in core; the personal taste belongs in profiles.

#### 10. Plugin/overlay ownership

Use immutable packaged defaults plus user-owned overlays. Never require users or agents to patch managed source. Provide clone/fork, validate, enable, disable, update and reset flows.

### P2 — differentiators

#### 11. Cross-platform universal clipboard behavior

Map a consistent copy/paste/cut/history convention while preserving terminal interrupt semantics. This is small, visible and high-frequency.

#### 12. Web-app product surface

Provide installable web apps with icons, app IDs, isolated profiles where possible, hotkeys, focus matching and complete uninstall.

#### 13. Model-usage/status integration

Expose local agent availability, authentication state, quota/usage where supported and MCP readiness through a neutral status provider. Avoid binding the core UX to any one agent vendor.

#### 14. Theme and hardware galleries

Use preview screenshots and golden images for themes; use explainable detected-card views for hardware adapters. A visual tool should be generated from the same contracts used by automation.

## What red-dev Should Not Copy

1. Permission-bypassing agent aliases as the default.
2. `Optional TrustAll` or unsigned package channels.
3. Permanent Secure Boot disablement as the product posture.
4. The 7.96 GB all-in-one ISO model for a cross-platform bootstrapper.
5. Personal HEY/Basecamp/Spotify/Signal choices in the neutral core.
6. Linux/Hyprland key combinations as the portable abstraction.
7. Blocking the native package manager without excellent escape, diagnostics and documentation.
8. A shared user/root/disk password as the only enterprise option.
9. Treating default-branch alpha code as released product.
10. Shipping backgrounds without explicit provenance metadata.
11. A rolling-distribution operational burden unless red-dev explicitly becomes an OS product.
12. Reinstall/remove commands whose data-loss scope is not machine-readable before execution.

## Proposed red-dev Architecture

```text
                        ┌─────────────────────┐
                        │ Workstation Manifest│
                        │ actions/capabilities│
                        └──────────┬──────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          │                        │                        │
 ┌────────▼────────┐      ┌────────▼────────┐      ┌────────▼────────┐
 │ Human surfaces  │      │ Agent surfaces  │      │ Lifecycle       │
 │ menu/help/keys  │      │ CLI/Skill/MCP   │      │ install/update  │
 └────────┬────────┘      └────────┬────────┘      └────────┬────────┘
          │                        │                        │
          └────────────────────────┼────────────────────────┘
                                   │
                        ┌──────────▼──────────┐
                        │ Platform adapters   │
                        │ Win/WSL/Linux/macOS │
                        └──────────┬──────────┘
                                   │
                     ┌─────────────┼─────────────┐
                     │             │             │
               themes/assets   apps/packages  hardware/services
```

The manifest is the source of truth. Menus, help, shortcuts, CLI, Skill and MCP describe the same actions. Platform adapters decide what is possible. The lifecycle engine owns mutation and rollback. Tests operate through the same public surfaces users and agents use.

## API / CLI / Config Details

### Proposed command examples

```bash
red-dev commands --json
red-dev capabilities --json
red-dev doctor --json
red-dev mcp status --json
red-dev action run capture.ocr --json
red-dev action explain theme.activate
red-dev theme validate tokyo-night
red-dev theme preview tokyo-night
red-dev theme activate tokyo-night --atomic
red-dev profile plan reddb-employee
red-dev profile apply reddb-employee
red-dev profile remove reddb-employee --keep-user-data
red-dev update plan --json
red-dev update apply
red-dev rollback latest
```

### Proposed action metadata

```json
{
  "id": "profile.remove",
  "summary": "Remove managed profile components",
  "platforms": ["windows", "wsl", "linux", "macos"],
  "requiresPrivilege": "conditional",
  "mutates": true,
  "destructive": "configuration",
  "supportsDryRun": true,
  "supportsRollback": true,
  "userDataPolicy": "preserve-by-default",
  "healthDependencies": ["package-manager", "state-store"]
}
```

### Proposed theme metadata

```toml
id = "tokyo-night"
mode = "dark"
license = "MIT"
source = "https://example.invalid/theme"

[colors]
background = "#1a1b26"
foreground = "#c0caf5"
accent = "#7aa2f7"
red = "#f7768e"
green = "#9ece6a"
yellow = "#e0af68"
blue = "#7aa2f7"

[assets.wallpaper]
path = "backgrounds/main.jpg"
author = "..."
license = "..."
sha256 = "..."
```

## Version Notes

- Stable version audited: GitHub release/tag `v3.8.4`, released 2026-07-21.
- Stable tag commit: `8fcc9d6048af4cb0e3af8512c78049857a3b53dd`.
- Stable version-file mismatch: `3.8.3`.
- Quattro source version: `4.0.0.alpha`.
- Quattro commit: `12af188304793b65551b5c43d20f02961dc938a9`, dated 2026-08-01.
- ISO commit: `17532793fdccea862b6c9a080b55b85c7a4b5321`, dated 2026-08-01.
- Package commit: `7a5f347a8b95639de8b3a79b67b0bc197caeb21a`.
- Site commit: `2844c11632b0a48ab1339c062a89a13087a03274`.
- Counts are snapshots of those commits and will change.

## Gotchas

1. Default branch `quattro` is alpha; stable behavior must be checked at the release tag.
2. The manual is not a reliable source for exact package, theme, workspace or firewall counts.
3. Secure Boot documents in `plans/` are designs, not features.
4. Apple Silicon-related packages/plans do not mean a supported M-series ISO exists.
5. The stable ISO is externally hosted; GitHub release entries do not contain the binary as a release asset.
6. The detached `.sig` URL was unavailable during the audit.
7. Encrypted boot cannot rely on an ordinary Bluetooth keyboard.
8. Stable and Quattro use materially different shell architectures.
9. Omarchy’s package-manager guard is intentional and can surprise experienced Arch users.
10. Optional AUR software has a different trust/support profile from first-party packages.
11. Theme switching may need application restart/reload even though the shell updates immediately.
12. Removal/reinstall flows need close inspection before automation because their state-deletion scope differs.
13. Agent aliases assume a trusted personal workstation and deliberately weaken interactive safety.
14. The web-app list reflects DHH/Basecamp taste, not a universal productivity baseline.
15. `omarchy refresh config` needs stronger canonical path containment before being treated as safe for arbitrary agent-generated input.

## Open Questions

1. Will Quattro 4.0 enforce package signatures before stable release?
2. Will the public ISO delivery page expose a working detached signature and public-key verification instructions beside the checksum?
3. What is the final Secure Boot and TPM posture for consumer and enterprise machines?
4. Which Quattro install modes will ship in 4.0, and which will remain plans?
5. Will user/root/LUKS credentials become separable in an advanced or managed profile?
6. What compatibility guarantee exists for third-party shell plugins and command metadata?
7. Are all bundled wallpaper/theme assets licensed for redistribution, and where is that recorded?
8. How are automatic update notifications balanced with the need for explicit migration/reboot control?
9. Will the manual be versioned per stable release instead of tracking a mixed product state?
10. Can the Agent Skill expose a safer default mode while preserving DHH’s optional “YOLO” workflow?
11. Which Omarchy ideas belong in red-dev core versus a separate Linux-workstation profile?
12. Should red-dev’s action manifest become the source of MCP tool schemas as well as CLI/menu/hotkey documentation?

## Source Notes

### Omarchy runtime

- Package counts came from non-empty, non-comment lines of the pinned manifests.
- Theme and asset counts came from the Git tree, not the manual.
- Command counts came from the repository’s own JSON command registry.
- Hotkeys were read from the Quattro Lua binding modules because they are more precise than the manual.
- Quattro shell/plugin claims came from QML and plugin manifest files.
- Update sequencing came from the actual `bin/omarchy-update` orchestration.

### ISO

- Install-mode and encryption behavior came from the current configurator source.
- The ISO repository’s `plans/` directory was used only to distinguish future intentions from delivered behavior.
- Test behavior came from the ISO README and harness source.
- ISO size/checksum came from the stable release metadata and hosted artifact response.

### Packages and mirror

- Signing and promotion claims came from the official package repository.
- Client signature-policy findings came from official pacman configuration in the ISO source.
- The distinction between “package is signed” and “client requires a valid signature” is intentional and security-relevant.

## Recommended Next Steps

### Immediate study outputs

1. Add this report as the Omarchy companion layer to the existing red-dev/Omakub/DHH study.
2. Create a decision record: red-dev remains cross-platform and adopts Omarchy patterns through adapters/profiles rather than becoming an OS distribution.
3. Convert the P0 contracts into separate design tickets before implementation.

### Suggested implementation sequence

1. **Action registry spike:** model 20 existing red-dev actions and generate JSON/help from it.
2. **MCP resilience spike:** expose MCP readiness and CLI fallbacks through that registry.
3. **Theme spike:** render one semantic theme to Alacritty, shell prompt and one editor with atomic staging.
4. **Hotkey spike:** generate a platform-specific overlay and detect collisions.
5. **Lifecycle spike:** add plan/apply/validate/rollback around one reversible package group.
6. **Agent Skill:** document safe red-dev customization and CLI discovery.
7. **Clean-machine E2E:** automate one Windows+WSL fixture and one Linux fixture with screenshots.
8. **Profiles:** separate core, RedDB employee and Omarchy-inspired Linux workstation choices.
9. **Asset manifest:** record provenance/license/checksum and visual golden image for every bundled theme asset.
10. **Security gates:** require signatures, contain paths canonically and prohibit permission-bypass defaults.

## Final Assessment

Omarchy’s deepest contribution is not Arch, Hyprland or a particular theme. It is the demonstration that a workstation can behave like a coherent product when actions, appearance, packages, hardware, updates, recovery and agents are designed as one system.

For red-dev, the strategic opportunity is to reproduce that coherence **without** inheriting the Linux-only boundary. A semantic manifest, platform adapters, atomic themes, profile-based curation, lifecycle transactions, an Agent Skill and real clean-machine UI tests would give Windows/WSL/Linux/macOS users the same feeling of deliberate integration while preserving RedDB’s portability and security needs.

Omarchy should therefore be treated as a high-quality reference implementation and a source of product contracts—not as a package list to copy wholesale.
