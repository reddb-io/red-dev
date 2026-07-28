# Shell functions.
#
# Omakub keeps these in defaults/bash/functions, written for a GNOME
# desktop. Roughly half of them only make sense there: web2app builds a
# .desktop launcher, app2folder pokes gsettings, iso2sd writes to a
# block device. Sourcing those unconditionally under WSL or on a server
# puts commands in your shell that cannot work, so they are guarded.

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

  # Create a desktop launcher that opens a URL as its own windowed app.
  web2app() {
    if [ "$#" -ne 3 ]; then
      echo "Usage: web2app <AppName> <AppURL> <IconURL>   (icon must be PNG)"
      return 1
    fi
    local APP_NAME="$1" APP_URL="$2" ICON_URL="$3"
    local ICON_DIR="$HOME/.local/share/applications/icons"
    local DESKTOP_FILE="$HOME/.local/share/applications/${APP_NAME}.desktop"
    local ICON_PATH="${ICON_DIR}/${APP_NAME}.png"

    mkdir -p "$ICON_DIR"
    curl -sL -o "$ICON_PATH" "$ICON_URL" || { echo "icon download failed"; return 1; }

    cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Version=1.0
Name=$APP_NAME
Comment=$APP_NAME
Exec=google-chrome --app="$APP_URL" --name="$APP_NAME" --class="$APP_NAME"
Terminal=false
Type=Application
Icon=$ICON_PATH
Categories=GTK;
StartupNotify=true
EOF
    chmod +x "$DESKTOP_FILE"
  }

  web2app-remove() {
    [ "$#" -eq 1 ] || { echo "Usage: web2app-remove <AppName>"; return 1; }
    rm -f "$HOME/.local/share/applications/${1}.desktop"
    rm -f "$HOME/.local/share/applications/icons/${1}.png"
  }
fi

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
