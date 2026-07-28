# red-dev

One development environment across five targets, with the same experience on each.

|                        | Ubuntu 24.04 | Ubuntu 26.04 |
| ---------------------- | ------------ | ------------ |
| **Desktop, bare metal**| target 1     | target 2     |
| **WSL**                | target 4     | target 5     |
| **Windows, native**    | target 3 (no distro axis)   ||

Descended from [Omakub](https://omakub.org), which targets Ubuntu 24.04 desktop only.

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
- `config/` — shell dotfiles, shipped as-is and sourced by your shell

The orchestrator is TypeScript compiled to a standalone binary, so **native
Windows needs no bash**. The dotfiles stay shell, because your shell sources
them.

## Usage

```
red platform     # what red thinks this machine is
red plan         # what would change, changes nothing
red install      # converge toward the manifest
red doctor       # report drift
```

Every provider is idempotent. Re-running after a partial failure is the normal
recovery path, not an edge case.

## Bugs inherited from upstream, fixed here

Building this surfaced three real defects in the omakub WSL forks. They are
worth stating because each one shaped a design rule.

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

## Status

Early. `platform`, `plan` and `doctor` work; `install` covers apt, winget and
GitHub-release providers. Provider scripts and the Windows Terminal / Nerd Font
work for the WSL scope are not written yet.
