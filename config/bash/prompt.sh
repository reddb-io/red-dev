# Prompt.
#
# omakub-wsl ships this file but never sources it: defaults/bash/rc
# loads shell, aliases and init, and simply omits prompt. The result is
# a config that looks complete in the repo and does nothing on the
# machine. rc.sh here sources it explicitly.
#
# The glyph is a Nerd Font codepoint (nf-fa-long_arrow_right). It
# renders as an empty box without a Nerd Font installed, which is why
# the wsl scope installs one on the Windows host before this ever
# matters — under WSL the font belongs to the terminal, not the distro.

# Login shells used by agents and automation still pass through
# ~/.profile -> ~/.bashrc -> this file. They have no prompt to render,
# and the tool runner deliberately advertises that fact as TERM=dumb.
# Initialising starship there only emits an error before every command.
if [[ $- != *i* ]] || [ "${TERM:-dumb}" = "dumb" ]; then
  return 0
fi

if command -v starship >/dev/null 2>&1; then
  # The deadlines, and only where nobody else has spoken.
  #
  # starship's defaults assume a native filesystem: 500ms for a module
  # that runs a program and 30ms to scan the directory. A WSL machine
  # misses both routinely and starship says so above every prompt it
  # draws, which is how one component giving up looks like a terminal
  # where nothing works. shared.sh has already exported STARSHIP_CONFIG
  # if the shared root carries one, and a file the person wrote at
  # ~/.config/starship.toml is theirs — either wins over this, which is
  # a starter and not an owned file.
  if [ -z "${STARSHIP_CONFIG:-}" ] && [ ! -r "$HOME/.config/starship.toml" ]; then
    export STARSHIP_CONFIG="${RED_ROOT:-$HOME/.local/share/red-dev}/config/bash/starship.toml"
  fi

  # starship owns the prompt when present. It has to win outright, not
  # merge: two things writing PS1 produce a prompt that is neither.
  eval "$(starship init bash)"

elif [ "${RED_PROMPT:-glyph}" = "plain" ]; then
  # Opt-out for machines where a Nerd Font cannot be installed.
  PS1='\w $ '
  export PS1

else
  PS1=$' '
  # Keep the working directory in the terminal or tab title. The minimal
  # prompt drops the cwd, so the title bar is where it lives.
  PS1="\[\e]0;\w\a\]$PS1"
  export PS1
fi
