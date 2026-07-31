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

# The shared bin, split by format because it has to be.
#
# This is the part of "one directory for both" that a directory cannot
# actually deliver: a Linux ELF does not run on Windows and a Windows PE
# does not run in a distro. So the share holds both and each side takes
# only its own — which is why this is bin/linux or bin/windows and never
# just bin.
#
# WSL is the asymmetric case and gets both. Interop means a distro can
# execute a Windows .exe directly, so putting bin/windows on the path
# there is free reach rather than a mistake; Windows has no equivalent
# and would only find files it cannot run.
if [ -n "${RED_SHARE:-}" ]; then
  case "${RED_ENV:-}" in
    windows)
      _red_path_prepend "$RED_SHARE/bin/windows"
      ;;
    wsl)
      _red_path_prepend "$RED_SHARE/bin/windows"
      _red_path_prepend "$RED_SHARE/bin/linux"
      ;;
  esac
fi

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
