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
#
# stderr goes to a file because a panic prints there and then the
# terminal scrolls it away, or zellij's own log truncates on the next
# start and takes the only other copy with it. The file is per-shell so
# two windows crashing at once do not overwrite each other, and it is
# deleted on the clean path, so what is on disk is only ever a failure.
#
# In a subdirectory, not beside the run transcripts src/transcript.ts
# keeps in this same state root. That code globs *.log and prunes all
# but the newest few by filename order — and `zellij-…` sorts after
# every timestamped name, so crash logs would read as the newest files
# there and evict real transcripts until `red-dev logs` showed nothing
# else. A directory entry does not end in .log, so both the listing and
# the prune skip this whole tree.
_red_zellij_log="${XDG_STATE_HOME:-$HOME/.local/state}/red-dev/zellij/crash-$$.log"
mkdir -p "${_red_zellij_log%/*}" 2>/dev/null
if declare -F _red_dev_run_control >/dev/null 2>&1; then
  RED_IN_ZELLIJ=1 _red_dev_run_control zellij 2>"$_red_zellij_log"
  _red_zellij_status=$?
elif [ "${RED_ENV:-server}" = "windows" ]; then
  RED_IN_ZELLIJ=1 zellij 2>"$_red_zellij_log"
  _red_zellij_status=$?
else
  printf 'red-dev: control-plane guard is unavailable; refusing uncontained zellij\n' \
    >"$_red_zellij_log"
  _red_zellij_status=125
fi

if [ "$_red_zellij_status" -eq 0 ]; then
  rm -f "$_red_zellij_log"
  unset _red_zellij_status _red_zellij_log
  # The session ended normally, so the terminal is done — same as if
  # zellij had replaced this shell to begin with.
  exit 0
fi

# Undo what zellij turned on and did not turn off.
#
# zellij starts by sending ESC[>1u, ESC[?1049h, ESC[?2031h and the five
# mouse-tracking modes, and unsets every one of them on its way out. A
# panic — exit 101, the common failure here — skips that, and the shell
# below inherits a terminal still in all of those states: the kitty
# keyboard protocol encodes Esc as ESC[27u and Ctrl+Backspace as
# ESC[8;5u, which readline does not parse, so it eats the ESC[ and
# leaves `27u` and `8;5u` on the command line; ESC[?1003h means moving
# the mouse over the window types too; and ESC[?1049h keeps the shell in
# the alternate buffer, still wearing the background zellij painted.
#
# Every sequence below turns something off, so sending them to a
# terminal that was never in those states costs nothing — including the
# kitty pop, which is defined as a no-op on an empty stack. That matters
# because this branch is also reached by a zellij that died before it
# sent anything at all.
printf '\033[<u\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?1015l\033[?2031l\033[?1049l\033[?25h\033[0m'

printf 'red-dev: zellij exited %s — continuing as a plain shell\n' "$_red_zellij_status" >&2
if [ -s "$_red_zellij_log" ]; then
  printf 'red-dev: what zellij printed on its way out is in %s\n' "$_red_zellij_log" >&2
else
  rm -f "$_red_zellij_log"
fi
printf 'red-dev: set RED_ZELLIJ=0 in ~/.config/red-dev/env.sh to stop trying\n' >&2
unset _red_zellij_status _red_zellij_log
