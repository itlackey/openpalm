#!/usr/bin/env bash
set -euo pipefail

# Admin entrypoint — starts SvelteKit (port 8100) and OpenCode (port 4097).
# SvelteKit is the main process; OpenCode runs in the background.
# If either process exits unexpectedly, the container exits.

SVELTEKIT_PORT="${PORT:-8100}"
OPENCODE_PORT="${OPENCODE_PORT:-4097}"
VARLOCK_SCHEMA_DIR="/app"

# ── Seed admin OpenCode config if not already present ─────────────────
OPENCODE_CFG="${OPENCODE_CONFIG_DIR:-/openpalm/data/admin}/opencode.jsonc"
if [ ! -f "$OPENCODE_CFG" ]; then
  mkdir -p "$(dirname "$OPENCODE_CFG")" 2>/dev/null || true
  cp /app/admin-opencode.jsonc "$OPENCODE_CFG" 2>/dev/null || true
fi

# ── Varlock command prefix (runtime secret redaction) ─────────────────
VARLOCK_CMD=()
if command -v varlock >/dev/null 2>&1 && [ -f "$VARLOCK_SCHEMA_DIR/.env.schema" ]; then
  VARLOCK_CMD=(varlock run --path "$VARLOCK_SCHEMA_DIR/" --)
fi

# ── Start OpenCode in background ──────────────────────────────────────
start_opencode() {
  if ! command -v opencode >/dev/null 2>&1; then
    echo "WARN: opencode not found — admin AI assistant disabled" >&2
    return 0
  fi

  # Ensure OpenCode user dirs exist under HOME
  mkdir -p \
    "${HOME}/.config/opencode" \
    "${HOME}/.local/state/opencode" \
    "${HOME}/.local/share/opencode" \
    "${HOME}/.cache" \
    2>/dev/null || true

  # Ensure bun's user-writable directories exist
  mkdir -p \
    "${BUN_INSTALL:-${HOME}/.bun}/bin" \
    "${BUN_INSTALL_CACHE_DIR:-${HOME}/.cache/bun/install}" \
    2>/dev/null || true

  echo "Starting admin OpenCode on port ${OPENCODE_PORT}..."
  opencode web --hostname 0.0.0.0 --port "$OPENCODE_PORT" --print-logs &
  OPENCODE_PID=$!
  echo "Admin OpenCode started (PID ${OPENCODE_PID})"
}

# ── Start SvelteKit (foreground) ──────────────────────────────────────
start_sveltekit() {
  echo "Starting admin SvelteKit on port ${SVELTEKIT_PORT}..."
  exec "${VARLOCK_CMD[@]}" node build/index.js
}

# ── Cleanup on exit ───────────────────────────────────────────────────
cleanup() {
  if [ -n "${OPENCODE_PID:-}" ]; then
    kill "$OPENCODE_PID" 2>/dev/null || true
    wait "$OPENCODE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

start_opencode
start_sveltekit
