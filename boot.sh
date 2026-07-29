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
  next)   API="https://api.github.com/repos/$REPO/releases?per_page=1" ;;
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

# The `next` channel returns an array, so this must take the first
# matching asset across the newest release rather than assuming a single
# object. Both shapes flatten the same way here.
URL=$(printf '%s' "$JSON" \
  | tr ',' '\n' \
  | grep '"browser_download_url"' \
  | sed 's/.*"\(https[^"]*\)".*/\1/' \
  | grep "/$ASSET\$" \
  | head -1)

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

say "converging"
exec "$BIN" install
