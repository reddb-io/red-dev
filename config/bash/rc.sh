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
  if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
    RED_ENV="wsl"
  elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    RED_ENV="desktop"
  else
    RED_ENV="server"
  fi
  export RED_ENV
fi

# Readline settings. INPUTRC has to be exported before bash builds its
# line editor, which is why this sits ahead of the sourcing loop rather
# than inside init.sh.
if [ -r "$RED_ROOT/config/bash/inputrc" ]; then
  INPUTRC="$RED_ROOT/config/bash/inputrc"
  export INPUTRC
  bind -f "$INPUTRC" 2>/dev/null || true
fi

for _red_part in path init aliases functions prompt; do
  _red_file="$RED_ROOT/config/bash/${_red_part}.sh"
  if [ -r "$_red_file" ]; then
    # shellcheck disable=SC1090
    . "$_red_file"
  fi
done
unset _red_part _red_file
