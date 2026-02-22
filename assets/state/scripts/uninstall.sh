#!/usr/bin/env bash
set -euo pipefail

# Resolve .env from XDG state home or common locations
# (does not assume the script runs from the repo root)

RUNTIME_OVERRIDE=""
REMOVE_ALL=0
REMOVE_IMAGES=0
REMOVE_BINARY=0
ASSUME_YES=0

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
    --remove-all)
      REMOVE_ALL=1
      REMOVE_BINARY=1
      shift
      ;;
    --remove-images)
      REMOVE_IMAGES=1
      shift
      ;;
    --remove-binary)
      REMOVE_BINARY=1
      shift
      ;;
    --yes)
      ASSUME_YES=1
      shift
      ;;
    -h|--help)
      cat <<'HELP'
Usage: ./assets/state/scripts/uninstall.sh [--runtime docker|podman|orbstack] [--remove-all] [--remove-images] [--yes]

Options:
  --runtime        Force a container runtime platform selection.
  --remove-all     Remove all OpenPalm config/state/data directories, local .env, and CLI binary.
  --remove-images  Remove container images used by OpenPalm.
  --remove-binary  Remove the openpalm CLI binary from ~/.local/bin.
  --yes            Skip confirmation prompts.
  -h, --help       Show this help.
HELP
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Run ./assets/state/scripts/uninstall.sh --help for usage."
      exit 1
      ;;
  esac
done

read_env_var() {
  local key="$1"
  local file="$2"
  [ -f "$file" ] || return 0
  awk -F= -v key="$key" '$1==key { sub(/^[^=]*=/,""); print; exit }' "$file"
}

OS_NAME="$(uname -s 2>/dev/null || echo unknown)"
case "$OS_NAME" in
  Linux*) OS_NAME="linux" ;;
  Darwin*) OS_NAME="macos" ;;
  CYGWIN*|MINGW*|MSYS*) OS_NAME="windows-bash" ;;
  *) OS_NAME="unknown" ;;
esac

if [ "$OS_NAME" = "windows-bash" ]; then
  echo "This uninstaller is for Linux/macOS shells."
  echo "On Windows, run the PowerShell uninstaller instead:"
  echo "  1) iwr https://raw.githubusercontent.com/itlackey/openpalm/main/assets/state/scripts/uninstall.ps1 -OutFile \$env:TEMP/openpalm-uninstall.ps1"
  echo "  2) & \$env:TEMP/openpalm-uninstall.ps1"
  exit 1
fi

# Try state home .env first (canonical), then CWD .env as fallback
STATE_ENV_FILE="${OPENPALM_STATE_HOME:-${XDG_STATE_HOME:-$HOME/.local/state}/openpalm}/.env"
CWD_ENV_FILE=".env"
if [ -f "$STATE_ENV_FILE" ]; then
  ENV_FILE="$STATE_ENV_FILE"
elif [ -f "$CWD_ENV_FILE" ]; then
  ENV_FILE="$CWD_ENV_FILE"
else
  ENV_FILE=""
fi

if [ -n "$ENV_FILE" ]; then
  OPENPALM_DATA_HOME="${OPENPALM_DATA_HOME:-$(read_env_var OPENPALM_DATA_HOME "$ENV_FILE")}"
  OPENPALM_CONFIG_HOME="${OPENPALM_CONFIG_HOME:-$(read_env_var OPENPALM_CONFIG_HOME "$ENV_FILE")}"
  OPENPALM_STATE_HOME="${OPENPALM_STATE_HOME:-$(read_env_var OPENPALM_STATE_HOME "$ENV_FILE")}"
  OPENPALM_CONTAINER_PLATFORM="${RUNTIME_OVERRIDE:-${OPENPALM_CONTAINER_PLATFORM:-$(read_env_var OPENPALM_CONTAINER_PLATFORM "$ENV_FILE")}}"
else
  OPENPALM_CONTAINER_PLATFORM="${RUNTIME_OVERRIDE:-${OPENPALM_CONTAINER_PLATFORM:-}}"
fi

OPENPALM_DATA_HOME="${OPENPALM_DATA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/openpalm}"
OPENPALM_CONFIG_HOME="${OPENPALM_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/openpalm}"
OPENPALM_STATE_HOME="${OPENPALM_STATE_HOME:-${XDG_STATE_HOME:-$HOME/.local/state}/openpalm}"

if [ -z "$OPENPALM_CONTAINER_PLATFORM" ]; then
  if [ "$OS_NAME" = "macos" ] && [ -S "$HOME/.orbstack/run/docker.sock" ] && command -v docker >/dev/null 2>&1; then
    OPENPALM_CONTAINER_PLATFORM="orbstack"
  elif command -v docker >/dev/null 2>&1; then
    OPENPALM_CONTAINER_PLATFORM="docker"
  elif command -v podman >/dev/null 2>&1; then
    OPENPALM_CONTAINER_PLATFORM="podman"
  fi
fi

OPENPALM_COMPOSE_BIN=""
OPENPALM_COMPOSE_SUBCOMMAND=""
case "$OPENPALM_CONTAINER_PLATFORM" in
  docker)
    OPENPALM_COMPOSE_BIN="docker"
    OPENPALM_COMPOSE_SUBCOMMAND="compose"
    ;;
  podman)
    OPENPALM_COMPOSE_BIN="podman"
    OPENPALM_COMPOSE_SUBCOMMAND="compose"
    ;;
  orbstack)
    OPENPALM_COMPOSE_BIN="docker"
    OPENPALM_COMPOSE_SUBCOMMAND="compose"
    ;;
  "")
    ;;
  *)
    echo "Unsupported runtime '$OPENPALM_CONTAINER_PLATFORM'. Use docker, podman, or orbstack."
    exit 1
    ;;
esac

COMPOSE_FILE_PATH="$OPENPALM_STATE_HOME/docker-compose.yml"
COMPOSE_ENV_FILE="$OPENPALM_STATE_HOME/.env"
if [ ! -f "$COMPOSE_ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  COMPOSE_ENV_FILE="$ENV_FILE"
fi

echo "Planned uninstall actions:"
echo "  Runtime: ${OPENPALM_CONTAINER_PLATFORM:-auto-unavailable}"
echo "  Stop/remove containers: yes"
echo "  Remove images: $([ "$REMOVE_IMAGES" -eq 1 ] && echo yes || echo no)"
echo "  Remove all data/config/state: $([ "$REMOVE_ALL" -eq 1 ] && echo yes || echo no)"
echo "  Remove CLI binary: $([ "$REMOVE_BINARY" -eq 1 ] && echo yes || echo no)"
echo "  Data dir: $OPENPALM_DATA_HOME"
echo "  Config dir: $OPENPALM_CONFIG_HOME"
echo "  State dir: $OPENPALM_STATE_HOME"

if [ "$ASSUME_YES" -ne 1 ]; then
  printf "Continue? [y/N] "
  read -r confirm
  case "$confirm" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

if [ -n "$OPENPALM_COMPOSE_BIN" ] && command -v "$OPENPALM_COMPOSE_BIN" >/dev/null 2>&1 && [ -f "$COMPOSE_FILE_PATH" ]; then
  COMPOSE_CMD=("$OPENPALM_COMPOSE_BIN")
  if [ -n "$OPENPALM_COMPOSE_SUBCOMMAND" ]; then
    COMPOSE_CMD+=("$OPENPALM_COMPOSE_SUBCOMMAND")
  fi
  DOWN_ARGS=(--env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE_PATH" down --remove-orphans)
  if [ "$REMOVE_IMAGES" -eq 1 ]; then
    DOWN_ARGS+=(--rmi all)
  fi
  "${COMPOSE_CMD[@]}" "${DOWN_ARGS[@]}"
else
  echo "Compose runtime or file not found; skipping container shutdown."
fi

if [ "$REMOVE_ALL" -eq 1 ]; then
  rm -rf "$OPENPALM_DATA_HOME" "$OPENPALM_CONFIG_HOME" "$OPENPALM_STATE_HOME"
  # Remove CWD .env if it exists (best-effort)
  rm -f ".env" 2>/dev/null || true
  echo "Removed OpenPalm data/config/state and local .env."
fi

if [ "$REMOVE_BINARY" -eq 1 ]; then
  BINARY_PATH="$HOME/.local/bin/openpalm"
  if [ -f "$BINARY_PATH" ]; then
    rm -f "$BINARY_PATH"
    echo "Removed CLI binary: $BINARY_PATH"
  else
    echo "CLI binary not found at $BINARY_PATH — it may have been installed elsewhere."
  fi
fi

echo ""
echo "Note: ~/openpalm (assistant working directory) was not removed."
echo "  Delete it manually if you no longer need it: rm -rf ~/openpalm"
echo ""

echo "Uninstall complete."
