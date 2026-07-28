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

force_color_prompt=yes
color_prompt=yes

# starship owns the prompt when it is installed. It has to win, not
# merge: two things writing PS1 produces a prompt that is neither.
# Without it we fall through to omakub's minimal glyph below.
if command -v starship >/dev/null 2>&1; then
  eval "$(starship init bash)"
  return 0 2>/dev/null || true
fi

# Set RED_PROMPT=plain to opt out of the glyph, e.g. on a machine where
# you cannot install fonts.
if [ "${RED_PROMPT:-glyph}" = "plain" ]; then
  PS1='\w $ '
else
  PS1=$' '
fi

# Keep the working directory in the terminal/tab title. The minimal
# prompt drops the cwd, so the title bar is where it lives.
PS1="\[\e]0;\w\a\]$PS1"

export PS1
