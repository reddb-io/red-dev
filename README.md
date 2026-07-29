<div align="center">

<img src="docs/hero.svg" alt="red-dev — one development environment across Ubuntu 24.04, Ubuntu 26.04, WSL and native Windows" width="100%">

<p>
  <a href="https://github.com/reddb-io/red-dev/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/reddb-io/red-dev/release.yml?branch=main&style=for-the-badge&label=CI&labelColor=0d1117" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge&labelColor=0d1117" alt="License"></a>
  <a href="#the-support-matrix"><img src="https://img.shields.io/badge/targets-ubuntu%2024%20%7C%2026%20%7C%20wsl%20%7C%20windows-ff2056?style=for-the-badge&labelColor=0d1117" alt="Targets"></a>
  <a href="#what-ships"><img src="https://img.shields.io/badge/stack-alacritty%20%7C%20zellij%20%7C%20bash-8b949e?style=for-the-badge&labelColor=0d1117" alt="Stack"></a>
</p>

<strong>One development environment. Five targets. The same experience on each.</strong><br>
red-dev installs the same tools, shell, terminal, tiling and theme on bare-metal
Ubuntu, on WSL, and on native Windows — from a single binary that needs no
runtime, no bash on Windows, and no second configuration to keep in sync.

</div>

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

Two axes, not five cases. Code branches on **where it runs** (`env`) and **what
that place can do** (`caps`), never on a raw version string. Adding Ubuntu 28
should mean touching `src/platform.ts` and the manifest, nothing else.

---

## Install

Linux and WSL:

```bash
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-dev/main/boot.sh | sh
```

Native Windows:

```powershell
irm https://raw.githubusercontent.com/reddb-io/red-dev/main/boot.ps1 | iex
```

Both resolve the binary for your platform from the latest release, install it
under your own user, and converge. Neither needs administrator or root rights
for red-dev itself; individual packages may still ask for sudo.

> [!NOTE]
> No release has been cut yet. Until the first `v*` tag is pushed, both
> bootstraps stop with `red-dev has no published releases yet` — which is the
> message they are supposed to give, rather than a 404.

---

## What ships

### The identical layer

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
what makes the shipped dotfiles apply there at all.

### The tools

`git` · `curl` · `ripgrep` · `fd` · `bat` · `eza` · `zoxide` · `fzf` · `btop` ·
`jq` · `fastfetch` · `gh` · `lazygit` · `lazydocker` · `zellij` · `mise` ·
`neovim` · `docker` · `delta` · `yazi` · `tldr` · `starship` · `atuin` ·
`carapace` · `direnv`

### The shell

Aliases that normalise Debian's renames (`bat` → `batcat`, `fd` → `fdfind`), the
readline bindings that put history search on the arrow keys, `autocd`, `cdspell`,
`globstar`, a curated git alias set, and the integrations that make the tools
above actually do something: git pointed at `delta`, `y()` for yazi, `atuin`
bound to history, `carapace` completions, `direnv` hooked.

### Themes

`tokyo-night` · `catppuccin` · `gruvbox`

A theme reaches the terminal, the multiplexer, the system monitor, the editor and
the desktop wallpaper — not just the terminal background.

```bash
red-dev theme gruvbox
```

Wallpapers are **generated from the palette**, not shipped as photographs: no
licensing question, an exact match to the theme, and no download.

---

## Usage

```bash
red-dev                      # interactive menu
red-dev platform             # what red-dev thinks this machine is
red-dev plan [scope]         # what would change, changes nothing
red-dev install [scope]      # converge toward the manifest
red-dev install --dry-run    # print the plan, touch nothing
red-dev update               # upgrade what the package managers own
red-dev theme <name>         # tokyo-night | catppuccin | gruvbox
red-dev doctor               # report drift
```

Scopes are `core` (every target), `desktop` (a machine with a display), and
`wsl` (runs in the distro, acts on the Windows host). Global options: `--theme`,
`--font`, `--opacity`.

Every provider is idempotent. Re-running after a partial failure is the normal
recovery path, not an edge case.

---

## Navigation

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

---

## Design

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

Every `skip` in the manifest carries a reason. A skip is a decision; one without
a reason is an undocumented gap wearing a decision's clothes.

---

## Bugs inherited from the WSL forks, fixed here

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
host access the WSL target depends on. `config/bash/path.sh` prepends and dedupes
instead of replacing.

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

---

## Develop

```bash
git clone git@github.com:reddb-io/red-dev.git
cd red-dev
bun install

bun test              # 33 tests over the decision logic
bunx tsc --noEmit
bun run build         # both binaries, cross-compiled from one host
```

`bun run build` produces `dist/red-dev-linux-x64` and
`dist/red-dev-windows-x64.exe` from the same source tree; the Windows target
needs no Windows runner. Two smoke tests gate the release, because the whole
distribution model rests on them: that the TUI and the embedded dotfiles both
survive `bun build --compile`.

---

## Status

Early, but the loop runs end to end.

- Working: `platform`, `plan`, `doctor`, `menu`, `install`, `update`, `theme`
- Providers: apt, ppa, apt repositories, winget, GitHub releases, and builtins
  for dotfiles, fonts, Alacritty, Windows Terminal and WSL interop
- Verified on WSL Ubuntu 24.04 and native Windows from one source tree, and on a
  freshly created user for the dotfiles path

Not done yet, in rough order of how much it matters:

- **No release has been cut**, so the install commands above do not work yet.
- **The `desktop` scope has never run.** It is implemented against bare-metal
  Ubuntu and no bare-metal Ubuntu has executed it. That is unknown, not "nearly
  done".
- **Ubuntu 26.04 is likewise untested.** The `u26` column exists; no 26.04 target
  has exercised it, so package-name drift is undiscovered.
- GNOME hotkeys, VS Code theming, `uninstall` and migrations are not ported.
- Native Windows gets no `ble.sh`-style line editor; that decision is open.

---

## License

[MIT](LICENSE).
