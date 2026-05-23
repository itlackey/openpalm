#!/usr/bin/env bash
# Load test environment variables from .dev vault for Playwright E2E tests.
# Source this file; do not execute it directly.
#
# Usage (from package.json or shell):
#   source scripts/load-test-env.sh
#
# Exports:
#   OP_UI_LOGIN_PASSWORD — from OP_UI_TOKEN in .dev/config/stack/stack.env
#     (Phase 2 of docs/technical/auth-and-proxy-refactor-plan.md renamed the
#     operator-facing env var from ADMIN_TOKEN to OP_UI_LOGIN_PASSWORD; the
#     stack.env source field is still OP_UI_TOKEN and stays that way until
#     Phase 4 collapses the token plumbing entirely.)

# Guard: this script must be sourced, not executed. Direct execution would
# silently set vars in a child shell that exits immediately, leaving the
# caller without OP_UI_LOGIN_PASSWORD — a confusing failure mode.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "Error: scripts/load-test-env.sh must be sourced, not executed." >&2
  echo "       Use: source scripts/load-test-env.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STACK_ENV="$ROOT_DIR/.dev/config/stack/stack.env"

if [[ -f "$STACK_ENV" ]]; then
  export OP_UI_LOGIN_PASSWORD
  OP_UI_LOGIN_PASSWORD=$(grep -E '^OP_UI_TOKEN=' "$STACK_ENV" 2>/dev/null | cut -d= -f2-)
else
  echo "Warning: $STACK_ENV not found. Run 'bun run dev:setup' first." >&2
fi
