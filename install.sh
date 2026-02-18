#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

RUNTIME_OVERRIDE=""
OPEN_BROWSER=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --runtime. Expected: docker | podman | orbstack"
        exit 1
      fi
      RUNTIME_OVERRIDE="$2"
      shift 2
      ;;
    --no-open)
      OPEN_BROWSER=0
      shift
      ;;
    -h|--help)
      cat <<'HELP'
Usage: ./install.sh [--runtime docker|podman|orbstack] [--no-open]

Options:
  --runtime   Force a container runtime platform selection.
  --no-open   Do not auto-open the admin setup URL after services are healthy.
  -h, --help  Show this help.
HELP
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Run ./install.sh --help for usage."
      exit 1
      ;;
  esac
done

detect_os() {
  local uname_s
  uname_s="$(uname -s 2>/dev/null || echo unknown)"
  case "$uname_s" in
    Linux*) echo "linux" ;;
    Darwin*) echo "macos" ;;
    CYGWIN*|MINGW*|MSYS*) echo "windows-bash" ;;
    *) echo "unknown" ;;
  esac
}

OS_NAME="$(detect_os)"

if [ "$OS_NAME" = "unknown" ]; then
  echo "Unsupported OS detected. Please run from Linux, macOS, or Windows Bash."
  exit 1
fi

upsert_env_var() {
  local key="$1"
  local value="$2"
  python3 - "$key" "$value" <<'PY'
import pathlib
import re
import sys

key = sys.argv[1]
value = sys.argv[2]
env_file = pathlib.Path('.env')

if env_file.exists():
    text = env_file.read_text()
else:
    text = ""

pattern = rf"(?m)^{re.escape(key)}=.*$"
replacement = f"{key}={value}"

if re.search(pattern, text):
    text = re.sub(pattern, replacement, text, count=1)
else:
    if text and not text.endswith("\n"):
        text += "\n"
    text += replacement + "\n"

env_file.write_text(text)
PY
}

compose_version_ok() {
  local bin="$1"
  local sub="$2"
  if [ -n "$sub" ]; then
    "$bin" "$sub" version >/dev/null 2>&1
  else
    "$bin" version >/dev/null 2>&1
  fi
}

OPENPALM_CONTAINER_PLATFORM="${RUNTIME_OVERRIDE:-${OPENPALM_CONTAINER_PLATFORM:-docker}}"
OPENPALM_COMPOSE_BIN=""
OPENPALM_COMPOSE_SUBCOMMAND=""
OPENPALM_CONTAINER_SOCKET_PATH=""
OPENPALM_CONTAINER_SOCKET_IN_CONTAINER="/var/run/openpalm-container.sock"
OPENPALM_CONTAINER_SOCKET_URI=""

case "$OPENPALM_CONTAINER_PLATFORM" in
  docker)
    OPENPALM_COMPOSE_BIN="docker"
    OPENPALM_COMPOSE_SUBCOMMAND="compose"
    OPENPALM_CONTAINER_SOCKET_PATH="${OPENPALM_CONTAINER_SOCKET_PATH:-/var/run/docker.sock}"
    ;;
  podman)
    OPENPALM_COMPOSE_BIN="podman"
    OPENPALM_COMPOSE_SUBCOMMAND="compose"
    if [ "$OS_NAME" = "linux" ]; then
      OPENPALM_CONTAINER_SOCKET_PATH="${OPENPALM_CONTAINER_SOCKET_PATH:-/run/user/$(id -u)/podman/podman.sock}"
    else
      OPENPALM_CONTAINER_SOCKET_PATH="${OPENPALM_CONTAINER_SOCKET_PATH:-/var/run/docker.sock}"
    fi
    ;;
  orbstack)
    OPENPALM_COMPOSE_BIN="docker"
    OPENPALM_COMPOSE_SUBCOMMAND="compose"
    OPENPALM_CONTAINER_SOCKET_PATH="${OPENPALM_CONTAINER_SOCKET_PATH:-$HOME/.orbstack/run/docker.sock}"
    if [ "$OS_NAME" != "macos" ]; then
      echo "OrbStack is only supported on macOS."
      exit 1
    fi
    ;;
  *)
    echo "Unsupported runtime '$OPENPALM_CONTAINER_PLATFORM'. Use docker, podman, or orbstack."
    exit 1
    ;;
esac

if [ "$OPENPALM_CONTAINER_PLATFORM" = "orbstack" ] && [ ! -S "$OPENPALM_CONTAINER_SOCKET_PATH" ]; then
  OPENPALM_CONTAINER_SOCKET_PATH="/var/run/docker.sock"
fi

if ! command -v "$OPENPALM_COMPOSE_BIN" >/dev/null 2>&1; then
  echo "Container CLI '$OPENPALM_COMPOSE_BIN' not found for runtime '$OPENPALM_CONTAINER_PLATFORM'."
  case "$OS_NAME" in
    macos)
      if [ "$OPENPALM_CONTAINER_PLATFORM" = "orbstack" ]; then
        echo "Install/start OrbStack and ensure Docker-compatible CLI is available."
      else
        echo "Install Docker Desktop (docker) or Podman Desktop/CLI (podman), then rerun."
      fi
      ;;
    linux)
      echo "Install Docker Engine + Compose plugin, or Podman + podman-compose support, then rerun."
      ;;
    windows-bash)
      echo "Install Docker Desktop or Podman Desktop, ensure the CLI is in PATH, then rerun from Bash."
      ;;
  esac
  exit 1
fi

if ! compose_version_ok "$OPENPALM_COMPOSE_BIN" "$OPENPALM_COMPOSE_SUBCOMMAND"; then
  echo "Compose command check failed for '$OPENPALM_COMPOSE_BIN ${OPENPALM_COMPOSE_SUBCOMMAND}'."
  if [ "$OPENPALM_CONTAINER_PLATFORM" = "podman" ]; then
    echo "Ensure Podman compose support is installed and working."
  else
    echo "Ensure your container runtime is running and compose support is available."
  fi
  exit 1
fi

OPENPALM_CONTAINER_SOCKET_URI="unix://$OPENPALM_CONTAINER_SOCKET_IN_CONTAINER"

COMPOSE_CMD=("$OPENPALM_COMPOSE_BIN")
if [ -n "$OPENPALM_COMPOSE_SUBCOMMAND" ]; then
  COMPOSE_CMD+=("$OPENPALM_COMPOSE_SUBCOMMAND")
fi

echo "Detected OS: $OS_NAME"
echo "Selected container runtime: $OPENPALM_CONTAINER_PLATFORM"
echo "Compose command: ${COMPOSE_CMD[*]}"

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
for marker in ['replace-with-long-random-token','replace-with-controller-token','replace-with-pg-password','replace-with-channel-secret','replace-with-inbound-token','replace-with-telegram-webhook-secret']:
    text = text.replace(marker, secrets.token_urlsafe(36), 1)
p.write_text(text)
print('Created .env with generated secure defaults.')
PY
fi

# Write resolved configuration into .env (idempotent)
upsert_env_var OPENPALM_DATA_HOME "$OPENPALM_DATA_HOME"
upsert_env_var OPENPALM_CONFIG_HOME "$OPENPALM_CONFIG_HOME"
upsert_env_var OPENPALM_STATE_HOME "$OPENPALM_STATE_HOME"
upsert_env_var OPENPALM_CONTAINER_PLATFORM "$OPENPALM_CONTAINER_PLATFORM"
upsert_env_var OPENPALM_COMPOSE_BIN "$OPENPALM_COMPOSE_BIN"
upsert_env_var OPENPALM_COMPOSE_SUBCOMMAND "$OPENPALM_COMPOSE_SUBCOMMAND"
upsert_env_var OPENPALM_CONTAINER_SOCKET_PATH "$OPENPALM_CONTAINER_SOCKET_PATH"
upsert_env_var OPENPALM_CONTAINER_SOCKET_IN_CONTAINER "$OPENPALM_CONTAINER_SOCKET_IN_CONTAINER"
upsert_env_var OPENPALM_CONTAINER_SOCKET_URI "$OPENPALM_CONTAINER_SOCKET_URI"

# ── Create XDG directory trees ─────────────────────────────────────────────
# Data — persistent storage (databases, blobs)
mkdir -p "$OPENPALM_DATA_HOME"/{postgres,qdrant,openmemory,shared,caddy}
mkdir -p "$OPENPALM_DATA_HOME"/admin-app

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
"${COMPOSE_CMD[@]}" up -d --build

echo "If you want channel adapters too: ${COMPOSE_CMD[*]} --profile channels up -d --build"

HEALTH_URL="http://localhost:80/health"
SETUP_URL="http://localhost/admin"
SPIN='|/-\\'
READY=0

echo ""
for i in $(seq 1 90); do
  idx=$(( (i - 1) % 4 ))
  ch="${SPIN:$idx:1}"
  printf "\r[%s] Waiting for containers to become healthy..." "$ch"
  if (( i % 2 == 0 )) && curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
printf "\r"

if [ "$READY" -eq 1 ]; then
  echo "OpenPalm is ready: http://localhost"
  echo "Admin dashboard (LAN only): $SETUP_URL"
  echo "Open Memory UI (LAN only): http://localhost/admin/openmemory"
  echo ""
  echo "Container runtime config:"
  echo "  Platform        → $OPENPALM_CONTAINER_PLATFORM"
  echo "  Compose command → ${COMPOSE_CMD[*]}"
  echo "  Socket path     → $OPENPALM_CONTAINER_SOCKET_PATH"
  echo ""
  echo "Host directories:"
  echo "  Data   → $OPENPALM_DATA_HOME"
  echo "  Config → $OPENPALM_CONFIG_HOME"
  echo "  State  → $OPENPALM_STATE_HOME"

  if [ "$OPEN_BROWSER" -eq 1 ]; then
    case "$OS_NAME" in
      macos)
        open "$SETUP_URL" >/dev/null 2>&1 || true
        ;;
      linux)
        xdg-open "$SETUP_URL" >/dev/null 2>&1 || true
        ;;
      windows-bash)
        if command -v cmd.exe >/dev/null 2>&1; then
          cmd.exe /c start "" "$SETUP_URL" >/dev/null 2>&1 || true
        elif command -v powershell.exe >/dev/null 2>&1; then
          powershell.exe -NoProfile -Command "Start-Process '$SETUP_URL'" >/dev/null 2>&1 || true
        fi
        ;;
    esac
    echo "Opened setup UI in your default browser: $SETUP_URL"
  else
    echo "Auto-open skipped (--no-open). Complete setup at: $SETUP_URL"
  fi
  exit 0
fi

echo "Health check failed. Inspect logs with: ${COMPOSE_CMD[*]} logs"
exit 1
