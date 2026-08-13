#!/bin/sh
# red-dev bootstrap for Linux and WSL.
#
#   curl -fsSL https://raw.githubusercontent.com/reddb-io/red-dev/main/boot.sh | sh
#
# POSIX sh on purpose: this is the one file that runs before anything is
# installed, on a machine we know nothing about. It must not assume
# bash, and it must not assume any of the tools red-dev goes on to
# install. curl and tar are the only dependencies, and both are present
# on a stock Ubuntu.
set -eu

REPO="reddb-io/red-dev"
BIN_DIR="${RED_DEV_BIN_DIR:-$HOME/.local/bin}"
BIN="$BIN_DIR/red-dev"

say()  { printf ':: %s\n' "$1"; }
fail() { printf 'fail %s\n' "$1" >&2; exit 1; }

case "$(uname -s)" in
  Linux) ;;
  *) fail "boot.sh handles Linux and WSL. On Windows use boot.ps1." ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ASSET="red-dev-linux-x64" ;;
  aarch64|arm64) fail "no arm64 build is published yet" ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is required"

# Channel, the way toon's installer does it. Stable needs no API lookup:
# GitHub's public /releases/latest/download/<asset> redirect resolves the
# newest non-prerelease by contract. That matters on a fresh machine,
# where an anonymous API request spends a shared per-IP quota unrelated
# to any PAT or GitHub App the user has configured elsewhere.
CHANNEL="${RED_DEV_CHANNEL:-stable}"

case "$CHANNEL" in
  stable) URL="https://github.com/$REPO/releases/latest/download/$ASSET" ;;
  # /releases is not ordered the way you would hope: the newest
  # prerelease is not reliably first, and taking [0] served the stable
  # release to everyone who asked for `next`. Fetch a page and pick the
  # first entry actually marked prerelease.
  next)   API="https://api.github.com/repos/$REPO/releases?per_page=20" ;;
  *)      fail "RED_DEV_CHANNEL must be 'stable' or 'next' (got '$CHANNEL')" ;;
esac

say "resolving $CHANNEL release of $REPO"

if [ "$CHANNEL" = "next" ]; then
  # `next` cannot use /latest because GitHub deliberately excludes
  # prereleases there. This explicit opt-in is the only path that pays
  # for an API request and may therefore need GITHUB_TOKEN.
  BODY=$(mktemp)
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    STATUS=$(curl -sSL -o "$BODY" -w '%{http_code}' \
      -H "Authorization: Bearer $GITHUB_TOKEN" "$API" || echo 000)
  else
    STATUS=$(curl -sSL -o "$BODY" -w '%{http_code}' "$API" || echo 000)
  fi

  case "$STATUS" in
    200) ;;
    404) rm -f "$BODY"; fail "$REPO has no published prerelease" ;;
    403) rm -f "$BODY"; fail "GitHub API refused the prerelease lookup (HTTP 403) — set GITHUB_TOKEN and retry" ;;
    401) rm -f "$BODY"; fail "GITHUB_TOKEN was rejected — check that it can read $REPO" ;;
    000) rm -f "$BODY"; fail "could not reach github.com — check your network" ;;
    *)   rm -f "$BODY"; fail "GitHub API returned HTTP $STATUS" ;;
  esac

  JSON=$(cat "$BODY")
  rm -f "$BODY"

  # Walk all releases in order and take the first prerelease carrying
  # the platform asset. Picking element zero served stable to `next`.
  # Field order inside each release object is: tag_name, then
  # prerelease, then assets. So the flag has to be set first and the
  # asset matched after — accumulating the asset and checking the flag
  # afterwards reads the previous release's marker, which is how the
  # first attempt at this returned nothing at all.
  URL=$(printf '%s' "$JSON" | tr '{},' '\n' | awk -v asset="$ASSET" '
    /"prerelease"[[:space:]]*:[[:space:]]*true/  { pre = 1; next }
    /"prerelease"[[:space:]]*:[[:space:]]*false/ { pre = 0; next }
    pre && /"browser_download_url"/ {
      # split on quotes rather than sub() with a backreference: POSIX
      # awk has no \1 in the replacement, so that silently yields the
      # literal string "\1" and every match is discarded. The line is
      #   "browser_download_url": "https://..."
      # so field 4 is the URL.
      n = split($0, q, "\"")
      if (n >= 4 && q[4] ~ ("/" asset "$")) { print q[4]; exit }
    }
  ')
  if [ -z "$URL" ]; then
    printf 'fail no asset named %s in the newest prerelease. Available:\n' "$ASSET" >&2
    printf '%s' "$JSON" | tr ',' '\n' | grep '"name"' | sed 's/.*"name": *"\([^"]*\)".*/  \1/' >&2
    exit 1
  fi
fi

# Arguments turn this into a run, not an install.
#
#   curl ... | sh                 install, then converge
#   curl ... | sh -s -- doctor    run `red-dev doctor` and leave nothing behind
#
# Worth having because most of what this tool does is answer questions —
# what is this machine, what would change, what has drifted — and none
# of those are worth installing something to ask.
if [ "$#" -gt 0 ]; then
  say "downloading $ASSET (temporary)"
  TMP=$(mktemp -d)
  # Clean up on any exit path, including the interrupt that a long
  # command invites.
  trap 'rm -rf "$TMP"' EXIT INT TERM
  curl -fsSL "$URL" -o "$TMP/red-dev" || fail "download failed"
  chmod +x "$TMP/red-dev"
  say "running: red-dev $*"
  "$TMP/red-dev" "$@"
  exit $?
fi

say "downloading $ASSET"
mkdir -p "$BIN_DIR"
TMP=$(mktemp)
curl -fsSL "$URL" -o "$TMP" || fail "download failed"
chmod +x "$TMP"
mv "$TMP" "$BIN"
say "installed $BIN"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'warn %s is not on PATH yet; red-dev will add it to your shell config\n' "$BIN_DIR" >&2 ;;
esac

# Hand over to red-dev itself, with no command.
#
# Not `install`. The one-liner and the binary have to arrive at the same
# place, and they did not: typing `red-dev` opens the interface that lets
# you choose between a first install and maintenance, while the bootstrap
# went straight to converging. Someone who ran the documented one-liner
# never saw the screen the product is built around, and had no way to
# reach it except by knowing to run the binary again afterwards.
#
# With no arguments red-dev opens that interface when there is a
# terminal, falls back to a line menu in a narrow one, and prints help
# when there is no terminal at all — so CI still gets something sane out
# of the same command.
# Installed, and that is all that was asked for.
#
# The Windows side converges its distro by running this inside it, where
# there is no one watching and WSL hands even a non-interactive
# `wsl -- bash -lc` a pty — so the interface below would open against
# nobody and wait forever. Anything scripting this install wants the
# same escape.
if [ "${RED_DEV_NO_LAUNCH:-0}" = "1" ]; then
  say "installed at $BIN (not starting: RED_DEV_NO_LAUNCH=1)"
  exit 0
fi

say "starting red-dev"

# Tell the binary this launch is the installation handoff, not an ordinary
# visit to its menu. On Ubuntu that lets it authenticate sudo once before the
# fullscreen renderer owns stdin; providers themselves remain unattended.
export RED_DEV_BOOTSTRAP=1

# Reconnect stdin to the terminal before handing over.
#
# The documented way to run this is `curl ... | sh`, which makes the
# script's stdin the pipe carrying the script itself. Every child then
# inherits a stdin that is at EOF, isatty() says no terminal, and the
# interface silently declines to open — which now matters much more than
# it did when this only skipped a few questions.
#
# /dev/tty is the controlling terminal regardless of what stdin was
# redirected to. When there is none — CI, a container, a cron job — the
# fallback is the current behaviour, which is what should happen there.
if [ -r /dev/tty ]; then
  exec "$BIN" < /dev/tty
fi
exec "$BIN"
