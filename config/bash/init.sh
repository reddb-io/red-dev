# Tool activation. Each block is guarded so a partial install still
# yields a working shell — a half-provisioned machine must not leave you
# without a prompt.

# History
shopt -s histappend
HISTCONTROL=ignoreboth
HISTSIZE=32768
HISTFILESIZE="${HISTSIZE}"

# Write history as it happens rather than at exit, so two terminals
# open at once do not overwrite each other's history.
PROMPT_COMMAND="history -a${PROMPT_COMMAND:+; $PROMPT_COMMAND}"

# Navigation and globbing. These are off by default in bash and are a
# large part of what people actually mean when they say zsh feels
# nicer. They cost nothing: no dependency, no startup time.
shopt -s autocd 2>/dev/null      # `src` instead of `cd src`
shopt -s cdspell 2>/dev/null     # fix small typos in cd targets
shopt -s dirspell 2>/dev/null    # ...and in directory completion
shopt -s globstar 2>/dev/null    # ** matches across directories
shopt -s direxpand 2>/dev/null   # expand variables in path completion
shopt -s checkwinsize            # keep $LINES/$COLUMNS honest after resize
shopt -s cmdhist                 # keep a multi-line command on one history line
shopt -s no_empty_cmd_completion # do not scan $PATH on an empty tab

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

# Completions for hundreds of CLIs, generated rather than hand-written.
# This is the closest bash gets to zsh's completion system.
if command -v carapace >/dev/null 2>&1; then
  export CARAPACE_BRIDGES='zsh,fish,bash,inshellisense'
  source <(carapace _carapace bash) 2>/dev/null || true
fi

# Shareable, searchable shell history. Replaces Ctrl-R with something
# that can actually find the command you half-remember.
if command -v atuin >/dev/null 2>&1; then
  eval "$(atuin init bash --disable-up-arrow)"
fi

# Per-directory environment.
if command -v direnv >/dev/null 2>&1; then
  eval "$(direnv hook bash)"
fi

export EDITOR="nvim"
export SUDO_EDITOR="nvim"
