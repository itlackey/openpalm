#!/usr/bin/env bash
# OpenPalm — Install Script
#
# One-liner install:
#   curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
#
set -euo pipefail

SCRIPT_VERSION="0.9.0-rc11"

# ── Colors ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info() { printf "${BLUE}▸${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }
die()  { printf "${RED}✗${NC} %s\n" "$*" >&2; exit 1; }

# ── Platform detection ────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}-${ARCH}" in
  Linux-x86_64)   BINARY="openpalm-linux-x64" ;;
  Linux-aarch64)  BINARY="openpalm-linux-arm64" ;;
  Darwin-x86_64)  BINARY="openpalm-darwin-x64" ;;
  Darwin-arm64)   BINARY="openpalm-darwin-arm64" ;;
  *) die "Unsupported platform: ${OS}-${ARCH}" ;;
esac

# ── Version resolution ─────────────────────────────────────────────────
VERSION="${OPENPALM_VERSION:-}"
if [ -z "${VERSION}" ]; then
  if [ "${SCRIPT_VERSION}" != "main" ]; then
    if [ "${SCRIPT_VERSION#v}" != "${SCRIPT_VERSION}" ]; then
      VERSION="${SCRIPT_VERSION}"
    else
      VERSION="v${SCRIPT_VERSION}"
    fi
  else
    VERSION="$(curl -fsSL "https://api.github.com/repos/itlackey/openpalm/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
    [ -n "${VERSION}" ] || die "Could not determine latest release version"
  fi
fi

# ── Download ──────────────────────────────────────────────────────────
INSTALL_DIR="${OPENPALM_INSTALL_DIR:-${HOME}/.local/bin}"
DEST="${INSTALL_DIR}/openpalm"

info "Downloading openpalm ${VERSION} for ${OS}/${ARCH}..."
mkdir -p "${INSTALL_DIR}"
curl -fsSL "https://github.com/itlackey/openpalm/releases/download/${VERSION}/${BINARY}" -o "${DEST}"
chmod +x "${DEST}"
ok "Installed openpalm to ${DEST}"

# ── Run install ───────────────────────────────────────────────────────
exec "${DEST}" install --version "${VERSION}" "$@"
