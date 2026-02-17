#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Install Docker Desktop (macOS/Windows) or Docker Engine (Linux), then rerun."
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 not found. Update Docker installation."
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  python3 - <<'PY'
import secrets, pathlib
p = pathlib.Path('.env')
text = p.read_text()
for marker in ['replace-with-long-random-token','replace-with-second-long-random-token','replace-with-controller-token','replace-with-pg-password','replace-with-channel-secret','replace-with-inbound-token','replace-with-telegram-webhook-secret']:
    text = text.replace(marker, secrets.token_urlsafe(36), 1)
p.write_text(text)
print('Created .env with generated secure defaults.')
PY
fi

mkdir -p data/openmemory data/opencode data/gateway data/admin-app data/admin-app/bundles data/admin-app/change-states
mkdir -p data/postgres data/qdrant data/shared
mkdir -p data/caddy_data data/caddy_config
mkdir -p data/observability data/backups

echo "Starting core services..."
docker compose up -d --build

echo "If you want channel adapters too: docker compose --profile channels up -d --build"

for _ in $(seq 1 40); do
  if curl -fsS http://localhost:80/health >/dev/null 2>&1; then
    echo "OpenPalm is ready: http://localhost"
    echo "Admin dashboard (LAN only): http://localhost/admin"
    echo "Open Memory UI (LAN only): http://localhost/openmemory"
    exit 0
  fi
  sleep 2
done

echo "Health check failed. Inspect logs with: docker compose logs"
exit 1
