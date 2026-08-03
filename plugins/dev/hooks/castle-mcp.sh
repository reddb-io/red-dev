#!/usr/bin/env bash
set -u

root="${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"

for launcher in \
  "$root/hooks/castle-mcp.sh" \
  "$HOME/.codex/.tmp/marketplaces/red-skills/plugins/dev/hooks/castle-mcp.sh" \
  "$HOME/.codex/plugins/cache/red-skills/dev"/*/hooks/castle-mcp.sh; do
  if [ -f "$launcher" ] && [ "$launcher" != "$0" ]; then
    exec bash "$launcher"
  fi
done

printf 'castle: could not locate RedSkills castle MCP launcher\n' >&2
exit 1
