#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"
ASSETS_DIR="$ROOT_DIR/assets"
ASSETS_TMP_DIR=""
INSTALL_ASSETS_DIR="$ASSETS_DIR"

cleanup_assets_tmp() {
  if [ -n "$ASSETS_TMP_DIR" ] && [ -d "$ASSETS_TMP_DIR" ]; then
    rm -rf "$ASSETS_TMP_DIR"
  fi
}

trap cleanup_assets_tmp EXIT

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
Usage: ./scripts/install.sh [--runtime docker|podman|orbstack] [--no-open]

Options:
  --runtime   Force a container runtime platform selection.
  --no-open   Do not auto-open the admin setup URL after services are healthy.
  -h, --help  Show this help.
HELP
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Run ./scripts/install.sh --help for usage."
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

detect_host_arch() {
  local uname_m
  uname_m="$(uname -m 2>/dev/null || echo unknown)"
  case "$uname_m" in
    x86_64|amd64) echo "amd64" ;;
    arm64|aarch64) echo "arm64" ;;
    *)
      echo "Unsupported CPU architecture '$uname_m'. Defaulting to amd64 images." >&2
      echo "amd64"
      ;;
  esac
}

OS_NAME="$(detect_os)"
OPENPALM_HOST_ARCH="$(detect_host_arch)"
OPENPALM_REPO_OWNER="${OPENPALM_REPO_OWNER:-itlackey}"
OPENPALM_REPO_NAME="${OPENPALM_REPO_NAME:-openpalm}"
OPENPALM_INSTALL_REF="${OPENPALM_INSTALL_REF:-main}"

if [ "$OS_NAME" = "unknown" ]; then
  echo "Unsupported OS detected. Please run from Linux or macOS."
  exit 1
fi

if [ "$OS_NAME" = "windows-bash" ]; then
  echo "This installer is for Linux/macOS shells."
  echo "On Windows, run the PowerShell installer instead:"
  echo '  pwsh -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/install.ps1 -OutFile $env:TEMP/openpalm-install.ps1; & $env:TEMP/openpalm-install.ps1"'
  exit 1
fi

bootstrap_install_assets() {
  if [ -f "$ASSETS_DIR/docker-compose.yml" ] \
    && [ -f "$ASSETS_DIR/system.env" ] \
    && [ -f "$ASSETS_DIR/user.env" ] \
    && [ -f "$ASSETS_DIR/caddy/Caddyfile" ] \
    && [ -f "$ASSETS_DIR/config/opencode-core/opencode.jsonc" ] \
    && [ -f "$ASSETS_DIR/config/channel-env/channel-chat.env" ]; then
    INSTALL_ASSETS_DIR="$ASSETS_DIR"
    return
  fi

  if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
    echo "Missing required tools to bootstrap installer assets. Please install curl and tar."
    exit 1
  fi

  local archive src_dir ref_url
  ASSETS_TMP_DIR="$(mktemp -d)"
  archive="$ASSETS_TMP_DIR/openpalm.tar.gz"
  ref_url="https://github.com/${OPENPALM_REPO_OWNER}/${OPENPALM_REPO_NAME}/archive/refs/heads/${OPENPALM_INSTALL_REF}.tar.gz"

  echo "Downloading install assets from ${OPENPALM_REPO_OWNER}/${OPENPALM_REPO_NAME} (ref: ${OPENPALM_INSTALL_REF})..."
  if ! curl -fsSL "$ref_url" -o "$archive"; then
    ref_url="https://github.com/${OPENPALM_REPO_OWNER}/${OPENPALM_REPO_NAME}/archive/refs/tags/${OPENPALM_INSTALL_REF}.tar.gz"
    curl -fsSL "$ref_url" -o "$archive"
  fi

  tar -xzf "$archive" -C "$ASSETS_TMP_DIR"
  src_dir="$(find "$ASSETS_TMP_DIR" -mindepth 1 -maxdepth 1 -type d -name "${OPENPALM_REPO_NAME}-*" | head -n 1)"

  if [ -z "$src_dir" ]; then
    echo "Failed to resolve installer assets from downloaded archive."
    rm -rf "$ASSETS_TMP_DIR"
    exit 1
  fi

  INSTALL_ASSETS_DIR="$src_dir/assets"
  if [ ! -d "$INSTALL_ASSETS_DIR" ]; then
    echo "Installer assets directory missing in archive: $INSTALL_ASSETS_DIR"
    exit 1
  fi
}

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

detect_runtime() {
  if [ -n "${RUNTIME_OVERRIDE:-}" ]; then
    echo "$RUNTIME_OVERRIDE"
    return
  fi

  if [ "$OS_NAME" = "macos" ] && [ -S "$HOME/.orbstack/run/docker.sock" ] && command -v docker >/dev/null 2>&1; then
    echo "orbstack"
    return
  fi

  if command -v docker >/dev/null 2>&1; then
    echo "docker"
    return
  fi

  if command -v podman >/dev/null 2>&1; then
    echo "podman"
    return
  fi

  echo ""
}

OPENPALM_CONTAINER_PLATFORM="${RUNTIME_OVERRIDE:-${OPENPALM_CONTAINER_PLATFORM:-}}"
if [ -z "$OPENPALM_CONTAINER_PLATFORM" ]; then
  OPENPALM_CONTAINER_PLATFORM="$(detect_runtime)"
fi
if [ -z "$OPENPALM_CONTAINER_PLATFORM" ]; then
  echo "No supported container runtime detected. Install docker, podman, or orbstack and rerun."
  exit 1
fi
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
OPENPALM_IMAGE_TAG="${OPENPALM_IMAGE_TAG:-latest-$OPENPALM_HOST_ARCH}"

COMPOSE_CMD=("$OPENPALM_COMPOSE_BIN")
if [ -n "$OPENPALM_COMPOSE_SUBCOMMAND" ]; then
  COMPOSE_CMD+=("$OPENPALM_COMPOSE_SUBCOMMAND")
fi

echo "Detected OS: $OS_NAME"
echo "Detected CPU architecture: $OPENPALM_HOST_ARCH"
echo "Selected container runtime: $OPENPALM_CONTAINER_PLATFORM"
echo "Compose command: ${COMPOSE_CMD[*]}"

bootstrap_install_assets
if [ ! -f "$INSTALL_ASSETS_DIR/docker-compose.yml" ]; then
  echo "Compose file not found in installer assets."
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
  cp "$INSTALL_ASSETS_DIR/system.env" .env
  python3 - <<'PY'
import secrets, pathlib
p = pathlib.Path('.env')
text = p.read_text()
for marker in [
    'replace-with-long-random-token',
    'replace-with-controller-token',
    'replace-with-pg-password',
    'replace-with-channel-chat-secret',
    'replace-with-channel-discord-secret',
    'replace-with-channel-voice-secret',
    'replace-with-channel-telegram-secret',
]:
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
upsert_env_var OPENPALM_IMAGE_TAG "$OPENPALM_IMAGE_TAG"

# ── Create XDG directory trees ─────────────────────────────────────────────
# Data — persistent storage (databases, blobs)
mkdir -p "$OPENPALM_DATA_HOME"/{postgres,qdrant,openmemory,shared,caddy}
mkdir -p "$OPENPALM_DATA_HOME"/admin

# Config — user-editable configuration
mkdir -p "$OPENPALM_CONFIG_HOME"/{opencode-core,caddy,channels}

# State — runtime state, logs, workspace
mkdir -p "$OPENPALM_STATE_HOME"/{opencode-core,gateway,caddy,workspace}
mkdir -p "$OPENPALM_STATE_HOME"/{observability,backups}

COMPOSE_FILE_PATH="$OPENPALM_STATE_HOME/docker-compose.yml"
cp "$INSTALL_ASSETS_DIR/docker-compose.yml" "$COMPOSE_FILE_PATH"
cp .env "$OPENPALM_STATE_HOME/.env"

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
seed_file "$INSTALL_ASSETS_DIR/config/opencode-core/opencode.jsonc" "$OPENPALM_CONFIG_HOME/opencode-core/opencode.jsonc"
seed_file "$INSTALL_ASSETS_DIR/config/opencode-core/AGENTS.md"      "$OPENPALM_CONFIG_HOME/opencode-core/AGENTS.md"
seed_dir  "$INSTALL_ASSETS_DIR/config/opencode-core/skills"         "$OPENPALM_CONFIG_HOME/opencode-core/skills"
seed_dir  "$INSTALL_ASSETS_DIR/config/opencode-core/ssh"            "$OPENPALM_CONFIG_HOME/opencode-core/ssh"

# Caddy config
seed_file "$INSTALL_ASSETS_DIR/caddy/Caddyfile" "$OPENPALM_CONFIG_HOME/caddy/Caddyfile"

# Channel env files
for env_file in "$INSTALL_ASSETS_DIR"/config/channel-env/*.env; do
  [ -f "$env_file" ] && seed_file "$env_file" "$OPENPALM_CONFIG_HOME/channels/$(basename "$env_file")"
done

# Runtime secrets and user overrides for opencode-core
seed_file "$INSTALL_ASSETS_DIR/secrets.env" "$OPENPALM_CONFIG_HOME/secrets.env"
seed_file "$INSTALL_ASSETS_DIR/user.env" "$OPENPALM_CONFIG_HOME/user.env"

echo ""
echo "Directory structure created. Config seeded from defaults."
echo ""

# ── Start services ─────────────────────────────────────────────────────────
echo "Starting core services..."
"${COMPOSE_CMD[@]}" --env-file "$OPENPALM_STATE_HOME/.env" -f "$COMPOSE_FILE_PATH" up -d

echo "If you want channel adapters too: ${COMPOSE_CMD[*]} --env-file $OPENPALM_STATE_HOME/.env -f $COMPOSE_FILE_PATH --profile channels up -d"

ADMIN_READY_URL="http://localhost/admin/setup/status"
SETUP_URL="http://localhost/admin"
SPIN='|/-\\'
READY=0

echo ""
for i in $(seq 1 90); do
  idx=$(( (i - 1) % 4 ))
  ch="${SPIN:$idx:1}"
  printf "\r[%s] Waiting for admin setup UI to come online..." "$ch"
  if (( i % 2 == 0 )) && curl -fsS "$ADMIN_READY_URL" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
printf "\r"

if [ "$READY" -eq 1 ]; then
  echo "OpenPalm setup is ready: $SETUP_URL"
  echo "Containers will continue coming online while you complete setup."
  echo "Open Memory UI (LAN only): http://localhost/admin/openmemory"
  echo ""
  echo "Container runtime config:"
  echo "  Platform        → $OPENPALM_CONTAINER_PLATFORM"
  echo "  Compose command → ${COMPOSE_CMD[*]}"
  echo "  Compose file    → $COMPOSE_FILE_PATH"
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
    esac
    echo "Opened setup UI in your default browser: $SETUP_URL"
  else
    echo "Auto-open skipped (--no-open). Complete setup at: $SETUP_URL"
  fi
  exit 0
fi

echo "Health check failed. Inspect logs with: ${COMPOSE_CMD[*]} logs"
exit 1
