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

# Windows programs that print shell code print Windows paths with it.
#
# Every activation below runs a native .exe under Git Bash, and the .exe
# cannot tell that the bash asking is an MSYS one. mise rewrites PATH
# outright — semicolons, backslashes, drive letters — and carapace
# prepends its own bin directory in the same spelling. bash splits PATH
# on ':', so `C:\Users\...` becomes the entry `C` followed by
# `\Users\...`, the list collapses, and every tool on it stops
# resolving: grep, sed, zellij, and the `command -v` guards in the rest
# of this file along with them.
#
# So the repair is a function rather than a line, because it has to run
# more than once: right after mise, or nothing below can be found at
# all, and again at the end for whatever the later activations added.
#
# cygpath is the way back, and it is resolved before any of them: it
# lives in /usr/bin, one of the directories that goes missing.
if [ "${RED_ENV:-}" = "windows" ]; then
  _RED_CYGPATH=$(command -v cygpath 2>/dev/null)
fi

_red_fix_path() {
  [ "${RED_ENV:-}" = "windows" ] || return 0
  [ -n "${_RED_CYGPATH:-}" ] || return 0

  # Assigned only when it produced something. A cygpath that fails would
  # otherwise hand back an empty string and take PATH with it, which is
  # a worse shell than the mangled one being repaired.
  _red_posix_path=$("$_RED_CYGPATH" -p "$PATH" 2>/dev/null)
  if [ -n "$_red_posix_path" ]; then
    PATH="$_red_posix_path"
    export PATH
  fi
  unset _red_posix_path
}

if command -v mise >/dev/null 2>&1; then
  eval "$(mise activate bash)"
  _red_fix_path
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
#
# Two spellings of the integration, and the split is load-bearing: the
# plain `bash` one parses carapace's reply with `read -d ''` on a \x01
# delimiter, and \x01 is also ble.sh's internal escape marker — under an
# attached ble.sh every Tab press prints `read: not a valid identifier`
# twice and interleaves the candidates with the error text. carapace
# ships `bash-ble` for exactly this, so choose by BLE_VERSION, which
# rc.sh has already set by loading ble.sh --noattach before this file.
if command -v carapace >/dev/null 2>&1; then
  export CARAPACE_BRIDGES='zsh,fish,bash,inshellisense'
  # shellcheck disable=SC1090  # process substitution; nothing to follow
  if [ -n "${BLE_VERSION-}" ]; then
    source <(carapace _carapace bash-ble) 2>/dev/null || true
  else
    source <(carapace _carapace bash) 2>/dev/null || true
  fi
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

# Once more, for whatever the activations above prepended.
#
# carapace is the one that made this necessary: it adds its own bin
# directory, in Windows spelling, after mise has already been repaired —
# so a single fix left one entry reading
# `/Users/.../carapace/bin;/c/.../mise/installs/bun/1.3.14/bin`, two
# directories glued into one that is neither.
_red_fix_path
unset -f _red_fix_path
unset _RED_CYGPATH

export EDITOR="nvim"
export SUDO_EDITOR="nvim"
