# red-dev

One development environment across five targets, with the same experience on each.

|                         | Ubuntu 24.04 | Ubuntu 26.04 |
| ----------------------- | ------------ | ------------ |
| **Desktop, bare metal** | target 1     | target 2     |
| **WSL**                 | target 4     | target 5     |
| **Windows, native**     | target 3 (no distro axis)   ||

## Credit

**This project is inspired by, and derived from, [Omakub](https://omakub.org) by
[David Heinemeier Hansson](https://dhh.dk) and Basecamp.** Omakub is the original
idea and it deserves the credit: the omakase philosophy, the curated tool
selection, the aliases, the minimal prompt, the LazyVim setup, the theme system —
all of it started there. If you run Ubuntu 24.04 on the desktop, use Omakub. It
is excellent and it is the real thing.

red-dev exists for one reason: Omakub targets Ubuntu 24.04 desktop, and we needed
the same environment on Ubuntu 26.04, on WSL and on native Windows as well.
Where this project disagrees with Omakub, it is about portability, never about
taste.

Also built on [tuiuiu.js](https://github.com/forattini-dev/tuiuiu.js) for the
interactive layer.

## What "same experience" means here

The **terminal layer is identical everywhere**: the same CLI tools, aliases,
prompt, keybindings, Neovim config and theme. That is the layer you actually
live in, and it is the promise this project keeps.

The **desktop layer cannot be identical**, and pretending otherwise produces
software that lies. GNOME extensions, window-manager shortcuts and `.deb` GUI
apps exist on bare-metal Ubuntu and nowhere else. On Windows the equivalent is
winget and the OS's own settings; under WSL the GUI belongs to the host. The
manifest marks these boundaries explicitly — every `skip` carries a reason.

## Design

Two axes, not five cases. Code branches on **where it runs** (`env`) and **what
that place can do** (`caps`), never on a raw version string. Adding Ubuntu 28
should mean touching `src/platform.ts` and the manifest, nothing else.

- `src/platform.ts` — detection: os, distro, version, env, capabilities
- `src/manifest.ts` — the typed list of what to install, per platform
- `src/providers.ts` — apt, winget, GitHub releases, scripts
- `src/ui.ts` — interactive menus, compiled in
- `config/` — shell dotfiles, shipped as-is and sourced by your shell

The orchestrator is TypeScript compiled with [bun](https://bun.sh) to a
standalone binary, so **native Windows needs no bash**. The dotfiles stay shell,
because your shell sources them.

Omakub shells out to [gum](https://github.com/charmbracelet/gum) for prompts.
That means the UI cannot be drawn until gum is installed — which is precisely
why a broken gum download aborts the whole install before showing a single
screen. Compiling the interface into the binary removes that bootstrap
dependency: red-dev can always draw its own interface, including the screen that
reports a failed install.

## Usage

```
red-dev                      # interactive menu
red-dev platform             # what red-dev thinks this machine is
red-dev plan [scope]         # what would change, changes nothing
red-dev install [scope]      # converge toward the manifest
red-dev install --dry-run    # print the plan, touch nothing
red-dev update               # upgrade what the package managers own
red-dev theme <name>         # tokyo-night | catppuccin | gruvbox
red-dev doctor               # report drift
```

Global options: `--theme`, `--font` (`firacode`, `jetbrainsmono`, `hack`,
`caskaydiacove`).

Arguments are declared as a schema with
[cli-args-parser](https://www.npmjs.com/package/cli-args-parser), so an unknown
option, an invalid scope or an unknown theme is rejected before any provider
runs — the cheapest place to fail.

Every provider is idempotent. Re-running after a partial failure is the normal
recovery path, not an edge case.

## The WSL scope

Under WSL the terminal, the fonts and the GUI belong to Windows. Installing a
Nerd Font into the distro accomplishes nothing: the glyphs are drawn on the
other side of the boundary. So the `wsl` scope runs inside Ubuntu and acts on
the host — installing the font into the Windows per-user font store (no
administrator rights needed) and patching Windows Terminal's `settings.json`.

That patch preserves everything it does not own. Your keybindings, actions and
extra profiles are yours; red-dev touches the colour scheme, the font, the
default profile and the starting directory, and writes a backup first, because
a malformed `settings.json` makes Windows Terminal silently fall back to
defaults and lose your configuration.

The starting directory is set to your home *inside* the distro. Without it the
profile opens in the Windows working directory, which puts you under `/mnt/c` —
the slow path across the 9p boundary, where `npm ci` and `bundle install` crawl.

## Bugs inherited from the WSL forks, fixed here

Porting surfaced three real defects in the community WSL forks of Omakub. None
of these are Omakub's fault — they are what happens when a desktop-shaped tool
is bent toward WSL. Each became a design rule here.

**Pinned version behind a `latest` URL.** `omakub-wsl` pins gum to `0.14.1` but
downloads from `/releases/latest/download/gum_0.14.1_amd64.deb`. The path
resolves to whatever is newest while the filename still says `0.14.1`, so it
404s the moment upstream ships a release — and `set -e` aborts the whole
install. Here, `gh:` providers match a glob against the asset names a release
actually publishes, and fail loudly listing the candidates.

**PATH replacement kills WSL interop.** Upstream does
`export PATH="<fixed list>"`, discarding the ~20 `/mnt/c` entries WSL injects.
`winget.exe`, `explorer.exe` and `code.exe` stop resolving, which breaks the
very host access the WSL target depends on. `config/bash/path.sh` prepends and
dedupes instead of replacing.

**A prompt that is shipped but never loaded.** `defaults/bash/rc` sources
`shell`, `aliases` and `init`, omitting `prompt`. The repo looks complete; the
machine gets no prompt. `config/bash/rc.sh` sources it explicitly.

And one from Windows itself: commands installed from the Microsoft Store —
`winget` among them — are `APPEXECLINK` reparse points that `stat` reports as
absent. Detection uses `where.exe` rather than stat-ing PATH entries.

## Status

Early, but the whole loop runs.

- Working: `platform`, `plan`, `doctor`, `menu`, `install`, `update`, `theme`
- Providers: apt, winget, GitHub releases, and builtins for the WSL scope
- Verified on WSL Ubuntu 24.04 and native Windows from one source tree
- Not written yet: the `script:` providers (`fastfetch`, `mise`, `neovim`,
  `docker`, `github-cli` still lean on upstream install scripts), theme
  application to Neovim and Alacritty, and the whole `desktop` scope on real
  bare-metal Ubuntu — it is implemented but has never run on one

## License

MIT.
