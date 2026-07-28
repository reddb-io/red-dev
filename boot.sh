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

say "resolving latest release of $REPO"

# Ask the API which assets the release actually has, rather than
# constructing a URL from a version we assume. Guessing that is exactly
# the bug that motivated this project.
API="https://api.github.com/repos/$REPO/releases/latest"

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
  404) rm -f "$BODY"; fail "$REPO has no published releases yet" ;;
  403) rm -f "$BODY"; fail "GitHub API rate limit reached — set GITHUB_TOKEN and retry" ;;
  000) rm -f "$BODY"; fail "could not reach github.com — check your network" ;;
  *)   rm -f "$BODY"; fail "GitHub API returned HTTP $STATUS" ;;
esac

JSON=$(cat "$BODY")
rm -f "$BODY"

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
