# Zellij as the session, not as a command you remember to type.
#
# omakub gets this by pointing Alacritty's shell at zellij:
#
#   [shell]
#   program = "zellij"
#
# That works where the terminal and the multiplexer are the same
# machine's programs, which is true on exactly one of our four targets.
# Under WSL and under Git Bash the terminal is a Windows program and
# zellij is not, and Windows Terminal, the VS Code terminal and every ssh
# session never read Alacritty's config at all.
#
# The shell is the one layer all four share. Starting zellij from here
# means one behaviour on Linux, macOS, native Windows and WSL, in the
# terminals red-dev configures and the ones it does not — and on the far
# end of an ssh connection, which no terminal config can reach.
#
# Sourced after shared.sh, which exports ZELLIJ_CONFIG_DIR when a shared
# root holds the config, and before init.sh, so the shell that is about
# to be replaced never pays for mise, atuin, carapace and direnv.
#
# Turn it off with RED_ZELLIJ=0 in ~/.config/red-dev/env.sh.

if [ "${RED_ZELLIJ:-1}" != "1" ]; then
  return 0
fi

# Already inside one.
#
# zellij starts bash, which sources ~/.bashrc, which arrives back here —
# so this guard is what stands between a terminal and an infinite stack
# of multiplexers. Three checks rather than one because two of them are
# upstream's to rename: ZELLIJ and ZELLIJ_SESSION_NAME are zellij's own
# (verified: a pane gets ZELLIJ=0), and RED_IN_ZELLIJ is ours and cannot
# be taken away.
if [ -n "${RED_IN_ZELLIJ:-}" ] || [ -n "${ZELLIJ:-}" ] || [ -n "${ZELLIJ_SESSION_NAME:-}" ]; then
  return 0
fi

# Interactive shells attached to a terminal, and nothing else. A script,
# an scp, a `bash -c` from an editor or an agent must see the shell it
# asked for.
case $- in
  *i*) ;;
  *) return 0 ;;
esac

if [ ! -t 0 ] || [ ! -t 1 ]; then
  return 0
fi

# Terminals that embed a shell inside something else. Each of these
# either draws its own UI around the shell or expects to parse what
# comes back, and a full-screen multiplexer breaks both.
if [ -n "${TMUX:-}" ] ||
  [ -n "${NVIM:-}" ] ||
  [ -n "${VIM_TERMINAL:-}" ] ||
  [ -n "${INSIDE_EMACS:-}" ] ||
  [ "${TERM_PROGRAM:-}" = "vscode" ] ||
  [ "${TERMINAL_EMULATOR:-}" = "JetBrains-JediTerm" ] ||
  [ "${TERM:-dumb}" = "dumb" ] ||
  [ "${TERM:-}" = "linux" ]; then
  return 0
fi

if ! command -v zellij >/dev/null 2>&1; then
  return 0
fi

# Deliberately not `exec`.
#
# A zellij that cannot start — a broken config, a shared root that did
# not mount, a Windows build that will not attach to an MSYS pty — would
# take the terminal down with it on every single window, and the way out
# of that is to edit a dotfile in a terminal you no longer have. Falling
# back to a plain shell costs one extra bash per window, about three
# megabytes, and cannot lock anyone out of their own machine.
#
# RED_IN_ZELLIJ is set on the command rather than exported, so the
# fallback shell below is not left claiming to be inside a session.
RED_IN_ZELLIJ=1 zellij
_red_zellij_status=$?

if [ "$_red_zellij_status" -eq 0 ]; then
  unset _red_zellij_status
  # The session ended normally, so the terminal is done — same as if
  # zellij had replaced this shell to begin with.
  exit 0
fi

printf 'red-dev: zellij exited %s — continuing as a plain shell\n' "$_red_zellij_status" >&2
printf 'red-dev: set RED_ZELLIJ=0 in ~/.config/red-dev/env.sh to stop trying\n' >&2
unset _red_zellij_status
