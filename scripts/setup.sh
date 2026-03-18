#!/usr/bin/env bash
# OpenPalm — Install Script
#
# One-liner install:
#   curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
#
set -euo pipefail

SCRIPT_VERSION="0.9.2-rc3"

# ── Colors ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info() { printf "${BLUE}▸${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}!${NC} %s\n" "$*"; }
die()  { printf "${RED}✗${NC} %s\n" "$*" >&2; exit 1; }

# ── Helpers ───────────────────────────────────────────────────────────
normalize_version() {
  if [ "${1#v}" != "$1" ]; then
    printf '%s\n' "$1"
  else
    printf 'v%s\n' "$1"
  fi
}

# ── Platform detection ────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}-${ARCH}" in
  Linux-x86_64)   BINARY="openpalm-cli-linux-x64" ;;
  Linux-aarch64)  BINARY="openpalm-cli-linux-arm64" ;;
  Darwin-x86_64)  BINARY="openpalm-cli-darwin-x64" ;;
  Darwin-arm64)   BINARY="openpalm-cli-darwin-arm64" ;;
  *) die "Unsupported platform: ${OS}-${ARCH}" ;;
esac

# ── Version resolution ─────────────────────────────────────────────────
REQUESTED_VERSION="${OPENPALM_VERSION:-}"
PASSTHROUGH_ARGS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version requires a value"
      REQUESTED_VERSION="$2"
      shift 2
      ;;
    --version=*)
      REQUESTED_VERSION="${1#--version=}"
      shift
      ;;
    *)
      PASSTHROUGH_ARGS+=("$1")
      shift
      ;;
  esac
done

VERSION=''
if [ -n "${REQUESTED_VERSION}" ]; then
  VERSION="$(normalize_version "${REQUESTED_VERSION}")"
fi
if [ -z "${VERSION}" ]; then
  if [ "${SCRIPT_VERSION}" != "main" ]; then
    VERSION="$(normalize_version "${SCRIPT_VERSION}")"
  else
    VERSION="$(curl -sI "https://github.com/itlackey/openpalm/releases/latest" | grep -i '^location:' | sed 's|.*/tag/\([^ ]*\).*|\1|' | tr -d '\r')"
    [ -n "${VERSION}" ] || die "Could not determine latest release version"
  fi
fi

# ── Download ──────────────────────────────────────────────────────────
INSTALL_DIR="${OPENPALM_INSTALL_DIR:-${HOME}/.local/bin}"
DEST="${INSTALL_DIR}/openpalm"

info "Downloading openpalm ${VERSION} for ${OS}/${ARCH}..."
mkdir -p "${INSTALL_DIR}"
curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors "https://github.com/itlackey/openpalm/releases/download/${VERSION}/${BINARY}" -o "${DEST}"
chmod +x "${DEST}"

# macOS: clear quarantine flag and ad-hoc codesign so Gatekeeper does not kill the binary
if [ "${OS}" = "Darwin" ]; then
  xattr -cr "${DEST}" 2>/dev/null || true
  codesign --force --sign - "${DEST}" 2>/dev/null || true
fi

ok "Installed openpalm to ${DEST}"

# ── Ensure $INSTALL_DIR is on PATH ───────────────────────────────────
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    warn "${INSTALL_DIR} is not on your PATH."
    info "Add it by running:  export PATH=\"${INSTALL_DIR}:\$PATH\""
    export PATH="${INSTALL_DIR}:${PATH}"
    ;;
esac

# ── Run install ───────────────────────────────────────────────────────
if [ "${#PASSTHROUGH_ARGS[@]}" -gt 0 ]; then
  exec "${DEST}" install --version "${VERSION}" "${PASSTHROUGH_ARGS[@]}"
fi

exec "${DEST}" install --version "${VERSION}"
