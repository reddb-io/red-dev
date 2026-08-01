<div align="center">

<img src="docs/hero.svg" alt="red-dev — one development environment across Ubuntu 24.04, Ubuntu 26.04, WSL and native Windows" width="100%">

<p>
  <a href="https://github.com/reddb-io/red-dev/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/reddb-io/red-dev/release.yml?branch=main&style=for-the-badge&label=CI&labelColor=07080a" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge&labelColor=07080a" alt="License"></a>
  <a href="#the-support-matrix"><img src="https://img.shields.io/badge/targets-ubuntu%2024%20%7C%2026%20%7C%20wsl%20%7C%20windows-ff2056?style=for-the-badge&labelColor=07080a" alt="Targets"></a>
  <a href="#the-identical-layer"><img src="https://img.shields.io/badge/stack-alacritty%20%7C%20zellij%20%7C%20bash-7a8088?style=for-the-badge&labelColor=07080a" alt="Stack"></a>
</p>

<strong>One development environment. Five targets. The same experience on each.</strong><br>
red-dev installs the same tools, shell, terminal, tiling and theme on bare-metal
Ubuntu, on WSL, and on native Windows — from a single binary that needs no
runtime, no bash on Windows, and no second configuration to keep in sync.

<sub>Derived from <a href="https://omakub.org">Omakub</a> by
<a href="https://dhh.dk">DHH</a> and Basecamp.
<a href="#attribution"><strong>If you run Ubuntu 24.04 on the desktop, use Omakub.</strong></a></sub>

</div>

---

## Contents

| Getting there | What it is | Living with it |
| --- | --- | --- |
| [Quick start](#quick-start) | [The support matrix](#the-support-matrix) | [Usage](#usage) |
| [Attribution](#attribution) | [The identical layer](#the-identical-layer) | [Using it on each target](#using-it-on-each-target) |
| [Develop](#develop) | [One directory both sides read](#one-directory-both-sides-read) | [Themes](#themes) |
| [Status](#status) | [Under the hood](#under-the-hood) | [Troubleshooting](#troubleshooting) |

---

## Quick start

Linux and WSL:

```bash
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-dev/main/boot.sh | sh
```

Native Windows:

```powershell
irm https://raw.githubusercontent.com/reddb-io/red-dev/main/boot.ps1 | iex
```

Both resolve the binary for your platform from the latest release, install it
under your own user, and then **open red-dev's own interface** — the same screen
you get by typing `red-dev`, where you choose between a first install and
maintenance. The bootstrap and the binary arrive at the same place on purpose;
running the one-liner is how you get the product, not a different, shorter
version of it.

Neither needs administrator or root rights for red-dev itself; individual
packages may still ask for sudo.

On Windows, open a new terminal after installing — the `PATH` entry does not
reach shells that were already running.

Every push to `main` also publishes a `next` prerelease, so the newest work is
installable without waiting for a tag:

```bash
RED_DEV_CHANNEL=next sh -c "$(curl -fsSL https://raw.githubusercontent.com/reddb-io/red-dev/main/boot.sh)"
```

```powershell
$env:RED_DEV_CHANNEL='next'; irm https://raw.githubusercontent.com/reddb-io/red-dev/main/boot.ps1 | iex
```

| Variable | Effect |
| --- | --- |
| `RED_DEV_CHANNEL` | `stable` (default) or `next` — every push to `main` publishes a `next` prerelease |
| `RED_DEV_BIN_DIR` | Where the binary lands; defaults to `~/.local/bin` (Linux) or `%LOCALAPPDATA%\red-dev\bin` |
| `GITHUB_TOKEN` | Raises the API rate limit; required only for a private fork |

---

## Attribution

**This project is inspired by, and derived from, [Omakub](https://omakub.org) by
[David Heinemeier Hansson](https://dhh.dk) and Basecamp.** Omakub is the original
idea and it deserves the credit: the omakase philosophy, the curated tool
selection, the aliases, the minimal prompt, the LazyVim setup, the theme system —
all of it started there. **If you run Ubuntu 24.04 on the desktop, use Omakub.**
It is excellent and it is the real thing.

red-dev exists for one reason: Omakub targets Ubuntu 24.04 desktop, and we needed
the same environment on Ubuntu 26.04, on WSL, and on native Windows as well.
Where this project disagrees with Omakub it is about portability, never about
taste.

Also built on [tuiuiu.js](https://github.com/forattini-dev/tuiuiu.js) for the
interactive layer and
[cli-args-parser](https://www.npmjs.com/package/cli-args-parser) for the command
surface.

---

## The support matrix

|                         | Ubuntu 24.04 | Ubuntu 26.04 |
| ----------------------- | ------------ | ------------ |
| **Desktop, bare metal** | target 1     | target 2     |
| **WSL**                 | target 4     | target 5     |
| **Windows, native**     | target 3 — no distro axis   ||

Two axes, not five cases. Code branches on **where it runs** and **what that
place can do**, never on a raw version string. Ask a machine what it is:

```bash
red-dev platform
```

```console
os=linux distro=ubuntu version=24.04 env=wsl arch=x64
caps: apt=1 gui=0 systemd=1 winget=1 flatpak=1
```

```console
os=windows distro=n/a version=n/a env=windows arch=x64
caps: apt=0 gui=1 systemd=0 winget=1 flatpak=0
```

Read the first as: a WSL distro with no display of its own, but able to reach
the Windows host through `winget`. That single pair — `gui=0 winget=1` — is why
the WSL target installs fonts and terminal configuration **on Windows** rather
than inside Ubuntu, where they would accomplish nothing.

Adding Ubuntu 28 should mean touching [`src/platform.ts`](src/platform.ts) and
the manifest, nothing else.

---

<img src="docs/stack.svg" alt="The identical layer — Alacritty, zellij and bash, one config each" width="100%">

## The identical layer

The terminal layer is the same on all five targets, because every piece of it
has a real build on every one of them.

| | | |
| --- | --- | --- |
| **Alacritty** | terminal | one `alacritty.toml`, one theme file |
| **zellij** | panes, tabs, sessions, layouts | one `config.kdl`, works over SSH |
| **bash** | shell | one set of dotfiles, Git Bash on Windows |

Alacritty deliberately has no panes, and the platform-native tiling answers
share nothing — GNOME extensions on Linux, FancyZones on Windows. Putting the
panes **inside** the terminal is what makes tiling identical everywhere, and it
keeps working over SSH, which no window manager can offer.

On native Windows the terminal launches **Git Bash, not PowerShell**. That is
what makes the shipped dotfiles apply there at all, and it is why standardising
on bash rather than PowerShell is what makes "same experience" true instead of
aspirational.

---

### zellij is the session, not a command you run

Every interactive shell starts inside zellij. omakub gets this by pointing
Alacritty's shell at `zellij`, which works because there the terminal and the
multiplexer are the same machine's programs. Here they are not: under WSL and
Git Bash the terminal is a Windows program and zellij is not, and Windows
Terminal, the VS Code terminal and every SSH session never read Alacritty's
config at all.

So it starts from [`config/bash/zellij.sh`](config/bash/zellij.sh) instead —
the one layer every target shares. One behaviour in the terminals red-dev
configures and in the ones it does not, and on the far end of an SSH
connection, which no terminal config can reach. It also settles `TERM`: a pane
gets `xterm-256color` everywhere, rather than `alacritty` in one place and
something else in another.

It stays out of the way where a multiplexer would break things — non-interactive
shells, no tty, tmux, the VS Code and JetBrains terminals, nvim's `:terminal`,
`TERM=dumb`. And it does not `exec`: a zellij that cannot start leaves you in a
plain shell with a message, because the alternative is a terminal that closes as
fast as it opens and no way to edit the dotfile that would fix it.

Turn it off with `RED_ZELLIJ=0` in `~/.config/red-dev/env.sh`.

Because zellij is now always on, its own keybindings would be taking `Ctrl-p`,
`Ctrl-t`, `Ctrl-n`, `Ctrl-o` and `Ctrl-s` from the shell that had them first. So
`config.kdl` starts in **locked** mode with the defaults cleared: `Ctrl-g`
unlocks, every binding returns to locked, and `Alt` plus arrows or `hjkl` moves
between panes without leaving it.

### The tools

`git` · `curl` · `ripgrep` · `fd` · `bat` · `eza` · `zoxide` · `fzf` · `btop` ·
`jq` · `fastfetch` · `gh` · `lazygit` · `lazydocker` · `zellij` · `mise` ·
`neovim` · `docker` · `delta` · `yazi` · `tldr` · `starship` · `atuin` ·
`carapace` · `direnv`

**The RedDB tools** come with it, because this is the environment a RedDB
developer works in:

| | | |
| --- | --- | --- |
| [`red`](https://github.com/reddb-io/reddb) | the RedDB CLI | every target |
| [`tq`](https://github.com/reddb-io/toon) | query and convert TOON | every target |
| [`red-request`](https://github.com/reddb-io/red-request) | API client, powered by recker | desktop sessions |
| [`red-ui`](https://github.com/reddb-io/red-ui) | universal client for reddb | **Linux desktop only** — see below |
| [`dit`](https://github.com/reddb-io/dit) | push-to-toggle voice dictation | desktop sessions |
| [`herdr`](https://herdr.dev) | several agents in one terminal, alive over SSH | Linux and WSL |

`red` and `tq` are CLIs, so they are `core` and land on all five targets.
`red-request`, `red-ui` and `dit` are `desktop`, which also means WSL never
attempts them: installing a Linux GUI app inside a distro with no display is the
mistake this project exists to avoid, and the Windows target already covers that
same machine.

`dit` is a CLI and still `desktop`, for the same reason wearing different
clothes — it types into the *focused application*, and under WSL there is
neither one of those nor a `/dev/input` to read its hotkey from. On Linux it
comes from the publisher's installer rather than the release binary, and not for
the usual checksum reason: dit reads its hotkey from `/dev/input` and types
through `/dev/uinput`, so it needs you in the `input` group and a udev rule.
Dropping the binary in gives you a program that runs and cannot see a keypress.
red-dev passes `--yes` to keep the converge non-interactive and `--no-service`
to leave the autostart unit alone — a standing background service is a decision
to make deliberately, and dit works without it. It also wants an
`ELEVENLABS_API_KEY`, or `--engine local` for offline Whisper.

**Coding agents** are chosen rather than assumed — `red-dev agents` offers
`claude-code`, `codex` and `opencode` pre-ticked, plus `gemini`, `herdr`,
`openclaw`, `hermes`, and the Claude, Codex and T3 Code desktop apps on
Windows. `herdr` is not an agent but the thing agents run inside — it
multiplexes several into one terminal and keeps them alive across an SSH
disconnect. Each
installs by the path its publisher supports rather than one uniform mechanism,
and *whose* path it is gets checked: winget has no Google entry for Gemini —
searching it returns third-party chat clients that merely speak to Gemini — so
that one is npm, while T3 Code went the other way, because npm's `t3code-cli` is
a third-party wrapper and winget's `T3Tools.T3Code` is the publisher's own.
Picking any CLI agent then offers
[red-skills](https://github.com/reddb-io/red-skills), which registers its
marketplace in Claude Code and Codex and generates plugin modules for OpenCode.

**Web apps** — a page in its own window, its own icon and its own alt-tab entry, the way omakub's `web2app` does it. Desktop sessions only: a `.desktop` file needs a menu to appear in.

**Optional**, never installed by a plain converge — `red-dev apps` offers them,
and so does the interview: `just` · `duf` · `dust` · `hyperfine` · `glow` ·
`gitui`, plus `powertoys` on Windows.

**Runtimes** are mise's, not the distro's, so `node` resolves the same way in
WSL, on the desktop, and in Git Bash. `red-dev lang` chooses which. A version
manager that manages nothing is how `pnpm` ends up working in one shell and not
another on the same machine.

### The shell

Aliases that normalise Debian's renames (`bat` → `batcat`, `fd` → `fdfind`), the
readline bindings that put history search on the arrow keys, `autocd`,
`cdspell`, `globstar`, a curated git alias set — and the integrations that make
the tools above actually do something rather than merely exist:

**Docker** is one daemon, never two. Under WSL, if Docker Desktop already serves
the distro, red-dev does not install `docker-ce` — a second daemon means
containers started on one side are invisible to the other, on separate networks,
with no error from either. `red-dev doctor` reports which daemon answers.

| Tool | Without the integration it is |
| --- | --- |
| `delta` | a pager git never calls |
| `yazi` | a browser you must `cd` after |
| `tldr` | "Page cache not found" |
| `atuin`, `carapace`, `direnv` | binaries nothing is bound to |

`ble.sh` — autosuggestions and syntax highlighting, the two things people most
often miss from zsh — is installed but **not enabled**. It replaces bash's line
editor rather than sitting beside it, and atuin, fzf and carapace all bind into
what it replaces. Whether they survive is an empirical question that needs a
real terminal, so turning it on is deliberate:

```bash
export RED_BLE=1
```

## Usage

```bash
red-dev                      # the fullscreen interface — and what the one-liner opens
red-dev platform             # what red-dev thinks this machine is
red-dev plan [scope]         # what would change, changes nothing
red-dev install [scope]      # converge toward the manifest
red-dev install --dry-run    # print the plan, touch nothing
red-dev update               # upgrade what the package managers own
red-dev theme [name]         # tokyo-night | catppuccin | gruvbox
red-dev apps                 # choose optional tools
red-dev lang                 # choose runtimes for mise to manage
red-dev shell                # Windows + WSL: where a terminal lands
red-dev agents               # choose coding agents, wire in red-skills
red-dev share [path]         # one directory both WSL and Windows read
red-dev share adopt <tool>   # move that tool's configuration into it
red-dev uninstall            # remove tools, or red-dev's own config
red-dev wsl                  # Windows: set up WSL
red-dev ui                   # fullscreen, with live theme preview
red-dev doctor               # report tool and configuration drift
```

Global options: `--theme`, `--font`, `--opacity`. Scopes: `core`, `desktop`,
`wsl`, `optional`.

---

### Nothing to install

Most of what this tool does is answer questions — what is this machine, what
would change, what has drifted — and none of those are worth installing
something to ask. Pass a command to the bootstrap and it runs from a temporary
copy that deletes itself:

```bash
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-dev/main/boot.sh | sh -s -- doctor
```

```console
:: resolving stable release of reddb-io/red-dev
:: downloading red-dev-linux-x64 (temporary)
:: running: red-dev doctor
```

### What asks, and what does not

`install` never prompts. It runs in CI, in scripts, and over SSH, where a
question is a hang — so every choice lives behind a command you invoke
deliberately:

| Command | Asks |
| --- | --- |
| `red-dev` | the fullscreen interface, then whatever you pick — a line-based menu below 60 columns, and `--help` with no terminal at all |
| `red-dev theme` | which theme, when given no name |
| `red-dev apps` | which optional tools |
| `red-dev lang` | which runtimes mise should manage |
| `red-dev shell` | whether a terminal lands in WSL or Git Bash |
| `red-dev agents` | which coding agents — pre-ticked, then offers red-skills |
| `red-dev uninstall` | what to remove — and confirms before removing it |
| `red-dev wsl` | whether to set WSL up on a fresh Windows machine |

Omakub asks these at first run; here they are re-runnable, because the answers
change when a project does.

### Look before you touch

`plan` names the provider that would satisfy each tool, and marks what is
already there:

```bash
red-dev plan core
```

```console
[core]
  git              apt:git (present)
  ripgrep          apt:ripgrep (present)
  fd               apt:fd-find (present)
  bat              apt:bat (present)
  starship         gh:starship/starship:starship-x86_64-unknown-linux-gnu.tar.gz (present)
  zellij           gh:zellij-org/zellij:zellij-x86_64-unknown-linux-musl.tar.gz
  docker           aptrepo:docker-ce,docker-ce-cli,containerd.io,...
```

The `wsl` scope reads differently on each side of the boundary. From inside the
distro:

```console
[wsl]
  wsl-interop      builtin:wsl-interop (managed)
  nerd-font        builtin:nerd-font (managed)
  alacritty-host   winget:Alacritty.Alacritty (managed)
  windows-terminal builtin:windows-terminal (managed)
```

From native Windows, the same scope is entirely skipped — and every skip says
why:

```console
[wsl]
  wsl-interop      skip (native Windows needs no interop shim)
  nerd-font        skip (the Windows host provides this instead)
  alacritty-host   skip (the Windows host provides this instead)
  windows-terminal skip (the Windows host provides this instead)
```

A skip is a decision. One without a reason is an undocumented gap wearing a
decision's clothes, so the manifest cannot express one.

### Converge

```bash
red-dev install wsl --dry-run
```

```console
:: os=linux distro=ubuntu version=24.04 env=wsl arch=x64
:: scope: wsl
  would install wsl-interop via builtin:wsl-interop
  would install nerd-font via builtin:nerd-font
  would install alacritty-host via winget:Alacritty.Alacritty
  would install windows-terminal via builtin:windows-terminal
 ok  dry run — nothing changed
```

Every provider is idempotent. Re-running after a partial failure is the normal
recovery path, not an edge case — one tool failing never aborts the rest:

```console
warn alacritty: ENOEXEC: unknown error, posix_spawn 'cmd.exe'
 ok  themed: zellij, btop
 ok  converged — restart your shell
```

### Reading the log while it is being written

A converge inside the fullscreen interface follows the tail, which is right until
the moment something fails — at which point the thing you want to read is the
line that just scrolled past. So the log scrolls:

| | |
| --- | --- |
| `↑` `↓` / `k` `j` | a line at a time; moving up stops following the tail |
| `PgUp` `PgDn` | a screen at a time |
| `g` / `G` | the top; the bottom, which resumes following |

Reaching the bottom re-arms the follow on its own, so there is no mode to
remember. The status line says `paused` whenever it is off — a log that stops
moving during a live converge otherwise reads as a hang.

Bad input is rejected before any provider runs, which is the cheapest possible
place to fail:

```console
$ red-dev plan nonsense
fail invalid scope 'nonsense' (expected: core, desktop, wsl)

$ red-dev frobnicate
fail Unknown command: frobnicate
Available commands: platform, plan, install, update, doctor, theme, menu
```

## One directory both sides read

```bash
red-dev share                 # where the root is, and how this side spells it
red-dev share adopt starship  # move one tool's configuration into it
red-dev share adopt           # what can be shared
```

A setting applied on one side is then the same setting on the other. The split
matters more than the directory does, and each third was measured rather than
assumed:

| | | |
| --- | --- | --- |
| **configuration** | shared | 65 ms against 22 ms to read twenty files |
| **binaries** | co-located, `bin/linux` and `bin/windows` | ELF and PE are different formats |
| **source code** | never | a build goes from 324 ms to 2726 ms |

So `bin/` is split by format and never plain `bin` — that is the part one
directory cannot deliver. WSL gets both, since interop lets a distro run a
Windows `.exe`; Windows gets only its own, because it would find files it
cannot run.

The root is stored the one way both environments can agree on — as Windows
spells it — and each side translates. There are three spellings, not two:
`C:\Users\me\.reddev` for PowerShell, `/c/Users/me/.reddev` for Git Bash, and
`/mnt/c/Users/me/.reddev` for WSL.

Nothing moves on its own. `adopt` copies rather than moves and leaves the
original where it is; on a boundary this fiddly, deleting the file you had been
editing is the wrong kind of tidy.

`git` is included rather than replaced, and `btop` stays local — both name
absolute paths that exist on exactly one side.

---

## Using it on each target

The command is the same everywhere. What differs is which scopes apply and
which machine the work lands on — `red-dev platform` will tell you before you
commit to anything.

---

### Ubuntu desktop — 24.04 or 26.04

```bash
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-dev/main/boot.sh | sh
```

Scopes: `core` + `desktop`. Everything installs locally; Alacritty and zellij
run natively, and the wallpaper goes through `gsettings`.

> [!WARNING]
> This target is **implemented and unproven** — no bare-metal Ubuntu has run it.
> Start with `red-dev install --dry-run`.

### WSL — Ubuntu 24.04 or 26.04 under Windows

```bash
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-dev/main/boot.sh | sh
```

Scopes: `core` + `wsl`. The `core` half installs inside the distro; the `wsl`
half deliberately reaches **out to Windows**, because that is where the terminal
and the fonts live. It registers the Nerd Font in the Windows font store,
configures Windows Terminal and Alacritty on the host, installs Alacritty via
winget, and re-registers the WSL interop binfmt entry that enabling systemd
silently removes.

That crossing needs interop working. If `.exe` calls fail with an exec format
error, `red-dev install wsl` repairs it.

The font goes in for the current user first, which asks nothing of anyone. Some
machines — Entra-joined Windows 11 among them — ignore per-user font
registrations entirely, and the symptom is a terminal that refuses to start with
`font "FiraCode Nerd Font Mono" not found` while the files and the registry both
look right. So the install does not trust itself: it asks Windows whether the
family resolves, and only when the answer is no does it install machine-wide and
ask for consent. `red-dev doctor` asks the same question afterwards.

### Windows, native

```powershell
irm https://raw.githubusercontent.com/reddb-io/red-dev/main/boot.ps1 | iex
```

Run it in PowerShell — Windows PowerShell 5.1 or 7, elevated or not. It needs no
administrator: the binary lands in `%LOCALAPPDATA%\red-dev\bin` and winget
installs per-user where the package allows it.

`irm`, not `curl`. In Windows PowerShell 5.1 `curl` is an alias for
`Invoke-WebRequest`, which returns a response object rather than the script text;
`iex` happens to work on it only because `ToString()` yields the body, and the
alias does not exist at all in PowerShell 7. `irm` returns a `String` directly.
And `curl.exe … | bash` is not an alternative on Windows: `bash` there resolves
to the WSL launcher, so it would install the *Linux* build into your distro while
looking like it installed on Windows.

Scopes: `core` + `desktop`, everything through winget except the RedDB tools,
which come from their own releases. The shell is **Git Bash, not PowerShell** —
that is what makes the shipped dotfiles apply, and it is why this project
standardises on bash rather than treating Windows as a separate world.

#### What the one-liner opens

It hands over to `red-dev` itself, so you land in the fullscreen interface
rather than in a converge that already started. Choosing **Install** asks first:
where to share configuration, which shell the terminal opens, which agents,
which runtimes, which optional tools, ble.sh, the font, and the theme — with
the palette previewed while the cursor moves. Previous answers come back
pre-ticked, so agreeing again is enter, enter, enter, and `q` returns to the
menu rather than starting anything.

#### The distro, converged from the Windows side

A Windows machine running WSL is two machines: separate home directories,
separate `PATH`s, separate copies of red-dev. Converging one used to say nothing
about the other, and the half you type in is usually the distro — so a Windows
install could report success beside a distro three versions behind, with no
error anywhere and the feature you had just installed simply absent.

The `desktop` scope now reaches across. It finds the default distro, compares
its red-dev to this one's, installs the matching version inside it when they
differ, and then runs `red-dev install core` there. That converge is idempotent
and costs seconds on a distro that is already current; the expensive case is the
one that needed the work.

The `wsl` scope is the same boundary crossed the other way — distro reaching out
to the host for the terminal and the fonts. Whoever is converging owns the
crossing.

Turn it off with `RED_DEV_NO_WSL_SYNC=1`. `red-dev doctor` reports the skew
either way.

#### The desktop, not just the terminal

A theme switch also sets Windows' dark mode and accent colour, from the same
per-theme intent GNOME uses — so "gruvbox is orange" means one thing on both
sides. Windows shows the accent on title bars and the taskbar only when colour
prevalence is on, so that is set too. **Already-open windows keep their old
colour until reopened.**

Tiling is the one place Windows needs help. Windows 11 has Snap Layouts
natively, and [PowerToys](https://learn.microsoft.com/windows/powertoys/) —
Microsoft's own — has FancyZones, which is the real analogue of omakub's
`tactile`, plus Command Palette in place of its Super+Space launcher. It is
offered among the optional tools rather than installed for you, because it is a
program that stays running. It ships with no grid configured; open it once to
draw one.

What Windows genuinely does not offer is switching to a *numbered* virtual
desktop. omakub binds `Super+1..6`; Windows has virtual desktops and only
sequential navigation, and reaching a specific one means calling
`IVirtualDesktopManager`, whose interface changes between Windows builds.

> [!IMPORTANT]
> **Open a new terminal afterwards.** The installer adds
> `%LOCALAPPDATA%\red-dev\bin` to your user `PATH`, and Windows does not push
> that into processes that are already running — so any shell that was open
> before will keep reporting `red-dev` as not found while every other shell finds
> it. This is the single most common "it did not install" report, and it is not
> an install failure.

> [!NOTE]
> `boot.ps1` has been syntax-checked and ASCII-gated in CI but has never run on
> a clean Windows machine.

### Both on one machine

Installing on the Windows side and inside WSL is normal and supported — they
converge different scopes and share the host's terminal configuration.

One thing they cannot share: Alacritty has no profiles, so it opens exactly one
shell. Which one is a recorded choice rather than whichever side converged last:

```bash
red-dev shell
```

Windows Terminal has profiles and does not need this; red-dev already sets its
default to the distro, opening in your Linux home rather than under `/mnt/c`.

<img src="docs/themes.svg" alt="Themes — one palette applied to terminal, multiplexer, monitor, editor and wallpaper" width="100%">

## Themes

```bash
red-dev theme gruvbox
```

```console
 ok  themed: zellij, btop, neovim, vscode, bat, delta, lazygit, opencode, herdr, windows
 ok  wallpaper set
 ok  Windows Terminal configured (backup at .../settings.json.red-dev-backup)
 ok  theme: Gruvbox Dark — open a new terminal to see it
```

Ten of them, the same set omakub ships: `tokyo-night` · `catppuccin` ·
`gruvbox` · `everforest` · `kanagawa` · `matte-black` · `nord` ·
`osaka-jade` · `ristretto` · `rose-pine`.

A theme in Omakub is eight files, not a palette. Colouring only the terminal is
what makes a switch feel half-done: the multiplexer keeps its old blue, the
editor keeps its old background, and the seams show immediately.

Omakub themes eight surfaces and every one is an application with a window. The
command-line tools it installs keep whatever colours they shipped with — so a
Kanagawa terminal shows you a Monokai diff and a Dracula file browser. Those are
surfaces too, and unlike the desktop ones they work on all five targets:

| surface | how |
| --- | --- |
| alacritty, zellij, btop, neovim, VS Code | a generated theme file each |
| `bat` | written twice, since Debian renames the binary and the config follows it |
| `delta` | through git config, where red-dev already made it the pager |
| `lazygit` | our block only; anything else in the file survives |
| `opencode`, `herdr` | told to follow the terminal rather than given a copied palette |
| Windows | dark mode and accent colour |
| GNOME | light/dark preference and accent |
| wallpaper | generated from the palette, not shipped as an image |

Telling an agent to follow the terminal instead of copying sixteen hex values
is [omarchy](https://github.com/basecamp/omarchy)'s idea, and it is the better
one: following cannot drift. Where `herdr` ships a theme with our name — it has
`tokyo-night`, `catppuccin`, `gruvbox` and `nord` — that wins, because its
author tuned those for its own interface.

Each writer owns a generated file and **references** your config rather than
rewriting it — your zellij keybindings and the rest of `btop.conf` are yours.

Wallpapers are **generated from the palette**, not shipped as photographs: no
licensing question, an exact match to the theme, and no download. The PNG
encoder is [120 lines](src/png.ts) with no image library, so it works inside the
compiled binary on every target.

---

## Troubleshooting

When a machine stops matching the manifest, these are the three
places to look — in this order.

### Known limitations, per target

| Target | What does not work, and why |
| --- | --- |
| **Ubuntu desktop** | The `desktop` scope is implemented and **has never run on real hardware**. GNOME hotkeys, extensions and dock settings are not ported at all. |
| **Ubuntu 26.04** | The `u26` manifest column exists and **no 26.04 machine has exercised it**. Package-name drift is undiscovered. |
| **WSL** | Windows interop cannot work under `sudo -u <other-user>`: `WSL_INTEROP` points at a per-session socket that sudo drops. Real invocations run as you, so this affects test harnesses only. |
| **Native Windows** | No switching to a *numbered* virtual desktop — Windows offers only sequential navigation, and reaching a specific one means an interface that changes between builds. No zellij session persistence across reboots. No `ble.sh`-style line editor. |
| **All** | `red-ui` installs on Linux desktop only, because that release has no Windows or macOS asset to install. |

Stated plainly because "implemented" and "known to work" are different claims,
and a README that blurs them costs someone an afternoon.

### When something goes wrong

Uncaught exceptions and rejections are written to
`%LOCALAPPDATA%\red-dev\crash.log` before the process exits, and on Linux to
`~/.local/state/red-dev/crash.log`. A fullscreen application that dies takes the
console with it, so the stack scrolls past inside a window that is already
closing — the file is the copy that survives.

That file earned its place. Picking Install from the fullscreen interface used
to kill the process and close the console, and three separate experiments failed
to reproduce it: two `render()` calls in one process, `exit()` from inside a key
handler, and a wall of output after teardown all survive in a real console. The
crash log named it in one stack — a second `render()` whose initialisation
failed and whose own cleanup then wrote to a stdout that was already gone. The
interface hosts every view in one render now.

To see the development warnings the shipped binaries suppress:

```bash
bun run build:debug
```

Not an environment variable. `bun build --compile` substitutes
`process.env.NODE_ENV` at build time, so nothing at runtime — not this program,
not your shell — can reach that check.

### `red-ui` on Windows

Not an oversight on either side. That release publishes a `.deb`, an
`.AppImage`, an `.rpm` and a web bundle, and nothing else — so red-dev skips it
there with that as the stated reason, rather than pointing a provider at a
filename nobody published.

It is two commented lines away in `red-ui`'s own `release.yml`: the staging step
for `red-ui-windows-x86_64-setup.exe` and the `WINDOWS_CERTIFICATE` secrets are
already wired, and the matrix entry is commented out with "intentionally
commented out until the Linux pipeline is green end-to-end". When it comes back,
this end is one line.

## Under the hood

Why the code is shaped the way it is, and what it cost to learn.

### Design

The orchestrator is TypeScript compiled with [bun](https://bun.sh) to a
standalone binary, so **native Windows needs no bash to bootstrap**. The dotfiles
stay shell, because your shell sources them, and they travel inside the binary as
text imports — the normal way to get red-dev is to download one executable, not
to clone a repository.

Omakub shells out to [gum](https://github.com/charmbracelet/gum) for prompts,
which means the UI cannot be drawn until gum is installed — precisely why a
broken gum download aborts the whole install before showing a single screen.
Compiling the interface in removes that bootstrap dependency: red-dev can always
draw its own interface, including the screen that reports a failed install.

### Bugs inherited from the WSL forks, fixed here

Porting surfaced real defects in the community WSL forks of Omakub. None are
Omakub's fault — they are what happens when a desktop-shaped tool is bent toward
WSL. Each became a design rule.

**A pinned version behind a `latest` URL.** `omakub-wsl` pins gum to `0.14.1` but
downloads from `/releases/latest/download/gum_0.14.1_amd64.deb`. The path
resolves to whatever is newest while the filename still says `0.14.1`, so it
404s the moment upstream ships a release — and `set -e` aborts the whole install.
Here, `gh:` providers match a glob against the asset names a release **actually
publishes**, and fail loudly listing the candidates.

**PATH replacement kills WSL interop.** Upstream does
`export PATH="<fixed list>"`, discarding the ~20 `/mnt/c` entries WSL injects.
`winget.exe`, `explorer.exe` and `code.exe` stop resolving, which breaks the very
host access the WSL target depends on. [`config/bash/path.sh`](config/bash/path.sh)
prepends and dedupes instead of replacing.

**A prompt that is shipped but never loaded.** `defaults/bash/rc` sources
`shell`, `aliases` and `init`, omitting `prompt`. The repo looks complete; the
machine gets no prompt.

**systemd silently kills WSL interop.** `systemd-binfmt` clears `binfmt_misc` on
boot and re-registers only what `/etc/binfmt.d/` declares — and WSL's own
`WSLInterop` entry is not there. Every `.exe` then fails with an exec format
error that points nowhere near the cause. Since red-dev is what enables systemd,
red-dev declares the entry.

**Store-installed commands are invisible to `stat`.** `winget` and friends are
`APPEXECLINK` reparse points, so an `existsSync`-based PATH scan reports winget
as absent on a machine that plainly has it. Detection uses `where.exe`.

**The archive's `tealdeer` cannot fetch its own pages.** 24.04 ships 1.6.1, which
points at a cache URL whose format has since changed: every `tldr --update` fails
and every query answers "Page cache not found". red-dev installs the release
build instead.

### Navigation

| Need | Go to |
| --- | --- |
| What gets installed, per platform | [`src/manifest.ts`](src/manifest.ts) |
| Platform detection and capabilities | [`src/platform.ts`](src/platform.ts) |
| apt, ppa, apt repos, winget, GitHub releases | [`src/providers.ts`](src/providers.ts) |
| Shell configuration, shipped as-is | [`config/bash/`](config/bash/) |
| Terminal and multiplexer config | [`src/alacritty.ts`](src/alacritty.ts), [`config/zellij/`](config/zellij/) |
| Themes and where they are applied | [`src/themes.ts`](src/themes.ts), [`src/theme-apply.ts`](src/theme-apply.ts) |
| The WSL-to-Windows boundary | [`src/wsl.ts`](src/wsl.ts) |
| Wallpaper generation | [`src/wallpaper.ts`](src/wallpaper.ts), [`src/png.ts`](src/png.ts) |
| Bootstrap scripts | [`boot.sh`](boot.sh), [`boot.ps1`](boot.ps1) |

## Develop

```bash
git clone git@github.com:reddb-io/red-dev.git
cd red-dev
bun install

bun test              # 33 tests over the decision logic
bunx tsc --noEmit
bun run build         # both binaries, cross-compiled from one host
```

```console
$ bun run build
[2.2s] compile  dist/red-dev-linux-x64
[2.4s] compile  dist/red-dev-windows-x64.exe bun-windows-x64
```

The Windows target needs no Windows runner. Two smoke tests gate the release,
because the whole distribution model rests on them: that the TUI and the
embedded dotfiles both survive `bun build --compile`.

The tests cover the decisions where a wrong answer is silent — which manifest
column a release gets, which scopes apply to a platform, whether an asset glob
matches the right file, and whether bad input is rejected. Cases come from bugs
this project actually hit, not from chasing coverage.

---

## Status

Early, but the loop runs end to end.

- Working: `platform`, `plan`, `doctor`, `menu`, `install`, `update`, `theme`,
  `apps`, `agents`, `lang`, `shell`, `uninstall`, `ui`
- Providers: apt, ppa, apt repositories, winget, vendor install scripts, GitHub
  releases on **both** Linux and Windows, and builtins for dotfiles, fonts,
  Alacritty, Windows Terminal and WSL interop
- Verified on WSL Ubuntu 24.04 and native Windows from one source tree, and on a
  freshly created user for the dotfiles path — including the full install path
  from the published release
- On native Windows: `tq 0.13.0`, `reddb 1.23.2` and `dit 0.3.0` installed and
  running from their own releases, Red Request installed silently without a UAC
  prompt, PowerToys through winget, and the accent colour read back from the
  registry as the colour the theme asked for
- Configuration shared across the boundary both ways, with the same bytes read
  from `/mnt/c/...` and `C:\...`

See [Known limitations](#known-limitations-per-target) for what is implemented
but unproven.

---

### Trying it on Windows

```powershell
irm https://raw.githubusercontent.com/reddb-io/red-dev/main/boot.ps1 | iex
```

Then, in order:

1. **Open a new terminal.** The `PATH` entry does not reach shells that were
   already running, and this is the single most common "it did not install".
2. `red-dev` — the interface. **Install** asks its questions first; nothing
   converges until you answer.
3. Try `Ctrl+Alt+T` and `Ctrl+Alt+Shift+T`.
4. `red-dev theme gruvbox`, then look at a title bar. Windows applies the accent
   to windows opened *after* the switch.
5. `red-dev doctor` — it should report no drift.

If anything dies, `%LOCALAPPDATA%\red-dev\crash.log` is the file to send.

## License

[MIT](LICENSE).

---
