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

# Git.
#
# oh-my-zsh ships around 150 of these. Most are never typed. This is the
# subset that earns its place, keeping omakub's names where it has one
# so muscle memory carries over from an Omakub machine.
alias g='git'
alias gst='git status --short --branch'
alias gd='git diff'
alias gds='git diff --staged'
alias ga='git add'
alias gaa='git add --all'
alias gcm='git commit -m'
alias gcam='git commit -a -m'
alias gcad='git commit -a --amend'
alias gca='git commit --amend --no-edit'
alias gco='git checkout'
alias gcb='git checkout -b'
alias gsw='git switch'
alias gb='git branch'
alias gp='git push'
alias gpf='git push --force-with-lease'   # never --force; this one refuses to clobber
alias gpl='git pull --rebase'
alias gf='git fetch --all --prune'
alias glg='git log --oneline --graph --decorate -20'
alias gll='git log --oneline --graph --decorate --all'
alias gsta='git stash push'
alias gstp='git stash pop'
alias grb='git rebase'
alias grbi='git rebase -i'
alias grbc='git rebase --continue'
alias gwt='git worktree'

# Show what changed on the current branch versus its merge base.
gdm() { git diff "$(git merge-base HEAD "${1:-main}")"..HEAD; }

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
