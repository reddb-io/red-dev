# Entry point sourced from ~/.bashrc:
#
#   source ~/.local/share/red-dev/config/bash/rc.sh
#
# Order matters: path before init (activation needs the tools on PATH),
# init before aliases (aliases probe for what actually got installed),
# prompt last so nothing downstream clobbers PS1.

RED_ROOT="${RED_ROOT:-$HOME/.local/share/red-dev}"
export RED_ROOT

# Cheap inline detection. The `red` binary does this properly, but the
# shell config must not depend on the binary being installed or on
# PATH being correct yet — this file runs before either is guaranteed.
if [ -z "${RED_ENV:-}" ]; then
  case "$(uname -s 2>/dev/null)" in
    # Git Bash, MSYS2 and Cygwin are bash on *native* Windows, not WSL
    # and not a Linux desktop. Without this branch they fall through to
    # "server" and the Windows-specific bridges never load.
    MINGW*|MSYS*|CYGWIN*)
      RED_ENV="windows"
      ;;
    *)
      if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
        RED_ENV="wsl"
      elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
        RED_ENV="desktop"
      else
        RED_ENV="server"
      fi
      ;;
  esac
  export RED_ENV
fi

# Choices recorded by `red-dev install`, as plain shell.
#
# A separate file rather than a value baked into this one: this file is
# regenerated on every converge, and an answer that a regeneration
# discards is not a recorded answer. JSON would need a parser that is
# not guaranteed to exist this early.
if [ -r "$HOME/.config/red-dev/env.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.config/red-dev/env.sh"
fi

# ble.sh, when opted in.
#
# It has to load before everything else and attach after everything
# else: it replaces bash's line editor rather than sitting beside it, so
# anything that binds keys must be in place between the two halves.
#
# Off by default because red-dev already ships atuin, fzf and carapace,
# all of which bind into the editor ble.sh replaces. Whether they
# survive is an empirical question answerable only from a real terminal.
# Set RED_BLE=1, confirm Ctrl-R still reaches atuin, and this default is
# worth flipping.
if [ "${RED_BLE:-0}" = "1" ] && [ -r "$HOME/.local/share/blesh/ble.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.local/share/blesh/ble.sh" --noattach
fi

# Readline settings. INPUTRC has to be exported before bash builds its
# line editor, which is why this sits ahead of the sourcing loop rather
# than inside init.sh.
if [ -r "$RED_ROOT/config/bash/inputrc" ]; then
  INPUTRC="$RED_ROOT/config/bash/inputrc"
  export INPUTRC
  bind -f "$INPUTRC" 2>/dev/null || true
fi

# The shared root: one directory, reachable from both sides.
#
# RED_SHARE_WIN holds it the way Windows spells it — `C:\Users\me\.reddev`
# — because that is the only spelling both environments can agree to
# store. Each side then translates, and there are three spellings rather
# than the two you would expect:
#
#   C:\Users\me\.reddev       PowerShell, and any GUI application
#   /c/Users/me/.reddev       Git Bash on native Windows
#   /mnt/c/Users/me/.reddev   WSL
#
# Translated here in shell rather than by calling wslpath, because this
# runs before PATH is built and cannot assume any binary exists yet.
if [ -n "${RED_SHARE_WIN:-}" ]; then
  _red_drive=$(printf '%s' "$RED_SHARE_WIN" | cut -c1 | tr '[:upper:]' '[:lower:]')
  # \134 is a backslash, spelled the one way that is unambiguous here.
  # `tr '\\' '/'` does the same thing and reads like an escaped quote to
  # anyone — shellcheck included — arriving at the line cold.
  _red_rest=$(printf '%s' "$RED_SHARE_WIN" | cut -c3- | tr '\134' '/')
  case "$RED_ENV" in
    windows) RED_SHARE="/${_red_drive}${_red_rest}" ;;
    wsl) RED_SHARE="/mnt/${_red_drive}${_red_rest}" ;;
    # A Linux desktop has no Windows drive to reach. Sharing with a
    # machine that is not there is not a thing, so this simply keeps
    # whatever was recorded and lets the guard below drop it.
    *) RED_SHARE="${RED_SHARE:-}" ;;
  esac
  unset _red_drive _red_rest
fi

# Dropped unless it is really there. A stale recorded root — a drive that
# did not mount, a distro moved — would otherwise point every tool below
# at a directory that does not exist, and each one fails differently.
if [ -n "${RED_SHARE:-}" ] && [ -d "$RED_SHARE" ]; then
  export RED_SHARE
else
  unset RED_SHARE
fi

# zellij sits between shared and init on purpose: after shared, which
# exports ZELLIJ_CONFIG_DIR, and before init, whose tool activations are
# the expensive part and would be paid twice — once by the shell zellij
# replaces, once by the shell inside the pane.
for _red_part in path shared zellij init aliases functions prompt; do
  _red_file="$RED_ROOT/config/bash/${_red_part}.sh"
  if [ -r "$_red_file" ]; then
    # shellcheck disable=SC1090
    . "$_red_file"
  fi
done
unset _red_part _red_file

# Attach last, after every keybinding above is registered. Guarded on
# BLE_VERSION so this is inert when ble.sh was never loaded.
if [ -n "${BLE_VERSION-}" ]; then
  ble-attach
fi
