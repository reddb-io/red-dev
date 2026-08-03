#!/usr/bin/env bash
# Zellij writes UTF-8 to copy_command. clip.exe reads redirected input as
# UTF-16LE, so bridge the encodings without starting PowerShell: Zellij kills
# clipboard commands that are still running after one second.

set -o pipefail

if ! command -v iconv >/dev/null 2>&1; then
  printf 'red-dev clipboard: iconv is unavailable\n' >&2
  exit 127
fi

if ! command -v clip.exe >/dev/null 2>&1; then
  printf 'red-dev clipboard: clip.exe is unavailable (WSL interop is disabled)\n' >&2
  exit 127
fi

# No BOM: clip.exe already treats redirected UTF-16LE as Unicode, while a BOM
# becomes a literal U+FEFF at the start of the Windows clipboard contents.
iconv -f UTF-8 -t UTF-16LE | clip.exe
