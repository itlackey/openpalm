#!/usr/bin/env bash
# Load test environment variables from .dev vault for Playwright E2E tests.
# Source this file; do not execute it directly.
#
# Usage (from package.json or shell):
#   source scripts/load-test-env.sh
#
# Exports:
#   ADMIN_TOKEN  — from OP_ADMIN_TOKEN in .dev/vault/stack/stack.env

# Guard: this script must be sourced, not executed. Direct execution would
# silently set vars in a child shell that exits immediately, leaving the
# caller without ADMIN_TOKEN — a confusing failure mode.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "Error: scripts/load-test-env.sh must be sourced, not executed." >&2
  echo "       Use: source scripts/load-test-env.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STACK_ENV="$ROOT_DIR/.dev/vault/stack/stack.env"

if [[ -f "$STACK_ENV" ]]; then
  export ADMIN_TOKEN
  ADMIN_TOKEN=$(grep -E '^OP_ADMIN_TOKEN=' "$STACK_ENV" 2>/dev/null | cut -d= -f2-)
else
  echo "Warning: $STACK_ENV not found. Run 'bun run dev:setup' first." >&2
fi
