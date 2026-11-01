#!/bin/sh
# Start Claude Code with intent-lens loaded for this session.
# Works on builds before 2.1.287, where mods need the function-hooks flag.
set -e
here=$(cd "$(dirname "$0")" && pwd)
exec env CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir "$here" "$@"
