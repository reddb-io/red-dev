# The Linux desktop clipboard, chosen at the moment of the copy.
#
# Zellij runs copy_command with the selection on stdin and kills it one
# second later. This used to be `wl-copy` written straight into
# config.kdl, and that was right on exactly the machines whose converge
# had run under Wayland and whose every later login was Wayland too. An
# Xorg session — what GDM offers in its menu, and what some NVIDIA
# installs land on — has no compositor for wl-copy to reach, so the copy
# failed with nothing to see: zellij printed "Copied!" and the clipboard
# kept whatever it held before.
#
# So the tool is picked here, per copy, from what this session actually
# is. Wayland first, because a Wayland session usually also exports a
# DISPLAY for XWayland and xclip would put the text on the wrong
# clipboard; then X11; then a message, because a bridge that fails
# silently is the failure this file replaces.
#
# The selection is read into a variable before anything runs. Each tool
# is a separate process, and a first one that exits after draining stdin
# would leave nothing for the next; reading once and printing per attempt
# keeps the text whole for whichever tool takes it. The trailing marker
# preserves newlines at the end, which `$(...)` would otherwise strip.

_red_clip_data=$(cat; printf x)
_red_clip_data=${_red_clip_data%x}

if [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wl-copy >/dev/null 2>&1; then
  if printf '%s' "$_red_clip_data" | wl-copy 2>/dev/null; then
    exit 0
  fi
fi

if [ -n "${DISPLAY:-}" ]; then
  if command -v xclip >/dev/null 2>&1; then
    if printf '%s' "$_red_clip_data" | xclip -selection clipboard 2>/dev/null; then
      exit 0
    fi
  fi
  if command -v xsel >/dev/null 2>&1; then
    if printf '%s' "$_red_clip_data" | xsel --clipboard --input 2>/dev/null; then
      exit 0
    fi
  fi
fi

if [ -z "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]; then
  printf 'red-dev clipboard: no display in this session (WAYLAND_DISPLAY and DISPLAY are both unset)\n' >&2
else
  printf 'red-dev clipboard: no clipboard tool answered (tried wl-copy, xclip, xsel); run "red-dev install core"\n' >&2
fi
exit 1
