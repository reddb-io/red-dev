# Take a new RedSkills release as soon as this machine sees one.
#
# ADR 0017. The check is debounced by a stamp red-dev keeps, so this
# runs on every shell and touches the network at most once every fifteen
# minutes however many terminals are opened. Nothing here waits for it:
# the command is detached, its output goes nowhere, and a shell that
# started while the publisher was unreachable is a shell that started.
#
# A timer was the alternative and this repository has already paid for
# one — the Redwall's two-minute tick spawned a process on an idle
# machine to learn that nothing had moved, and on Windows it drew a
# black console over the wallpaper while doing it (ADR 0009). A shell
# starting is a machine somebody is about to use, which is exactly when
# being one revision behind starts to matter.
#
# Turn it off with RED_SKILLS_WATCH=0 in ~/.config/red-dev/env.sh.
if [ "${RED_SKILLS_WATCH:-1}" = "1" ] && [ -z "${RED_DEV_NO_LAUNCH-}" ]; then
  # Only for a person at a terminal. A script, a hook or a CI job that
  # sources this profile has not asked for background work, and a
  # non-interactive shell that spawns one is how a converge ends up
  # racing itself.
  case "$-" in
    *i*)
      if command -v red-dev >/dev/null 2>&1; then
        # `due` rather than a bare `watch`: typed by a person the phase
        # means "ask now", and a shell is not a person typing.
        (
          red-dev red-skills watch due >/dev/null 2>&1 &
        ) >/dev/null 2>&1
      fi
      ;;
  esac
fi
