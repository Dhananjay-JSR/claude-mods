#!/bin/sh
# Start Claude Code with intent-lens loaded for this session.
# Mods are on by default from Claude Code 2.1.287, so no flag is needed.
set -e

here=$(cd "$(dirname "$0")" || exit 1; pwd)
need="2.1.287"

have=$(claude --version 2>/dev/null | awk '{print $1}')
if [ -z "$have" ]; then
  echo "intent-lens: claude was not found on PATH." >&2
  echo "Install it with: brew install --cask claude-code" >&2
  exit 1
fi

ok=$(
  printf '%s\n' "$have" | awk -v need="$need" '
    { split($1, h, "."); split(need, n, ".") }
    END {
      for (i = 1; i <= 3; i++) {
        if ((h[i] + 0) > (n[i] + 0)) { print "yes"; exit }
        if ((h[i] + 0) < (n[i] + 0)) { print "no"; exit }
      }
      print "yes"
    }
  '
)

if [ "$ok" != "yes" ]; then
  echo "intent-lens: Claude Code $have is older than $need." >&2
  echo "Update it with: brew upgrade --cask claude-code" >&2
  exit 1
fi

exec claude --plugin-dir "$here" "$@"
