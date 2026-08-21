# Take a new RedSkills release as soon as this machine sees one.
#
# ADR 0017. This used to fire once, when the shell started, and that was
# the wrong event for the person it exists for: a terminal opened in the
# morning and kept all day never asked again. Measured on the maintainer's
# machine at 08:00 — last asked 107 minutes ago, one release behind, with
# a shell that had been open the whole time.
#
# So it hangs off the prompt, which is the event that *does* happen while
# somebody works. The cost per prompt is one integer comparison and no
# fork: $EPOCHSECONDS is a bash builtin, and the guard below returns
# before anything is spawned. A spawn happens at most once every fifteen
# minutes of a shell's life, and red-dev's own stamp — shared by every
# shell on the machine — then decides whether the network is touched at
# all, so ten terminals are still one question.
#
# A timer was the alternative and this repository has already paid for
# one: the Redwall's two-minute tick spawned a process on an idle machine
# to learn that nothing had moved, and on Windows drew a black console
# over the wallpaper doing it (ADR 0009). A prompt is a person.
#
# Turn it off with RED_SKILLS_WATCH=0 in ~/.config/red-dev/env.sh.

# Interactive shells only. A script or a hook that sources this profile
# has not asked for background work, and a non-interactive shell that
# spawns one is how a converge ends up racing itself.
#
# Answered into a variable rather than returned early: `return` at the
# top level is only valid in a sourced file, so it is a syntax error
# waiting for whoever runs this the other way, and it is unreachable to
# a reader — shellcheck said so (SC2317) and it was right.
_red_skills_watch_interactive=0
case "$-" in
  *i*) _red_skills_watch_interactive=1 ;;
esac

if [ "$_red_skills_watch_interactive" = "1" ] &&
  [ "${RED_SKILLS_WATCH:-1}" = "1" ] && [ -z "${RED_DEV_NO_LAUNCH-}" ]; then
  # How long a shell waits before asking again. red-dev applies its own
  # interval on top; this one only decides how often it is worth paying
  # for a process to ask the question.
  : "${RED_SKILLS_WATCH_EVERY:=900}"
  _red_skills_watch_last=0

  _red_skills_watch_tick() {
    # No $EPOCHSECONDS means a bash too old to do this without forking,
    # and forking per prompt is exactly what this design refuses.
    [ -n "${EPOCHSECONDS-}" ] || return 0
    [ $((EPOCHSECONDS - _red_skills_watch_last)) -ge "$RED_SKILLS_WATCH_EVERY" ] || return 0
    _red_skills_watch_last=$EPOCHSECONDS

    command -v red-dev >/dev/null 2>&1 || return 0
    # Detached and silent: a prompt must not wait for the network, and
    # `due` rather than a bare `watch` because a prompt is not a person
    # typing — red-dev's own interval decides whether to really look.
    # Stamped, because this run has a person at the keyboard but no way
    # to reach them: the child is detached with all three streams on
    # /dev/null, so anything it started that wanted an answer would wait
    # forever. See src/trigger.ts.
    ( RED_DEV_TRIGGER=shell red-dev red-skills watch due >/dev/null 2>&1 & ) >/dev/null 2>&1
    return 0
  }

  # Appended, never replacing: history -a and anything the operator set
  # for themselves both have to keep running.
  case "${PROMPT_COMMAND-}" in
    *_red_skills_watch_tick*) ;;
    *) PROMPT_COMMAND="_red_skills_watch_tick${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;
  esac
fi
unset _red_skills_watch_interactive
