#!/usr/bin/env bash
set -euo pipefail

REPO="itlackey/openpalm"
VERSION="latest"
INSTALL_DIR="${OPENPALM_INSTALL_DIR:-$HOME/.local/bin}"
BINARY_NAME="openpalm"

usage() {
  cat <<'USAGE'
Usage: install.sh [OPTIONS]

Install the OpenPalm CLI binary from GitHub Releases.

Options:
  --version TAG       Release tag to install (default: latest)
  --install-dir PATH  Install directory (default: ~/.local/bin)
  -h, --help          Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      shift
      VERSION="${1:?--version requires a value}"
      ;;
    --install-dir)
      shift
      INSTALL_DIR="${1:?--install-dir requires a value}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required but not found" >&2
  exit 1
fi

OS=""
ARCH=""
case "$(uname -s)" in
  Linux) OS="linux" ;;
  Darwin) OS="darwin" ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [[ "$VERSION" == "latest" ]]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  if [[ -z "$VERSION" ]]; then
    echo "Failed to resolve latest release tag" >&2
    exit 1
  fi
fi

ASSET="openpalm-cli-${OS}-${ARCH}"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
TMP_BIN="${TMP_DIR}/${ASSET}"
TARGET_BIN="${INSTALL_DIR}/${BINARY_NAME}"

mkdir -p "$INSTALL_DIR"
curl -fsSL --retry 2 -o "$TMP_BIN" "$URL"
chmod +x "$TMP_BIN"
cp "$TMP_BIN" "$TARGET_BIN"
chmod +x "$TARGET_BIN"

echo "Installed OpenPalm CLI to: $TARGET_BIN"
echo "Run: $TARGET_BIN --help"
