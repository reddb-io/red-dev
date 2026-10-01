# Retired red-dev prompt updater. Maintenance belongs to the OS scheduler.
# Keep this compatibility file to remove our old hook on already-open shells.
if [[ ${PROMPT_COMMAND+x} && ${PROMPT_COMMAND@a} == *a* ]]; then
  _red_watch_commands=()
  for _red_watch_command in "${PROMPT_COMMAND[@]}"; do
    [[ $_red_watch_command == _red_skills_watch_tick ]] || _red_watch_commands+=("$_red_watch_command")
  done
  PROMPT_COMMAND=("${_red_watch_commands[@]}")
else
  # The generated hook prepended one exact token. Preserve other shell code.
  # This branch is the scalar representation, selected above at runtime.
  # shellcheck disable=SC2178
  case ${PROMPT_COMMAND-} in
    _red_skills_watch_tick) PROMPT_COMMAND="" ;;
    _red_skills_watch_tick\;*) PROMPT_COMMAND="${PROMPT_COMMAND#_red_skills_watch_tick;}" ;;
  esac
fi
_red_watch_function=$(declare -f _red_skills_watch_tick || :)
[[ $_red_watch_function == *"red-skills watch due"* ]] && unset -f _red_skills_watch_tick
unset _red_skills_watch_last _red_watch_commands _red_watch_command _red_watch_function
