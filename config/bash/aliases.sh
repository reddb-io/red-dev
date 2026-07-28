# Aliases.
#
# This file is what actually delivers "same experience" across targets.
# Debian ships ripgrep as rg, bat as batcat and fd-find as fdfind, while
# Windows and upstream use the plain names. Without normalising here,
# muscle memory breaks the moment you move between targets.

# Normalise Debian's renames so the same command works everywhere.
if command -v batcat >/dev/null 2>&1 && ! command -v bat >/dev/null 2>&1; then
  alias bat='batcat'
fi
if command -v fdfind >/dev/null 2>&1 && ! command -v fd >/dev/null 2>&1; then
  alias fd='fdfind'
fi

# File system
if command -v eza >/dev/null 2>&1; then
  alias ls='eza -lh --group-directories-first --icons'
  alias lsa='ls -a'
  alias lt='eza --tree --level=2 --long --icons --git'
  alias lta='lt -a'
fi

alias ..='cd ..'
alias ...='cd ../..'
alias ....='cd ../../..'

# Tools
alias n='nvim'
alias g='git'
alias d='docker'
alias lzg='lazygit'
alias lzd='lazydocker'

# Git
alias gcm='git commit -m'
alias gcam='git commit -a -m'
alias gcad='git commit -a --amend'

if command -v fzf >/dev/null 2>&1; then
  if command -v batcat >/dev/null 2>&1; then
    alias ff="fzf --preview 'batcat --style=numbers --color=always {}'"
  elif command -v bat >/dev/null 2>&1; then
    alias ff="fzf --preview 'bat --style=numbers --color=always {}'"
  fi
fi

# compress() lives in functions.sh; this is its counterpart.
alias decompress='tar -xzf'

# WSL only: bridge to the host. These are the commands that upstream's
# PATH replacement was quietly breaking.
if [ "${RED_ENV:-}" = "wsl" ]; then
  command -v explorer.exe >/dev/null 2>&1 && alias open='explorer.exe'
  command -v clip.exe >/dev/null 2>&1 && alias pbcopy='clip.exe'
fi
