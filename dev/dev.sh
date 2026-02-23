#!/usr/bin/env bash
# dev/dev.sh -- Run admin and gateway locally with hot reload.
#
# Usage:
#   ./dev/dev.sh          # Start both admin and gateway
#   ./dev/dev.sh admin    # Start admin only
#   ./dev/dev.sh gateway  # Start gateway only
#
# Prerequisites:
#   - Bun installed (https://bun.sh)
#   - Dependencies installed: cd core/admin && bun install; cd core/gateway && bun install
#   - Supporting services running (opencode-core, openmemory) via
#     docker compose, or point the env vars at your own instances.
#
# This script uses bun run --hot for hot reload so you can edit TypeScript
# source files without restarting. Press Ctrl+C to stop all processes.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Shared env defaults (override as needed) ─────────────────────────
export ADMIN_TOKEN="${ADMIN_TOKEN:-dev-admin-token}"
export GATEWAY_URL="${GATEWAY_URL:-http://localhost:8080}"
export OPENCODE_CORE_URL="${OPENCODE_CORE_URL:-http://localhost:4096}"
export OPENCODE_CORE_BASE_URL="${OPENCODE_CORE_BASE_URL:-http://localhost:4096}"
export OPENCODE_CONFIG_PATH="${OPENCODE_CONFIG_PATH:-$ROOT/opencode/extensions/opencode.jsonc}"
export DATA_DIR="${DATA_DIR:-$ROOT/.dev/data}"
export CHANNEL_ENV_DIR="${CHANNEL_ENV_DIR:-$ROOT/.dev/config/channels}"

# Channel shared secrets for gateway
export CHANNEL_CHAT_SECRET="${CHANNEL_CHAT_SECRET:-dev-chat-secret}"
export CHANNEL_DISCORD_SECRET="${CHANNEL_DISCORD_SECRET:-dev-discord-secret}"
export CHANNEL_VOICE_SECRET="${CHANNEL_VOICE_SECRET:-dev-voice-secret}"
export CHANNEL_TELEGRAM_SECRET="${CHANNEL_TELEGRAM_SECRET:-dev-telegram-secret}"

mkdir -p "$DATA_DIR"

# ── Process management ───────────────────────────────────────────────
PIDS=()

cleanup() {
  echo ""
  echo "[dev] Stopping services..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
  echo "[dev] Done."
}
trap cleanup EXIT INT TERM

start_admin() {
  echo "[dev] Starting admin UI on :8100 (hot reload)"
  cd "$ROOT/packages/ui"
  PORT=8100 bun run dev -- --host 0.0.0.0 --port 8100 &
  PIDS+=($!)
}

start_gateway() {
  echo "[dev] Starting gateway on :8080 (hot reload)"
  cd "$ROOT/core/gateway"
  PORT=8080 bun run --hot src/server.ts &
  PIDS+=($!)
}

# ── Main ─────────────────────────────────────────────────────────────
TARGET="${1:-all}"

case "$TARGET" in
  admin)
    start_admin
    ;;
  gateway)
    start_gateway
    ;;
  all|"")
    start_gateway
    start_admin
    ;;
  *)
    echo "Usage: $0 [admin|gateway|all]"
    exit 1
    ;;
esac

echo "[dev] Services running. Press Ctrl+C to stop."
wait
