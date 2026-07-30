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

# Channel, the way toon's installer does it. `stable` asks for
# /releases/latest, which by GitHub's definition never returns a
# prerelease — so a repository publishing only prereleases 404s there
# and looks empty. `next` lists all releases and takes the newest.
CHANNEL="${RED_DEV_CHANNEL:-stable}"

case "$CHANNEL" in
  stable) API="https://api.github.com/repos/$REPO/releases/latest" ;;
  # /releases is not ordered the way you would hope: the newest
  # prerelease is not reliably first, and taking [0] served the stable
  # release to everyone who asked for `next`. Fetch a page and pick the
  # first entry actually marked prerelease.
  next)   API="https://api.github.com/repos/$REPO/releases?per_page=20" ;;
  *)      fail "RED_DEV_CHANNEL must be 'stable' or 'next' (got '$CHANNEL')" ;;
esac

say "resolving $CHANNEL release of $REPO"

# Ask the API which assets the release actually has, rather than
# constructing a URL from a version we assume. Guessing that is exactly
# the bug that motivated this project.

# Capture the status rather than relying on curl -f, so each failure
# gets the hint that actually applies. A 404 here means no release has
# been published, and telling that person to check their rate limit
# sends them hunting the wrong problem.
BODY=$(mktemp)
if [ -n "${GITHUB_TOKEN:-}" ]; then
  STATUS=$(curl -sSL -o "$BODY" -w '%{http_code}' \
    -H "Authorization: Bearer $GITHUB_TOKEN" "$API" || echo 000)
else
  STATUS=$(curl -sSL -o "$BODY" -w '%{http_code}' "$API" || echo 000)
fi

case "$STATUS" in
  200) ;;
  404)
    rm -f "$BODY"
    # /releases/latest 404s for three different reasons, and guessing
    # wrong sends people hunting the wrong problem. Ask the plain
    # /releases endpoint which of the three this is.
    if [ "$CHANNEL" = "stable" ]; then
      PRERELEASES="$(curl -sSL "https://api.github.com/repos/$REPO/releases?per_page=1" \
        ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} 2>/dev/null \
        | grep -c '"tag_name"' || true)"
      if [ "${PRERELEASES:-0}" -gt 0 ]; then
        printf 'fail %s has no stable release yet, only prereleases.\n' "$REPO" >&2
        printf '     Install the newest prerelease with:\n' >&2
        printf '       RED_DEV_CHANNEL=next curl -fsSL .../boot.sh | sh\n' >&2
        exit 1
      fi
    fi
    printf 'fail no release found for %s.\n' "$REPO" >&2
    printf '     Either none has been published, or the repository is\n' >&2
    printf '     private -- in which case export GITHUB_TOKEN and retry.\n' >&2
    exit 1
    ;;
  403) rm -f "$BODY"; fail "GitHub API rate limit reached — set GITHUB_TOKEN and retry" ;;
  401) rm -f "$BODY"; fail "GITHUB_TOKEN was rejected — check that it can read $REPO" ;;
  000) rm -f "$BODY"; fail "could not reach github.com — check your network" ;;
  *)   rm -f "$BODY"; fail "GitHub API returned HTTP $STATUS" ;;
esac

JSON=$(cat "$BODY")
rm -f "$BODY"

# On `next` the response is an array of releases and only some are
# prereleases. Walk it in order, remember the most recent asset URL seen
# for our platform, and commit to it the moment a "prerelease": true
# closes that release's block. Picking by position instead served the
# stable build to everyone who asked for next.
if [ "$CHANNEL" = "next" ]; then
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
else
  URL=$(printf '%s' "$JSON" \
    | tr ',' '\n' \
    | grep '"browser_download_url"' \
    | sed 's/.*"\(https[^"]*\)".*/\1/' \
    | grep "/$ASSET\$" \
    | head -1)
fi

if [ -z "$URL" ]; then
  printf 'fail no asset named %s in the latest release. Available:\n' "$ASSET" >&2
  printf '%s' "$JSON" | tr ',' '\n' | grep '"name"' | sed 's/.*"name": *"\([^"]*\)".*/  \1/' >&2
  exit 1
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
say "starting red-dev"

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
