# Context: visual

Visual system — themes, fonts, wallpapers, and the ownership of the configs that apply them.

## Redwall

The selected wallpaper with live machine state drawn over it. The artwork underneath is unchanged — Redwall composes on top of it, never in place of it. It reaches two surfaces from one image: the desktop background and the lock screen. What it carries is state a person reads at a glance without unlocking — active Workers, queue and capacity, GitHub budget, agent usage (compact — the detail lives in `doctor`), the address this machine answers on, and the current year's progress. Year progress is a week-column grid of day squares plus a continuous bar; elapsed days use the theme signal, today uses strong ink, and future days stay muted.

A Redwall is derived, never authored: the wallpaper is the source and the Redwall is regenerated whenever the state it displays changes. It therefore lives apart from the wallpapers, which are immutable per theme and content-addressed; a Redwall that shared that directory would make "retired" and "chosen by hand" indistinguishable to the sweep.

Wallpaper follows the colour theme by default but may be pinned independently to any of the six embedded Red artworks or to an imported image. Imports accept absolute native paths (including Windows drive paths from WSL) and HTTPS URLs, convert anything that is not a PNG with a converter the machine already has (ImageMagick, ffmpeg, GdkPixbuf, System.Drawing), validate and bound the bytes, then copy them under a content-addressed name in red-dev's managed image root. **Keeping the current wallpaper** — the first-run Wallpaper page's `current`, or `red-dev wallpaper current` — is the same import applied to whatever the desktop shows, so the theme can move while the picture stays and Redwall composes over it (decision of 2026-09-03); an image that is already red-dev's own resolves to the preference that produces it, and a Redwall is never re-imported. Only `custom:<sha256>` is persisted: source paths and URL query strings are deliberately forgotten. The pin survives theme changes; both the plain wallpaper surface and Redwall resolve through the same managed choice. Clearing the pin returns to following the theme. The original external file remains externally owned and is never swept; imported copies are removed when superseded or uninstalled.

Redwall is part of the default desktop experience. A missing preference means on; boolean `false` is the durable opt-out and later converges preserve it.

## Config ownership modes

Every configuration file touched by an adapter declares a mode: `owned` (red-dev owns and converges it), `merged` (red-dev manages only explicitly-owned fields), `adopted` (pre-existing; red-dev took over management with consent and a plan), or `external` (red-dev never touches it; at most themes it when present). Editors follow the *adoptable starter* model: install when absent, never overwrite what exists.

## User layer

For every `owned` file, a companion the person authors that red-dev loads after its own and never writes: what `alacritty.toml` already is to the regenerated `keys.toml`, and what `~/.config/red-dev/env.sh` is to the shipped bash. Where the program has no include mechanism (zellij), red-dev composes base + user layer into the file it owns rather than asking the person to edit the generated one. It is Omarchy's clone-to-override without a plugin system: a converge may replace everything red-dev wrote and must leave the layer untouched (decision of 2026-08-15). Each owned surface names its layer: bash's is `~/.config/red-dev/env.sh`, Alacritty's is `alacritty.toml`, and zellij's is `config.user.kdl` beside the `config.kdl` red-dev composes it into.

_Avoid_: override file, local config, dotfile (too broad), plugin
