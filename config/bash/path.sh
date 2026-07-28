# PATH construction.
#
# Upstream omakub does `export PATH="<fixed list>"`, replacing the
# inherited PATH wholesale. On bare-metal Ubuntu that is harmless. Under
# WSL it silently deletes the ~20 /mnt/c entries that WSL injects for
# Windows interop, so winget.exe, explorer.exe, code.exe and clip.exe
# all stop resolving — and the WSL target can no longer reach the host
# it depends on.
#
# We prepend our entries and keep everything we inherited, deduped.

_red_path_prepend() {
  case ":${PATH}:" in
    *":$1:"*) ;;
    *) PATH="$1${PATH:+:$PATH}" ;;
  esac
}

# Deduplicate while preserving first-seen order.
_red_path_dedupe() {
  local out="" entry
  local IFS=':'
  for entry in $PATH; do
    [ -n "$entry" ] || continue
    case ":${out}:" in
      *":$entry:"*) continue ;;
    esac
    out="${out:+$out:}$entry"
  done
  PATH="$out"
}

# Later calls win, so list these lowest-priority first.
_red_path_prepend "/snap/bin"
_red_path_prepend "$RED_ROOT/bin"
_red_path_prepend "$HOME/.local/bin"

# Project-local binstubs (./bin/rails and friends). This is upstream
# omakub behaviour and it is a real trade-off: a relative PATH entry
# means cd-ing into an untrusted repo puts its ./bin ahead of system
# commands. Opt in explicitly rather than inheriting it silently.
if [ "${RED_PROJECT_BINSTUBS:-0}" = "1" ]; then
  _red_path_prepend "./bin"
fi

_red_path_dedupe
export PATH
