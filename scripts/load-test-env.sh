#!/usr/bin/env bash
# Load test environment variables from .dev vault for Playwright E2E tests.
# Source this file; do not execute it directly.
#
# Usage (from package.json or shell):
#   source scripts/load-test-env.sh
#
# Exports:
#   ADMIN_TOKEN       — from OP_ADMIN_TOKEN in .dev/vault/stack/stack.env
#   MEMORY_AUTH_TOKEN  — from OP_MEMORY_TOKEN in .dev/vault/stack/stack.env

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STACK_ENV="$ROOT_DIR/.dev/vault/stack/stack.env"

if [[ -f "$STACK_ENV" ]]; then
  export MEMORY_AUTH_TOKEN
  MEMORY_AUTH_TOKEN=$(grep -E '^OP_MEMORY_TOKEN=' "$STACK_ENV" 2>/dev/null | cut -d= -f2-)

  export ADMIN_TOKEN
  ADMIN_TOKEN=$(grep -E '^OP_ADMIN_TOKEN=' "$STACK_ENV" 2>/dev/null | cut -d= -f2-)
else
  echo "Warning: $STACK_ENV not found. Run 'bun run dev:setup' first." >&2
fi
