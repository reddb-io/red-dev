# Tool activation. Each block is guarded so a partial install still
# yields a working shell — a half-provisioned machine must not leave you
# without a prompt.

# History
shopt -s histappend
HISTCONTROL=ignoreboth
HISTSIZE=32768
HISTFILESIZE="${HISTSIZE}"

# Completion
if [ -r /usr/share/bash-completion/bash_completion ]; then
  # shellcheck disable=SC1091
  . /usr/share/bash-completion/bash_completion
fi

if command -v mise >/dev/null 2>&1; then
  eval "$(mise activate bash)"
fi

if command -v zoxide >/dev/null 2>&1; then
  eval "$(zoxide init bash)"
fi

if command -v fzf >/dev/null 2>&1; then
  # Ubuntu ships the keybindings in a docs path; newer fzf provides
  # `fzf --bash` instead. Try both rather than assuming a layout.
  if [ -r /usr/share/doc/fzf/examples/key-bindings.bash ]; then
    # shellcheck disable=SC1091
    . /usr/share/doc/fzf/examples/key-bindings.bash
  elif fzf --bash >/dev/null 2>&1; then
    eval "$(fzf --bash)"
  fi
fi

export EDITOR="nvim"
export SUDO_EDITOR="nvim"
