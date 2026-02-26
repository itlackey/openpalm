#!/usr/bin/env bash
set -euo pipefail

# ── OpenPalm installer (thin wrapper) ───────────────────────────────────────
#
# Downloads the pre-compiled `openpalm` CLI binary from GitHub Releases,
# installs it to ~/.local/bin (or /usr/local/bin), and delegates to
# `openpalm install`. All installer logic lives in the CLI itself.
#
# Usage (no arguments):
#   curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/install.sh | bash
#
# Usage (with arguments — note the -s -- before flags):
#   curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/install.sh | bash -s -- --runtime docker
#   curl -fsSL ... | bash -s -- --runtime podman --no-open
#   curl -fsSL ... | bash -s -- --ref v1.0.0
#   curl -fsSL ... | bash -s -- --port 8080
#
# ─────────────────────────────────────────────────────────────────────────────

OPENPALM_REPO_OWNER="${OPENPALM_REPO_OWNER:-itlackey}"
OPENPALM_REPO_NAME="${OPENPALM_REPO_NAME:-openpalm}"

# ── Parse arguments ──────────────────────────────────────────────────────────

CLI_ARGS=()
RELEASE_REF=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --runtime. Expected: docker | podman"
        exit 1
      fi
      CLI_ARGS+=(--runtime "$2")
      shift 2
      ;;
    --port)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --port. Expected a port number (1-65535)."
        exit 1
      fi
      if ! printf '%s' "$2" | grep -qE '^[0-9]+$' || [ "$2" -lt 1 ] || [ "$2" -gt 65535 ]; then
        echo "Invalid port \"$2\". Must be a number between 1 and 65535."
        exit 1
      fi
      CLI_ARGS+=(--port "$2")
      shift 2
      ;;
    --no-open)
      CLI_ARGS+=(--no-open)
      shift
      ;;
    --ref)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --ref."
        exit 1
      fi
      RELEASE_REF="$2"
      CLI_ARGS+=(--ref "$2")
      shift 2
      ;;
    -h|--help)
      cat <<'HELP'
Usage: install.sh [--runtime docker|podman] [--port <number>] [--no-open] [--ref <branch|tag>]

Download the OpenPalm CLI and run `openpalm install`.

When piping via curl, pass arguments with -s --:
  curl -fsSL <url>/install.sh | bash -s -- --runtime docker
  curl -fsSL <url>/install.sh | bash -s -- --port 8080
  curl -fsSL <url>/install.sh | bash -s -- --runtime docker --port 3000 --no-open

Options:
  --runtime   Force a container runtime platform selection.
  --port      Use an alternative ingress port (default: 80). Useful when port 80
              is already in use by another service (e.g. Apache, nginx).
  --no-open   Do not auto-open the admin setup URL after services are healthy.
  --ref       Git ref (branch or tag) for release download (default: latest).
  -h, --help  Show this help.

Port conflict remediation:
  If port 80 is occupied, re-run with --port <number>:
    curl -fsSL <url>/install.sh | bash -s -- --port 8080
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
    Darwin*) echo "darwin" ;;
    CYGWIN*|MINGW*|MSYS*) echo "windows" ;;
    *) echo "unknown" ;;
  esac
}

detect_arch() {
  local uname_m
  uname_m="$(uname -m 2>/dev/null || echo unknown)"
  case "$uname_m" in
    x86_64|amd64) echo "x64" ;;
    arm64|aarch64) echo "arm64" ;;
    *)
      echo "Unsupported CPU architecture '$uname_m'." >&2
      exit 1
      ;;
  esac
}

OS_NAME="$(detect_os)"
HOST_ARCH="$(detect_arch)"

if [ "$OS_NAME" = "unknown" ]; then
  echo "Unsupported OS detected. Please run from Linux or macOS."
  exit 1
fi

if [ "$OS_NAME" = "windows" ]; then
  echo "This installer is for Linux/macOS shells."
  echo "On Windows, run the PowerShell installer instead:"
  echo '  pwsh -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/itlackey/openpalm/main/install.ps1 -OutFile $env:TEMP/openpalm-install.ps1; & $env:TEMP/openpalm-install.ps1"'
  exit 1
fi

# ── Resolve install directory ────────────────────────────────────────────────

INSTALL_DIR="${HOME}/.local/bin"
if [ ! -d "$INSTALL_DIR" ]; then
  mkdir -p "$INSTALL_DIR"
fi

# Check if install dir is in PATH, suggest adding it if not
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    NEEDS_PATH_HINT=1
    ;;
esac

# ── Download CLI binary ──────────────────────────────────────────────────────

BINARY_NAME="openpalm-${OS_NAME}-${HOST_ARCH}"
if [ -n "$RELEASE_REF" ]; then
  DOWNLOAD_URL="https://github.com/${OPENPALM_REPO_OWNER}/${OPENPALM_REPO_NAME}/releases/download/${RELEASE_REF}/${BINARY_NAME}"
else
  DOWNLOAD_URL="https://github.com/${OPENPALM_REPO_OWNER}/${OPENPALM_REPO_NAME}/releases/latest/download/${BINARY_NAME}"
fi
TARGET_PATH="${INSTALL_DIR}/openpalm"
BINARY_TMP="$(mktemp)"

cleanup() {
  if [ -n "${BINARY_TMP:-}" ] && [ -f "$BINARY_TMP" ]; then
    rm -f "$BINARY_TMP"
  fi
}
trap cleanup EXIT

echo "Downloading OpenPalm CLI..."
if ! curl -fsSL --connect-timeout 10 --max-time 120 "$DOWNLOAD_URL" -o "$BINARY_TMP" 2>/dev/null; then
  echo ""
  echo "Failed to download the OpenPalm CLI binary."
  echo ""
  echo "  URL: $DOWNLOAD_URL"
  echo ""
  echo "  This can happen if:"
  echo "    - No release has been published yet"
  echo "    - Your internet connection is unavailable"
  echo "    - The release does not include a binary for $OS_NAME/$HOST_ARCH"
  echo ""
  echo "  Alternative install methods:"
  echo "    npx openpalm install"
  echo "    bunx openpalm install"
  echo ""
  exit 1
fi

# Verify checksum if a .sha256 file is published alongside the binary
CHECKSUM_URL="${DOWNLOAD_URL}.sha256"
CHECKSUM_TMP="$(mktemp)"
if curl -fsSL --connect-timeout 10 --max-time 30 "$CHECKSUM_URL" -o "$CHECKSUM_TMP" 2>/dev/null; then
  EXPECTED_HASH=$(awk '{print $1}' "$CHECKSUM_TMP")
  ACTUAL_HASH=$(sha256sum "$BINARY_TMP" | awk '{print $1}')
  rm -f "$CHECKSUM_TMP"
  if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
    echo "ERROR: Checksum verification failed!" >&2
    echo "  Expected: $EXPECTED_HASH" >&2
    echo "  Got:      $ACTUAL_HASH" >&2
    cleanup
    exit 1
  fi
  echo "Checksum verified."
else
  rm -f "$CHECKSUM_TMP"
  echo "WARNING: Could not download checksum file. Skipping verification." >&2
  echo "         This is less secure. Consider verifying the binary manually." >&2
fi

chmod +x "$BINARY_TMP"

# Quick sanity check — the binary should respond to version
if ! "$BINARY_TMP" version >/dev/null 2>&1; then
  echo "Downloaded binary failed sanity check."
  echo "Try an alternative install method:"
  echo "  npx openpalm install"
  echo "  bunx openpalm install"
  exit 1
fi

# Move to install directory
mv "$BINARY_TMP" "$TARGET_PATH"
BINARY_TMP=""  # Prevent cleanup from removing installed binary

echo "Installed OpenPalm CLI to $TARGET_PATH"

if [ "${NEEDS_PATH_HINT:-0}" = "1" ]; then
  echo ""
  echo "NOTE: $INSTALL_DIR is not in your PATH."
  echo "  Add it by running:"
  echo "    export PATH=\"$INSTALL_DIR:\$PATH\""
  echo "  Or add that line to your ~/.bashrc / ~/.zshrc for it to persist."
  echo ""
fi

# ── Delegate to CLI ──────────────────────────────────────────────────────────

echo ""
"$TARGET_PATH" install "${CLI_ARGS[@]+"${CLI_ARGS[@]}"}"
CLI_EXIT=$?

if [ "$CLI_EXIT" -ne 0 ]; then
  echo ""
  echo "Troubleshooting hints:"
  echo "  - If the error mentions port 80 is already in use, re-run with --port:"
  echo "      curl -fsSL https://raw.githubusercontent.com/${OPENPALM_REPO_OWNER}/${OPENPALM_REPO_NAME}/main/install.sh | bash -s -- --port 8080"
  echo "  - Check which process is using the port:"
  echo "      sudo lsof -i :80   # macOS/Linux"
  echo "      sudo ss -tlnp | grep :80   # Linux"
  echo ""
  exit "$CLI_EXIT"
fi
