#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

# ── Prerequisites ──────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Install Docker Desktop (macOS/Windows) or Docker Engine (Linux), then rerun."
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 not found. Update Docker installation."
  exit 1
fi

# ── Resolve XDG Base Directory paths ───────────────────────────────────────
# https://specifications.freedesktop.org/basedir-spec/latest/
#
#   Data   (~/.local/share/openpalm)  — databases, vector stores, blobs
#   Config (~/.config/openpalm)       — agent configs, Caddyfile, channel envs
#   State  (~/.local/state/openpalm)  — runtime state, audit logs, workspace
#
OPENPALM_DATA_HOME="${OPENPALM_DATA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/openpalm}"
OPENPALM_CONFIG_HOME="${OPENPALM_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/openpalm}"
OPENPALM_STATE_HOME="${OPENPALM_STATE_HOME:-${XDG_STATE_HOME:-$HOME/.local/state}/openpalm}"

echo "XDG directory layout:"
echo "  Data   → $OPENPALM_DATA_HOME"
echo "  Config → $OPENPALM_CONFIG_HOME"
echo "  State  → $OPENPALM_STATE_HOME"

# ── Generate .env if missing ───────────────────────────────────────────────
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

# Write resolved XDG paths into .env (idempotent — updates if present, appends if not)
for var in OPENPALM_DATA_HOME OPENPALM_CONFIG_HOME OPENPALM_STATE_HOME; do
  val="${!var}"
  if grep -q "^${var}=" .env; then
    sed -i "s|^${var}=.*|${var}=${val}|" .env
  else
    echo "${var}=${val}" >> .env
  fi
done

# ── Create XDG directory trees ─────────────────────────────────────────────
# Data — persistent storage (databases, blobs)
mkdir -p "$OPENPALM_DATA_HOME"/{postgres,qdrant,openmemory,shared,caddy}
mkdir -p "$OPENPALM_DATA_HOME"/admin-app/{bundles,change-states}

# Config — user-editable configuration
mkdir -p "$OPENPALM_CONFIG_HOME"/{opencode-core,opencode-channel,caddy,channels}

# State — runtime state, logs, workspace
mkdir -p "$OPENPALM_STATE_HOME"/{opencode-core,opencode-channel,gateway,caddy,workspace}
mkdir -p "$OPENPALM_STATE_HOME"/{observability,backups}

# ── Seed default configs into XDG config home ─────────────────────────────
# Only copies files that don't already exist so manual edits are preserved.

seed_file() {
  local src="$1" dst="$2"
  [ -f "$dst" ] || cp "$src" "$dst"
}

seed_dir() {
  local src="$1" dst="$2"
  [ -d "$dst" ] || cp -r "$src" "$dst"
}

# opencode-core config
seed_file "$ROOT_DIR/config/opencode-core/opencode.jsonc" "$OPENPALM_CONFIG_HOME/opencode-core/opencode.jsonc"
seed_file "$ROOT_DIR/config/opencode-core/AGENTS.md"      "$OPENPALM_CONFIG_HOME/opencode-core/AGENTS.md"
seed_dir  "$ROOT_DIR/config/opencode-core/skills"          "$OPENPALM_CONFIG_HOME/opencode-core/skills"

# opencode-channel config
seed_file "$ROOT_DIR/config/opencode-channel/opencode.channel.jsonc" "$OPENPALM_CONFIG_HOME/opencode-channel/opencode.channel.jsonc"
seed_file "$ROOT_DIR/config/opencode-channel/AGENTS.md"              "$OPENPALM_CONFIG_HOME/opencode-channel/AGENTS.md"
seed_dir  "$ROOT_DIR/config/opencode-channel/skills"                 "$OPENPALM_CONFIG_HOME/opencode-channel/skills"

# Caddy config
seed_file "$ROOT_DIR/caddy/Caddyfile" "$OPENPALM_CONFIG_HOME/caddy/Caddyfile"

# Channel env files
for env_file in "$ROOT_DIR"/config/channel-env/*.env; do
  [ -f "$env_file" ] && seed_file "$env_file" "$OPENPALM_CONFIG_HOME/channels/$(basename "$env_file")"
done

echo ""
echo "Directory structure created. Config seeded from defaults."
echo ""

# ── Start services ─────────────────────────────────────────────────────────
echo "Starting core services..."
docker compose up -d --build

echo "If you want channel adapters too: docker compose --profile channels up -d --build"

for _ in $(seq 1 40); do
  if curl -fsS http://localhost:80/health >/dev/null 2>&1; then
    echo "OpenPalm is ready: http://localhost"
    echo "Admin dashboard (LAN only): http://localhost/admin"
    echo "Open Memory UI (LAN only): http://localhost/openmemory"
    echo ""
    echo "Host directories:"
    echo "  Data   → $OPENPALM_DATA_HOME"
    echo "  Config → $OPENPALM_CONFIG_HOME"
    echo "  State  → $OPENPALM_STATE_HOME"
    exit 0
  fi
  sleep 2
done

echo "Health check failed. Inspect logs with: docker compose logs"
exit 1
