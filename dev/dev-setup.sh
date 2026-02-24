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
  echo "WARNING: This will delete all data in .dev/ including databases."
  echo "Press Enter to continue or Ctrl+C to abort..."
  read -r
  rm -rf "$DEV_DIR"
  rm -f "$REPO_ROOT/.env"
fi

if [[ ! -f "$REPO_ROOT/.env" ]]; then
  sed "s|/REPLACE/WITH/ABSOLUTE/PATH|$REPO_ROOT|g" "$REPO_ROOT/dev/.env.example" >"$REPO_ROOT/.env"
fi

mkdir -p "$DEV_DIR/data"/{postgres,qdrant,openmemory,assistant,admin}
mkdir -p "$DEV_DIR/config"
mkdir -p "$DEV_DIR/state"/{gateway,openmemory,postgres,qdrant,assistant,channel-chat,channel-discord,channel-voice,channel-telegram,channel-api,caddy/config,caddy/data,logs,tmp,automations}

# Fix root-owned files from previous container runs (avoids needing sudo)
if find "$DEV_DIR" -maxdepth 1 -not -user "$(id -u)" -print -quit 2>/dev/null | grep -q .; then
  echo "Fixing root-owned files in .dev/ (using Docker to avoid sudo)..."
  docker run --rm -v "$DEV_DIR:/fixme" alpine chown -R "$(id -u):$(id -g)" /fixme
fi
# Create empty env files so docker-compose doesn't error on missing env_file
touch "$DEV_DIR/state/system.env"
for svc in gateway openmemory postgres qdrant assistant channel-chat channel-discord channel-voice channel-telegram channel-api; do
  touch "$DEV_DIR/state/$svc/.env"
done
mkdir -p "$HOME/openpalm"

cp -n "$REPO_ROOT/packages/lib/src/embedded/config/secrets.env" "$DEV_DIR/config/secrets.env" || echo "Note: secrets.env already exists, skipping"
# Seed the v3 YAML stack spec
cp -n "$REPO_ROOT/packages/lib/assets/templates/openpalm.yaml" "$DEV_DIR/config/openpalm.yaml" || echo "Note: openpalm.yaml already exists, skipping"
cp -n "$REPO_ROOT/packages/lib/src/embedded/state/caddy/caddy.json" "$DEV_DIR/state/caddy.json" || echo "Note: caddy.json already exists, skipping"
cp -n "$REPO_ROOT/packages/lib/src/embedded/state/caddy/fallback-caddy.json" "$DEV_DIR/state/caddy-fallback.json" || echo "Note: caddy-fallback.json already exists, skipping"
cp -n "$REPO_ROOT/packages/lib/src/embedded/state/docker-compose-fallback.yml" "$DEV_DIR/state/docker-compose-fallback.yml" || echo "Note: docker-compose-fallback.yml already exists, skipping"

echo "Dev environment ready under .dev/ and ~/openpalm"
