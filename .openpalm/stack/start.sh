#!/usr/bin/env bash
set -euo pipefail
#
# OpenPalm — thin compose wrapper
#
# Usage:
#   ./start.sh                       # Start core stack
#   ./start.sh chat                  # Start core + chat addon
#   ./start.sh chat discord admin    # Start core + multiple addons
#   ./start.sh --stop                # Stop the stack
#   ./start.sh --status              # Show service status
#
# Prerequisites:
#   cp .env.example .env  # Fill in your API keys and tokens
#

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Argument parsing ──────────────────────────────────────────────────

action="up"
addons=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stop|stop)   action="stop"; shift ;;
    --down|down)   action="down"; shift ;;
    --status|status|ps) action="ps"; shift ;;
    --help|-h)
      echo "Usage: $0 [--stop|--down|--status] [addon ...]"
      echo ""
      echo "Addons: chat, api, discord, slack, voice, ollama, openviking, admin"
      exit 0
      ;;
    *)
      addons+=("$1"); shift ;;
  esac
done

# ── Build compose file list ──────────────────────────────────────────

compose_files=("-f" "$STACK_DIR/core.compose.yml")

for addon in "${addons[@]}"; do
  addon_file="$STACK_DIR/addons/$addon/compose.yml"
  if [[ ! -f "$addon_file" ]]; then
    echo "Error: addon '$addon' not found at $addon_file" >&2
    exit 1
  fi
  compose_files+=("-f" "$addon_file")
done

# ── Execute ──────────────────────────────────────────────────────────

case "$action" in
  up)
    exec docker compose "${compose_files[@]}" up -d
    ;;
  stop)
    exec docker compose "${compose_files[@]}" stop
    ;;
  down)
    exec docker compose "${compose_files[@]}" down
    ;;
  ps)
    exec docker compose "${compose_files[@]}" ps
    ;;
esac
