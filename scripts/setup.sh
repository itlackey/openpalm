#!/usr/bin/env bash
# OpenPalm — Install Script
#
# One-liner install:
#   curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
#
set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
info() { printf "${BLUE}▸${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }
die()  { printf "${RED}✗${NC} %s\n" "$*" >&2; exit 1; }

# ── Helpers ───────────────────────────────────────────────────────────
# Release tags are bare semver (the `v` prefix was retired). Strip any leading
# `v` so a user-supplied "v0.12.45" still resolves to the "0.12.45" release tag.
normalize_version() {
  printf '%s\n' "${1#v}"
}

validate_version() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] \
    || die "Invalid release version: $1"
}

manifest_version() {
  grep '"version"' | sed -E 's/.*"version": *"([^"]+)".*/\1/'
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
CLI_ONLY=0

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
    --cli-only)
      CLI_ONLY=1
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
if [ -n "${VERSION}" ]; then
  validate_version "${VERSION}"
  MANIFEST_URL="https://github.com/itlackey/openpalm/releases/download/${VERSION}/release-assets-manifest.json"
else
  # GitHub's latest/download redirect is unauthenticated and not API-rate-limited.
  # Prereleases are intentionally selected only through --version/OP_VERSION.
  MANIFEST_URL="https://github.com/itlackey/openpalm/releases/latest/download/release-assets-manifest.json"
fi
if RELEASE_MANIFEST="$(curl -fsL "${MANIFEST_URL}")"; then
  # `manifest_version` is a `grep | sed` pipeline: under `set -euo pipefail`, a
  # manifest with no "version" key makes grep exit non-zero, which (via
  # pipefail) fails this whole assignment and would trigger `set -e` BEFORE
  # the `die` below ever runs — exiting with zero output. `|| true` neutralizes
  # that so the empty-string result reaches the explicit check instead.
  MANIFEST_VERSION="$(printf '%s\n' "${RELEASE_MANIFEST}" | manifest_version || true)"
  [ -n "${MANIFEST_VERSION}" ] || die "Release manifest does not declare a version"
  MANIFEST_VERSION="$(normalize_version "${MANIFEST_VERSION}")"
  validate_version "${MANIFEST_VERSION}"
  if [ -n "${VERSION}" ] && [ "${MANIFEST_VERSION}" != "${VERSION}" ]; then
    die "Release manifest identifies ${MANIFEST_VERSION}, expected ${VERSION}"
  fi
  VERSION="${MANIFEST_VERSION}"
elif [ -z "${VERSION}" ]; then
  # Compatibility for stable releases that predate the release manifest.
  LATEST_RELEASE_URL="$(curl -fsSL --retry 3 --retry-delay 3 --retry-all-errors \
    -o /dev/null -w '%{url_effective}' "https://github.com/itlackey/openpalm/releases/latest")" \
    || die "Could not determine latest release version"
  RAW_VERSION="${LATEST_RELEASE_URL##*/tag/}"
  [ "${RAW_VERSION}" != "${LATEST_RELEASE_URL}" ] || die "Could not determine latest release version"
  VERSION="$(normalize_version "${RAW_VERSION}")"
  validate_version "${VERSION}"
fi

# ── Download ──────────────────────────────────────────────────────────
INSTALL_DIR="${OP_INSTALL_DIR:-${HOME}/.local/bin}"
DEST="${INSTALL_DIR}/openpalm"
mkdir -p "${INSTALL_DIR}" 2>/dev/null \
  || die "Could not create install directory ${INSTALL_DIR} (permission denied?). Set OP_INSTALL_DIR to a writable location and re-run."
TMP_DEST="$(mktemp "${DEST}.tmp.XXXXXX" 2>/dev/null)" \
  || die "Could not create a temp file in ${INSTALL_DIR} (permission denied?). Set OP_INSTALL_DIR to a writable location and re-run."

info "Downloading openpalm ${VERSION} for ${OS}/${ARCH}..."
trap 'rm -f "${TMP_DEST}"' EXIT
BINARY_URL="https://github.com/itlackey/openpalm/releases/download/${VERSION}/${BINARY}"
# No --retry-all-errors here: a typo'd/nonexistent --version is a permanent 404
# and should fail fast with a friendly message, not retry 5 times (~20s) before
# dumping a raw curl error. --retry (no -all-errors) still retries transient
# failures (timeouts, connection resets, 5xx).
curl -fsSL --retry 5 --retry-delay 5 "${BINARY_URL}" -o "${TMP_DEST}" \
  || die "Failed to download ${BINARY} ${VERSION} from ${BINARY_URL} — check the version and your network connection."

# Verify SHA-256 checksum against the release-published checksums file
CHECKSUMS_URL="https://github.com/itlackey/openpalm/releases/download/${VERSION}/checksums-sha256.txt"
info "Verifying SHA-256 checksum..."
CHECKSUMS="$(curl -fsSL --retry 3 --retry-delay 3 --retry-all-errors "${CHECKSUMS_URL}")" \
  || die "Failed to download checksums from ${CHECKSUMS_URL}"
# Anchored (whitespace + end-of-line), matching the release workflow's own
# check (.github/workflows/release.yml). An unanchored grep breaks the moment
# any other asset name shares this one as a prefix (e.g. a future ".sig"),
# matching multiple lines and turning every checksum into a guaranteed
# mismatch. `|| true` keeps a no-match from tripping `set -e` via pipefail
# before the explicit `die` below can run (same class of bug as S1 above).
EXPECTED="$(printf '%s\n' "${CHECKSUMS}" | grep -E "[[:space:]]${BINARY}$" | awk '{print $1}' || true)"
[ -n "${EXPECTED}" ] || die "No checksum found for ${BINARY} in checksums-sha256.txt"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "${TMP_DEST}" | awk '{print $1}')"
else
  ACTUAL="$(shasum -a 256 "${TMP_DEST}" | awk '{print $1}')"
fi
[ "${ACTUAL}" = "${EXPECTED}" ] || die "Checksum mismatch for ${BINARY}: expected ${EXPECTED}, got ${ACTUAL}"
ok "Checksum verified"

chmod +x "${TMP_DEST}"
mv "${TMP_DEST}" "${DEST}"
trap - EXIT

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
    fish)
      # fish reads neither ~/.profile nor POSIX export/alias syntax on
      # startup; its startup file is ~/.config/fish/config.fish, sourced by
      # every new fish shell (interactive or not) — the closest fish
      # equivalent to .bashrc/.zshrc.
      printf '%s\n' "${HOME}/.config/fish/config.fish"
      ;;
    *)
      printf '%s\n' "${HOME}/.profile"
      ;;
  esac
}

USER_SHELL_NAME="$(basename "${SHELL:-/bin/bash}")"
SHELL_PROFILE="$(detect_shell_profile)"
if [ "${USER_SHELL_NAME}" = "fish" ]; then
  # fish_add_path persists to the fish-managed PATH the same way `export
  # PATH=...` does for POSIX shells. fish also ships an `alias` compat
  # function that accepts the same `name=value` form used below, so
  # ALIAS_LINE needs no fish-specific spelling.
  PATH_LINE="fish_add_path \"${INSTALL_DIR}\""
else
  PATH_LINE="export PATH=\"${INSTALL_DIR}:\$PATH\""
fi
ALIAS_LINE="alias op=openpalm"

# Persist PATH if needed
path_written_this_run=false
if [ "${add_to_path_needed}" = true ]; then
  if [ -f "${SHELL_PROFILE}" ] && grep -qF "${INSTALL_DIR}" "${SHELL_PROFILE}" 2>/dev/null; then
    info "PATH entry already exists in ${SHELL_PROFILE}"
  else
    info "Adding ${INSTALL_DIR} to PATH in ${SHELL_PROFILE}..."
    mkdir -p "$(dirname "${SHELL_PROFILE}")"
    {
      printf '\n# OpenPalm CLI\n'
      printf '%s\n' "${PATH_LINE}"
    } >> "${SHELL_PROFILE}"
    ok "PATH updated in ${SHELL_PROFILE}"
    path_written_this_run=true
  fi
fi

# Offer the 'op' alias — skip only when another 'op' already exists (e.g. the
# 1Password CLI, which also installs a command named 'op'). `command -v op`
# can only ever resolve to a path ending in "/op", never "/openpalm", so
# comparing it against DEST was unreachable dead code and has been removed.
if ! command -v op >/dev/null 2>&1; then
  if [ -f "${SHELL_PROFILE}" ] && grep -qF "alias op=openpalm" "${SHELL_PROFILE}" 2>/dev/null; then
    info "'op' alias already configured in ${SHELL_PROFILE}"
  else
    # Default to adding the alias unless OP_NO_ALIAS is set
    if [ "${OP_NO_ALIAS:-}" != "1" ]; then
      info "Adding 'op' shorthand alias to ${SHELL_PROFILE}..."
      mkdir -p "$(dirname "${SHELL_PROFILE}")"
      {
        # Only the PATH block above just wrote its own leading blank
        # line + header this run — if it was skipped (already present, or
        # add_to_path_needed was false) this section must supply its own,
        # otherwise the alias line can land directly against the file's
        # last byte with no separating newline (e.g. a profile whose last
        # line has no trailing newline), corrupting it.
        if [ "${path_written_this_run}" != true ]; then printf '\n# OpenPalm CLI\n'; fi
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

if [ "${CLI_ONLY}" = "1" ]; then
  ok "CLI install complete. Skipped stack and OP_HOME updates because --cli-only was requested."
  exit 0
fi

# ── Run install ───────────────────────────────────────────────────────
if [ "${#PASSTHROUGH_ARGS[@]}" -gt 0 ]; then
  exec "${DEST}" install --version "${VERSION}" "${PASSTHROUGH_ARGS[@]}"
fi

exec "${DEST}" install --version "${VERSION}"
