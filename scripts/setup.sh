#!/usr/bin/env bash
# OpenPalm — Install Script
#
# One-liner install:
#   curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
#
set -euo pipefail

SCRIPT_VERSION="0.10.0-rc11"

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
REQUESTED_VERSION="${OP_VERSION:-}"
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
INSTALL_DIR="${OP_INSTALL_DIR:-${HOME}/.local/bin}"
DEST="${INSTALL_DIR}/openpalm"

info "Downloading openpalm ${VERSION} for ${OS}/${ARCH}..."
mkdir -p "${INSTALL_DIR}"
curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors "https://github.com/itlackey/openpalm/releases/download/${VERSION}/${BINARY}" -o "${DEST}"

# Verify SHA-256 checksum against the release-published checksums file
CHECKSUMS_URL="https://github.com/itlackey/openpalm/releases/download/${VERSION}/checksums-sha256.txt"
info "Verifying SHA-256 checksum..."
CHECKSUMS="$(curl -fsSL --retry 3 --retry-delay 3 --retry-all-errors "${CHECKSUMS_URL}")" \
  || die "Failed to download checksums from ${CHECKSUMS_URL}"
EXPECTED="$(echo "${CHECKSUMS}" | grep "${BINARY}" | awk '{print $1}')"
[ -n "${EXPECTED}" ] || die "No checksum found for ${BINARY} in checksums-sha256.txt"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "${DEST}" | awk '{print $1}')"
else
  ACTUAL="$(shasum -a 256 "${DEST}" | awk '{print $1}')"
fi
[ "${ACTUAL}" = "${EXPECTED}" ] || die "Checksum mismatch for ${BINARY}: expected ${EXPECTED}, got ${ACTUAL}"
ok "Checksum verified"

chmod +x "${DEST}"

# macOS: clear quarantine flag and ad-hoc codesign so Gatekeeper does not kill the binary
if [ "${OS}" = "Darwin" ]; then
  xattr -cr "${DEST}" 2>/dev/null || true
  codesign --force --sign - "${DEST}" 2>/dev/null || true
fi

ok "Installed openpalm to ${DEST}"

# ── Ensure $INSTALL_DIR is on PATH ───────────────────────────────────
add_to_path_needed=false
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    add_to_path_needed=true
    export PATH="${INSTALL_DIR}:${PATH}"
    ;;
esac

# Detect the user's shell profile file
detect_shell_profile() {
  local _shell
  _shell="$(basename "${SHELL:-/bin/bash}")"
  case "${_shell}" in
    zsh)
      if [ -f "${HOME}/.zshrc" ]; then printf '%s\n' "${HOME}/.zshrc"
      elif [ -f "${HOME}/.zprofile" ]; then printf '%s\n' "${HOME}/.zprofile"
      else printf '%s\n' "${HOME}/.zshrc"; fi
      ;;
    bash)
      if [ "${OS}" = "Darwin" ]; then
        # macOS default: .bash_profile is sourced for login shells
        if [ -f "${HOME}/.bash_profile" ]; then printf '%s\n' "${HOME}/.bash_profile"
        elif [ -f "${HOME}/.bashrc" ]; then printf '%s\n' "${HOME}/.bashrc"
        else printf '%s\n' "${HOME}/.bash_profile"; fi
      else
        if [ -f "${HOME}/.bashrc" ]; then printf '%s\n' "${HOME}/.bashrc"
        elif [ -f "${HOME}/.bash_profile" ]; then printf '%s\n' "${HOME}/.bash_profile"
        else printf '%s\n' "${HOME}/.bashrc"; fi
      fi
      ;;
    *)
      printf '%s\n' "${HOME}/.profile"
      ;;
  esac
}

SHELL_PROFILE="$(detect_shell_profile)"
PATH_LINE="export PATH=\"${INSTALL_DIR}:\$PATH\""
ALIAS_LINE="alias op=openpalm"

# Persist PATH if needed
if [ "${add_to_path_needed}" = true ]; then
  if [ -f "${SHELL_PROFILE}" ] && grep -qF "${INSTALL_DIR}" "${SHELL_PROFILE}" 2>/dev/null; then
    info "PATH entry already exists in ${SHELL_PROFILE}"
  else
    info "Adding ${INSTALL_DIR} to PATH in ${SHELL_PROFILE}..."
    {
      printf '\n# OpenPalm CLI\n'
      printf '%s\n' "${PATH_LINE}"
    } >> "${SHELL_PROFILE}"
    ok "PATH updated in ${SHELL_PROFILE}"
  fi
fi

# Offer the 'op' alias
if ! command -v op >/dev/null 2>&1 || [ "$(command -v op)" = "${DEST}" ]; then
  if [ -f "${SHELL_PROFILE}" ] && grep -qF "alias op=openpalm" "${SHELL_PROFILE}" 2>/dev/null; then
    info "'op' alias already configured in ${SHELL_PROFILE}"
  else
    # Default to adding the alias unless OP_NO_ALIAS is set
    if [ "${OP_NO_ALIAS:-}" != "1" ]; then
      info "Adding 'op' shorthand alias to ${SHELL_PROFILE}..."
      {
        if [ "${add_to_path_needed}" != true ]; then printf '\n# OpenPalm CLI\n'; fi
        printf '%s\n' "${ALIAS_LINE}"
      } >> "${SHELL_PROFILE}"
      ok "'op' alias added. You can use 'op' instead of 'openpalm'."
    fi
  fi
else
  info "Skipping 'op' alias — another command named 'op' already exists."
fi

if [ "${add_to_path_needed}" = true ]; then
  info "Run 'source ${SHELL_PROFILE}' or open a new terminal for changes to take effect."
fi

# ── Run install ───────────────────────────────────────────────────────
if [ "${#PASSTHROUGH_ARGS[@]}" -gt 0 ]; then
  exec "${DEST}" install --version "${VERSION}" "${PASSTHROUGH_ARGS[@]}"
fi

exec "${DEST}" install --version "${VERSION}"
