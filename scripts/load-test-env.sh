#!/usr/bin/env bash
# Load test environment variables from .dev env for Playwright E2E tests.
# Source this file; do not execute it directly.
#
# Usage (from package.json or shell):
#   source scripts/load-test-env.sh
#
# Exports:
#   OP_UI_LOGIN_PASSWORD — read directly from .dev/knowledge/secrets/op_ui_login_password.
#     Exported for Playwright tests that authenticate against the host UI.

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
LOGIN_PASSWORD_SECRET="$ROOT_DIR/.dev/knowledge/secrets/op_ui_login_password"

if [[ -f "$LOGIN_PASSWORD_SECRET" ]]; then
  export OP_UI_LOGIN_PASSWORD
  OP_UI_LOGIN_PASSWORD=$(tr -d '\n' < "$LOGIN_PASSWORD_SECRET")
else
  echo "Warning: $LOGIN_PASSWORD_SECRET not found. Run 'bun run dev:setup' first." >&2
fi
