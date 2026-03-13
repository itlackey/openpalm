#!/usr/bin/env bash
# varlock-shell — context-window-safe shell wrapper for OpenCode.
#
# OpenCode resolves its bash tool shell via the $SHELL environment variable.
# This script wraps /bin/bash with varlock's runtime redaction so that any
# secret values (API keys, tokens) that appear in tool output are redacted
# before they enter the LLM context window.
#
# Graceful fallback: if varlock is not available or the schema file is
# missing, this script falls back to plain /bin/bash with no redaction.
#
# Usage (set as SHELL in entrypoint.sh):
#   export SHELL=/usr/local/bin/varlock-shell
#
# OpenCode then calls: varlock-shell -c "some command"
# which becomes:       varlock run --schema <schema> -- /bin/bash -c "some command"

VARLOCK_SCHEMA_DIR="${VARLOCK_SHELL_SCHEMA_DIR:-/usr/local/etc/varlock}"

# Only wrap with varlock for non-interactive invocations (bash -c "command")
# used by OpenCode's bash tool. Interactive PTY terminals (no -c flag) must
# run plain bash so readline, escape sequences, and job control work correctly.
case "$1" in
  -c)
    if command -v varlock >/dev/null 2>&1 && [ -f "$VARLOCK_SCHEMA_DIR/.env.schema" ]; then
      exec varlock run --path "$VARLOCK_SCHEMA_DIR/" -- /bin/bash "$@"
    fi
    ;;
esac

exec /bin/bash "$@"
