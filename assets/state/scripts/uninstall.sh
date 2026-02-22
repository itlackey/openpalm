#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ ! -d "$ROOT_DIR/assets" ]; then
  ROOT_DIR="$(pwd)"
fi
cd "$ROOT_DIR"

RUNTIME_OVERRIDE=""
REMOVE_ALL=0
REMOVE_IMAGES=0
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
      shift
      ;;
    --remove-images)
      REMOVE_IMAGES=1
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
  --remove-all     Remove all OpenPalm config/state/data directories and local .env.
  --remove-images  Remove container images used by OpenPalm.
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

ENV_FILE=".env"
OPENPALM_DATA_HOME="${OPENPALM_DATA_HOME:-$(read_env_var OPENPALM_DATA_HOME "$ENV_FILE")}"
OPENPALM_CONFIG_HOME="${OPENPALM_CONFIG_HOME:-$(read_env_var OPENPALM_CONFIG_HOME "$ENV_FILE")}"
OPENPALM_STATE_HOME="${OPENPALM_STATE_HOME:-$(read_env_var OPENPALM_STATE_HOME "$ENV_FILE")}"
OPENPALM_CONTAINER_PLATFORM="${RUNTIME_OVERRIDE:-${OPENPALM_CONTAINER_PLATFORM:-$(read_env_var OPENPALM_CONTAINER_PLATFORM "$ENV_FILE")}}"

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
  rm -f "$ROOT_DIR/.env"
  echo "Removed OpenPalm data/config/state and local .env."
fi

# Remove CLI binary if it exists in the standard install location
CLI_PATH="$HOME/.local/bin/openpalm"
if [ -f "$CLI_PATH" ]; then
  echo "Removing CLI binary at $CLI_PATH"
  rm -f "$CLI_PATH"
fi

echo "Uninstall complete."
