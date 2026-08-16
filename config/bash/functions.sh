# Shell functions.
#
# Omakub keeps these in defaults/bash/functions, written for a GNOME
# desktop. Roughly half of them only make sense there: app2folder pokes
# gsettings, iso2sd writes to a block device. Sourcing those
# unconditionally under WSL or on a server puts commands in your shell
# that cannot work, so they are guarded.

# ------------------------------------------------------ everywhere

compress() { tar -czf "${1%/}.tar.gz" "${1%/}"; }

# Make a directory and enter it.
mkcd() { mkdir -p "$1" && cd "$1" || return; }

# Fuzzy-find a file and open it in the editor.
fe() {
  local file
  file=$(fzf --preview 'batcat --style=numbers --color=always {} 2>/dev/null || cat {}') || return
  [ -n "$file" ] && "${EDITOR:-nvim}" "$file"
}

# Fuzzy-find a directory and cd into it.
fcd() {
  local dir
  dir=$(find . -type d -not -path '*/.git/*' 2>/dev/null | fzf) || return
  [ -n "$dir" ] && cd "$dir" || return
}

# Open the file manager and land in whatever directory you left it in.
#
# This is the whole point of yazi as a shell integration rather than
# just a binary: a child process cannot change its parent's directory,
# so yazi writes the final path to a file and the shell reads it back.
# Without this you browse somewhere and then have to cd there by hand.
if command -v yazi >/dev/null 2>&1; then
  y() {
    local tmp cwd
    tmp="$(mktemp -t yazi-cwd.XXXXXX)"
    yazi "$@" --cwd-file="$tmp"
    if cwd="$(cat -- "$tmp" 2>/dev/null)" && [ -n "$cwd" ] && [ "$cwd" != "$PWD" ]; then
      builtin cd -- "$cwd" || return
    fi
    rm -f -- "$tmp"
  }
fi

# Convert webm (what most screen recorders produce) to a widely playable mp4.
webm2mp4() {
  local input_file="$1"
  local output_file="${input_file%.webm}.mp4"
  ffmpeg -i "$input_file" -c:v libx264 -preset slow -crf 22 -c:a aac -b:a 192k "$output_file"
}

# ----------------------------------------------------- desktop only

if [ "${RED_ENV:-}" = "desktop" ]; then
  # Write an iso to a block device.
  iso2sd() {
    if [ $# -ne 2 ]; then
      echo "Usage: iso2sd <input_file> <output_device>"
      echo -e "\nAvailable devices:"
      lsblk -d -o NAME | grep -E '^sd[a-z]' | awk '{print "/dev/"$1}'
    else
      sudo dd bs=4M status=progress oflag=sync if="$1" of="$2"
      sudo eject "$2"
    fi
  }
fi

# web2app and web2app-remove used to live here, ported from omakub.
#
# They are gone rather than kept beside the real thing. The function
# hard-coded google-chrome, so on a machine with chromium and nothing
# else it wrote a launcher that opens nothing; it existed only under
# RED_ENV=desktop, so the same page could not be asked for on the
# Windows half of the same setup; and its remove derived the icon path
# from the app name a second time, which took the wrong file whenever
# the two spellings disagreed.
#
# `red-dev apps` offers the same pages and any URL you type, resolves
# whichever Chromium-family browser is actually installed, writes a
# Start Menu shortcut on native Windows, and states the reason under
# WSL instead of writing a .desktop file nothing there reads.

# --------------------------------------------------------- wsl only

if [ "${RED_ENV:-}" = "wsl" ]; then
  # Open the current directory in Windows Explorer.
  winopen() { explorer.exe "${1:-.}"; }

  # Translate a path for pasting into a Windows program.
  winpath() { wslpath -w "${1:-.}"; }
fi

# ----------------------------------------------- native Windows only

# Git Bash / MSYS2. Same commands as the WSL bridge above so muscle
# memory carries across, but the path translation tool differs:
# wslpath does not exist here, cygpath does.
if [ "${RED_ENV:-}" = "windows" ]; then
  winopen() { explorer.exe "$(cygpath -w "${1:-.}")"; }
  winpath() { cygpath -w "${1:-.}"; }
fi
