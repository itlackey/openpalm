#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV_DIR="$REPO_ROOT/.dev"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "OpenPalm Development Setup"
  echo "Usage: ./dev/dev-setup.sh [--clean]"
  exit 0
fi

if [[ "${1:-}" == "--clean" ]]; then
  rm -rf "$DEV_DIR"
  rm -f "$REPO_ROOT/.env"
fi

if [[ ! -f "$REPO_ROOT/.env" ]]; then
  sed "s|/REPLACE/WITH/ABSOLUTE/PATH|$REPO_ROOT|g" "$REPO_ROOT/dev/.env.example" >"$REPO_ROOT/.env"
fi

mkdir -p "$DEV_DIR/data"/{postgres,qdrant,openmemory,assistant,admin}
mkdir -p "$DEV_DIR/config"
mkdir -p "$DEV_DIR/state"/{gateway,openmemory,postgres,qdrant,assistant,channel-chat,channel-discord,channel-voice,channel-telegram,rendered/caddy,caddy/config,caddy/data,logs,tmp,automations}
# Create empty env files so docker-compose doesn't error on missing env_file
touch "$DEV_DIR/state/system.env"
for svc in gateway openmemory postgres qdrant assistant channel-chat channel-discord channel-voice channel-telegram; do
  touch "$DEV_DIR/state/$svc/.env"
done
mkdir -p "$HOME/openpalm"

cp -n "$REPO_ROOT/assets/config/secrets.env" "$DEV_DIR/config/secrets.env" 2>/dev/null || true
cp -n "$REPO_ROOT/assets/config/stack-spec.json" "$DEV_DIR/config/stack-spec.json" 2>/dev/null || true
cp -n "$REPO_ROOT/assets/state/caddy/caddy.json" "$DEV_DIR/state/rendered/caddy/caddy.json" 2>/dev/null || true

echo "Dev environment ready under .dev/ and ~/openpalm"
