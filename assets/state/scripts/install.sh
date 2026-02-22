#!/usr/bin/env bash
set -euo pipefail

# ── Bootstrap wrapper ────────────────────────────────────────────────────────
#
# This script installs the OpenPalm stack. It works in two modes:
#
#   1. Binary mode (preferred) — downloads the pre-compiled `openpalm` CLI
#      from GitHub Releases and delegates to `openpalm install`.
#
#   2. Bash fallback — if no binary release is available yet (or the download
#      fails), the full install logic runs right here in pure bash.
#
# Users can install via any of these one-liners:
#
#   curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/assets/state/scripts/install.sh | bash
#   bunx openpalm install
#   npx openpalm install
#
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd || pwd)"
if [ ! -d "$ROOT_DIR/assets" ]; then
  ROOT_DIR="$(pwd)"
fi
cd "$ROOT_DIR"
ASSETS_DIR="$ROOT_DIR/assets"
ASSETS_TMP_DIR=""
INSTALL_ASSETS_DIR="$ASSETS_DIR"

cleanup() {
  if [ -n "${ASSETS_TMP_DIR:-}" ] && [ -d "$ASSETS_TMP_DIR" ]; then
    rm -rf "$ASSETS_TMP_DIR"
  fi
  if [ -n "${BINARY_TMP:-}" ] && [ -f "$BINARY_TMP" ]; then
    rm -f "$BINARY_TMP"
  fi
}
trap cleanup EXIT

# ── Parse arguments ──────────────────────────────────────────────────────────

RUNTIME_OVERRIDE=""
OPEN_BROWSER=1
CLI_ARGS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --runtime. Expected: docker | podman | orbstack"
        exit 1
      fi
      RUNTIME_OVERRIDE="$2"
      CLI_ARGS+=(--runtime "$2")
      shift 2
      ;;
    --no-open)
      OPEN_BROWSER=0
      CLI_ARGS+=(--no-open)
      shift
      ;;
    --ref)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --ref."
        exit 1
      fi
      CLI_ARGS+=(--ref "$2")
      shift 2
      ;;
    -h|--help)
      cat <<'HELP'
Usage: install.sh [--runtime docker|podman|orbstack] [--no-open] [--ref <branch|tag>]

Install the OpenPalm stack. Downloads the pre-compiled CLI binary if
available, otherwise falls back to a pure-bash installer.

Options:
  --runtime   Force a container runtime platform selection.
  --no-open   Do not auto-open the admin setup URL after services are healthy.
  --ref       Git ref (branch or tag) for asset download (default: main).
  -h, --help  Show this help.
HELP
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Run install.sh --help for usage."
      exit 1
      ;;
  esac
done

# ── Detect host platform ────────────────────────────────────────────────────

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
  echo '  pwsh -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/itlackey/openpalm/main/assets/state/scripts/install.ps1 -OutFile $env:TEMP/openpalm-install.ps1; & $env:TEMP/openpalm-install.ps1"'
  exit 1
fi

# ── Try binary mode ──────────────────────────────────────────────────────────
#
# Attempt to download the pre-compiled openpalm binary from GitHub Releases.
# If it works, delegate entirely to `openpalm install` and exit.

try_binary_install() {
  command -v curl >/dev/null 2>&1 || return 1

  # Map host arch to binary suffix
  local bin_arch
  case "$OPENPALM_HOST_ARCH" in
    amd64) bin_arch="x64" ;;
    arm64) bin_arch="arm64" ;;
    *) return 1 ;;
  esac

  # Map OS to binary suffix
  local bin_os
  case "$OS_NAME" in
    linux) bin_os="linux" ;;
    macos) bin_os="darwin" ;;
    *) return 1 ;;
  esac

  local binary_name="openpalm-${bin_os}-${bin_arch}"
  local download_url="https://github.com/${OPENPALM_REPO_OWNER}/${OPENPALM_REPO_NAME}/releases/latest/download/${binary_name}"

  BINARY_TMP="$(mktemp)"

  echo "Downloading OpenPalm CLI..."
  if curl -fsSL --connect-timeout 10 --max-time 120 "$download_url" -o "$BINARY_TMP" 2>/dev/null; then
    chmod +x "$BINARY_TMP"

    # Quick sanity check — the binary should respond to --version
    if "$BINARY_TMP" version >/dev/null 2>&1; then
      echo "Running OpenPalm CLI installer..."
      "$BINARY_TMP" install "${CLI_ARGS[@]+"${CLI_ARGS[@]}"}"
      return 0
    fi
  fi

  # Download failed or binary is invalid — fall through to bash installer
  rm -f "$BINARY_TMP"
  BINARY_TMP=""
  return 1
}

if try_binary_install; then
  exit 0
fi

echo "Pre-compiled binary not available — using bash installer."
echo ""

# ── Bash fallback installer ──────────────────────────────────────────────────
#
# Everything below is the full install logic in pure bash, requiring only
# curl, tar, and a container runtime (Docker/Podman/OrbStack).

bootstrap_install_assets() {
  if [ -f "$ASSETS_DIR/state/docker-compose.yml" ] \
    && [ -f "$ASSETS_DIR/config/system.env" ] \
    && [ -f "$ASSETS_DIR/state/scripts/uninstall.sh" ] \
    && [ -f "$ASSETS_DIR/state/caddy/Caddyfile" ] \
    && [ -f "$ASSETS_DIR/config/stack-spec.json" ]; then
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
  local tmp
  tmp="$(mktemp)"

  if [ -f .env ]; then
    awk -v key="$key" -v value="$value" '
      BEGIN { updated = 0 }
      $0 ~ "^" key "=" && updated == 0 {
        print key "=" value
        updated = 1
        next
      }
      { print }
      END {
        if (updated == 0) print key "=" value
      }
    ' .env > "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" > "$tmp"
  fi

  mv "$tmp" .env
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' | cut -c1-64
    return
  fi

  if command -v base64 >/dev/null 2>&1; then
    head -c 48 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' | cut -c1-64
    return
  fi

  echo "Unable to generate secure tokens. Install openssl (preferred) or base64 coreutils and rerun." >&2
  exit 1
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
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  No container runtime found                                 ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  echo "  OpenPalm runs inside containers and needs Docker (recommended)"
  echo "  or Podman installed first."
  echo ""
  case "$OS_NAME" in
    macos)
      echo "  For macOS, install ONE of:"
      echo ""
      echo "    Docker Desktop (free for personal use):"
      echo "      https://www.docker.com/products/docker-desktop/"
      echo ""
      echo "    OrbStack (lightweight, fast):"
      echo "      https://orbstack.dev/download"
      echo ""
      echo "    Or via Homebrew:"
      echo "      brew install --cask docker"
      echo ""
      ;;
    linux)
      echo "  For Linux, install Docker Engine + Compose plugin:"
      echo ""
      echo "    Quick install (official script):"
      echo "      curl -fsSL https://get.docker.com | sh"
      echo ""
      echo "    Or follow the guide at:"
      echo "      https://docs.docker.com/engine/install/"
      echo ""
      echo "    After installing, make sure Docker is running:"
      echo "      sudo systemctl start docker"
      echo ""
      ;;
  esac
  echo "  After installing, rerun this installer."
  echo ""
  exit 1
fi
OPENPALM_COMPOSE_BIN=""
OPENPALM_COMPOSE_SUBCOMMAND=""
OPENPALM_CONTAINER_SOCKET_PATH=""
OPENPALM_CONTAINER_SOCKET_IN_CONTAINER="/var/run/docker.sock"
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
  echo ""
  echo "Container CLI '$OPENPALM_COMPOSE_BIN' not found in PATH."
  echo ""
  case "$OS_NAME" in
    macos)
      if [ "$OPENPALM_CONTAINER_PLATFORM" = "orbstack" ]; then
        echo "  Open OrbStack.app — it registers the Docker CLI automatically."
      else
        echo "  Open Docker Desktop.app — it registers the Docker CLI automatically."
        echo "  If already installed, make sure the app is running."
      fi
      ;;
    linux)
      echo "  Install Docker Engine + Compose plugin:"
      echo "    curl -fsSL https://get.docker.com | sh"
      echo ""
      echo "  Or see: https://docs.docker.com/engine/install/"
      ;;
  esac
  echo ""
  exit 1
fi

# Check if the Docker daemon is actually running (common gotcha)
if [ "$OPENPALM_CONTAINER_PLATFORM" != "podman" ]; then
  if ! "$OPENPALM_COMPOSE_BIN" info >/dev/null 2>&1; then
    echo ""
    echo "Docker is installed but the daemon is not running."
    echo ""
    case "$OS_NAME" in
      macos)
        echo "  Open Docker Desktop (or OrbStack) and wait for it to start,"
        echo "  then rerun this installer."
        ;;
      linux)
        echo "  Start the Docker service:"
        echo "    sudo systemctl start docker"
        echo ""
        echo "  To start Docker automatically on boot:"
        echo "    sudo systemctl enable docker"
        ;;
    esac
    echo ""
    exit 1
  fi
fi

if ! compose_version_ok "$OPENPALM_COMPOSE_BIN" "$OPENPALM_COMPOSE_SUBCOMMAND"; then
  echo ""
  echo "Compose support not available for '$OPENPALM_COMPOSE_BIN'."
  echo ""
  if [ "$OPENPALM_CONTAINER_PLATFORM" = "podman" ]; then
    echo "  Install podman-compose:"
    echo "    pip install podman-compose"
    echo "  Or: https://github.com/containers/podman-compose"
  else
    echo "  Docker Compose is included in Docker Desktop."
    echo "  For Docker Engine on Linux, install the Compose plugin:"
    echo "    sudo apt-get install docker-compose-plugin"
    echo "  Or: https://docs.docker.com/compose/install/"
  fi
  echo ""
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
if [ ! -f "$INSTALL_ASSETS_DIR/state/docker-compose.yml" ]; then
  echo "Compose file not found in installer assets."
  exit 1
fi

# ── Pre-flight checks ────────────────────────────────────────────────────
preflight_ok=1

# Check available disk space (need ~3GB minimum for images + data)
if command -v df >/dev/null 2>&1; then
  avail_kb="$(df -k "$HOME" 2>/dev/null | awk 'NR==2{print $4}')"
  if [ -n "$avail_kb" ] && [ "$avail_kb" -lt 3000000 ] 2>/dev/null; then
    avail_gb=$(( avail_kb / 1048576 ))
    echo ""
    echo "WARNING: Low disk space — only ~${avail_gb}GB available."
    echo "  OpenPalm needs roughly 3GB for container images and data."
    echo "  Free up space or install to a drive with more room."
    echo ""
    preflight_ok=0
  fi
fi

# Check if port 80 is already in use (Caddy needs it)
if command -v lsof >/dev/null 2>&1; then
  if lsof -iTCP:80 -sTCP:LISTEN -P -n >/dev/null 2>&1; then
    echo ""
    echo "WARNING: Port 80 is already in use by another process."
    echo "  OpenPalm needs port 80 for its web interface."
    echo "  Stop the other service or free port 80, then rerun."
    echo ""
    if command -v lsof >/dev/null 2>&1; then
      echo "  Process using port 80:"
      lsof -iTCP:80 -sTCP:LISTEN -P -n 2>/dev/null | head -3
      echo ""
    fi
    preflight_ok=0
  fi
elif command -v ss >/dev/null 2>&1; then
  if ss -tlnp 2>/dev/null | grep -q ':80 '; then
    echo ""
    echo "WARNING: Port 80 is already in use by another process."
    echo "  OpenPalm needs port 80 for its web interface."
    echo "  Stop the other service or free port 80, then rerun."
    echo ""
    preflight_ok=0
  fi
fi

if [ "$preflight_ok" -eq 0 ]; then
  echo "Pre-flight checks found issues (see above). Continuing anyway..."
  echo ""
fi

# ── Resolve XDG Base Directory paths ───────────────────────────────────────
OPENPALM_DATA_HOME="${OPENPALM_DATA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/openpalm}"
OPENPALM_CONFIG_HOME="${OPENPALM_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/openpalm}"
OPENPALM_STATE_HOME="${OPENPALM_STATE_HOME:-${XDG_STATE_HOME:-$HOME/.local/state}/openpalm}"

echo "XDG directory layout:"
echo "  Data   → $OPENPALM_DATA_HOME"
echo "  Config → $OPENPALM_CONFIG_HOME"
echo "  State  → $OPENPALM_STATE_HOME"

# ── Generate .env if missing ───────────────────────────────────────────────
GENERATED_ADMIN_TOKEN=""
if [ ! -f .env ]; then
  cp "$INSTALL_ASSETS_DIR/config/system.env" .env
  GENERATED_ADMIN_TOKEN="$(generate_token)"
  upsert_env_var ADMIN_TOKEN "$GENERATED_ADMIN_TOKEN"
  upsert_env_var POSTGRES_PASSWORD "$(generate_token)"
  upsert_env_var CHANNEL_CHAT_SECRET "$(generate_token)"
  upsert_env_var CHANNEL_DISCORD_SECRET "$(generate_token)"
  upsert_env_var CHANNEL_VOICE_SECRET "$(generate_token)"
  upsert_env_var CHANNEL_TELEGRAM_SECRET "$(generate_token)"
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  YOUR ADMIN PASSWORD (save this!)                           ║"
  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "║                                                              ║"
  echo "  $GENERATED_ADMIN_TOKEN"
  echo "║                                                              ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  echo "  You will need this password to log in to the admin dashboard."
  echo "  It is also saved in: $(pwd)/.env"
  echo ""
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
upsert_env_var OPENPALM_ENABLED_CHANNELS "${OPENPALM_ENABLED_CHANNELS:-}"

# ── Create XDG directory trees ─────────────────────────────────────────────
mkdir -p "$OPENPALM_DATA_HOME"/{postgres,qdrant,openmemory,assistant}
mkdir -p "$OPENPALM_CONFIG_HOME"
mkdir -p "$OPENPALM_STATE_HOME"/{admin,gateway,postgres,qdrant,openmemory,openmemory-ui,assistant,channel-chat,channel-discord,channel-voice,channel-telegram,automations,rendered,logs,tmp,observability,backups}
mkdir -p "$OPENPALM_STATE_HOME"/rendered/{caddy,snippets}
mkdir -p "$OPENPALM_STATE_HOME"/caddy/{config,data}
mkdir -p "$OPENPALM_STATE_HOME"/rendered/caddy/snippets
mkdir -p "$HOME"/openpalm

COMPOSE_FILE_PATH="$OPENPALM_STATE_HOME/rendered/docker-compose.yml"
cp "$INSTALL_ASSETS_DIR/state/docker-compose.yml" "$COMPOSE_FILE_PATH"
cp .env "$OPENPALM_STATE_HOME/.env"

# ── Seed default configs into XDG config home ─────────────────────────────
seed_file() {
  local src="$1" dst="$2"
  [ -f "$dst" ] || cp "$src" "$dst"
}

seed_dir() {
  local src="$1" dst="$2"
  [ -d "$dst" ] || cp -r "$src" "$dst"
}

seed_file "$INSTALL_ASSETS_DIR/state/caddy/Caddyfile" "$OPENPALM_STATE_HOME/rendered/caddy/Caddyfile"
seed_file "$INSTALL_ASSETS_DIR/config/secrets.env" "$OPENPALM_CONFIG_HOME/secrets.env"
seed_file "$INSTALL_ASSETS_DIR/config/stack-spec.json" "$OPENPALM_CONFIG_HOME/stack-spec.json"
cat > "$OPENPALM_STATE_HOME/system.env" <<'EOF'
# generated by admin — do not edit
EOF
cat > "$OPENPALM_STATE_HOME/gateway/.env" <<'EOF'
# generated by admin
EOF
cat > "$OPENPALM_STATE_HOME/openmemory/.env" <<'EOF'
# generated by admin
EOF
cat > "$OPENPALM_STATE_HOME/postgres/.env" <<'EOF'
# generated by admin
EOF
cat > "$OPENPALM_STATE_HOME/qdrant/.env" <<'EOF'
# generated by admin
EOF
cat > "$OPENPALM_STATE_HOME/assistant/.env" <<'EOF'
# generated by admin
EOF
for channel_env in channel-chat channel-discord channel-voice channel-telegram; do
cat > "$OPENPALM_STATE_HOME/${channel_env}/.env" <<'EOF'
# generated by admin
EOF
done
cat > "$OPENPALM_STATE_HOME/rendered/caddy/snippets/extra-user-overrides.caddy" <<'EOF'
# user-managed overrides
EOF

cp "$INSTALL_ASSETS_DIR/state/scripts/uninstall.sh" "$OPENPALM_STATE_HOME/uninstall.sh"
chmod +x "$OPENPALM_STATE_HOME/uninstall.sh"

# Always reset setup wizard state on install/reinstall.
rm -f "$OPENPALM_DATA_HOME/admin/setup-state.json"

echo ""
echo "Directory structure created. Config seeded from defaults."
echo ""

# ── Start services ─────────────────────────────────────────────────────────
echo "Downloading OpenPalm services (this may take a few minutes on first install)..."
"${COMPOSE_CMD[@]}" --env-file "$OPENPALM_STATE_HOME/.env" -f "$COMPOSE_FILE_PATH" pull

echo ""
echo "Starting services..."
"${COMPOSE_CMD[@]}" --env-file "$OPENPALM_STATE_HOME/.env" -f "$COMPOSE_FILE_PATH" up -d --pull always

ADMIN_READY_URL="http://localhost/admin/api/setup/status"
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
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  OpenPalm is ready!                                         ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  echo "  Setup wizard: $SETUP_URL"
  echo ""
  if [ -n "$GENERATED_ADMIN_TOKEN" ]; then
    echo "  Admin password: $GENERATED_ADMIN_TOKEN"
    echo ""
  fi
  echo "  What happens next:"
  echo "    1. A setup wizard will open in your browser"
  echo "    2. Enter your AI provider API key (e.g. from console.anthropic.com)"
  echo "    3. Paste your admin password when prompted"
  echo "    4. Pick which channels to enable (chat, Discord, etc.)"
  echo "    5. Done! Start chatting with your assistant"
  echo ""

  if [ "$OPEN_BROWSER" -eq 1 ]; then
    case "$OS_NAME" in
      macos)
        open "$SETUP_URL" >/dev/null 2>&1 || true
        ;;
      linux)
        xdg-open "$SETUP_URL" >/dev/null 2>&1 || true
        ;;
    esac
    echo "  Opening setup wizard in your browser..."
  else
    echo "  Open this URL in your browser to continue: $SETUP_URL"
  fi
  echo ""
  echo "  Useful commands:"
  echo "    View logs:    ${COMPOSE_CMD[*]} --env-file $OPENPALM_STATE_HOME/.env -f $COMPOSE_FILE_PATH logs"
  echo "    Stop:         ${COMPOSE_CMD[*]} --env-file $OPENPALM_STATE_HOME/.env -f $COMPOSE_FILE_PATH down"
  echo "    Uninstall:    $OPENPALM_STATE_HOME/uninstall.sh"
  echo ""
  exit 0
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Setup did not come online within 90 seconds                ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  This usually means containers are still starting. Try these steps:"
echo ""
echo "  1. Wait a minute, then open: $SETUP_URL"
echo ""
echo "  2. Check if containers are running:"
echo "     ${COMPOSE_CMD[*]} --env-file $OPENPALM_STATE_HOME/.env -f $COMPOSE_FILE_PATH ps"
echo ""
echo "  3. Check logs for errors:"
echo "     ${COMPOSE_CMD[*]} --env-file $OPENPALM_STATE_HOME/.env -f $COMPOSE_FILE_PATH logs --tail=30"
echo ""
echo "  4. Common fixes:"
echo "     - Make sure port 80 is not used by another service"
echo "     - Restart Docker/Podman and try again"
echo "     - Check that you have internet access (images need to download)"
echo ""
exit 1
