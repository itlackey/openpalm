#!/usr/bin/env bash
# install-tool.sh — on-demand installer for optional assistant tools (IMG-2)
#
# Installs one of the tools listed in ../tools.json into /opt/persistent (the
# `assistant-persistent` named volume), so the install survives container
# recreation, and puts its binary on PATH (/opt/persistent/bin is first on
# PATH in the assistant image). Idempotent: re-running for an already
# installed tool is a cheap no-op.
#
# Usage:
#   ./install-tool.sh <tool-id>
#   ./install-tool.sh --list
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${SCRIPT_DIR}/../tools.json"
PREFIX="/opt/persistent"

if [[ $# -eq 0 || "$1" == "-h" || "$1" == "--help" ]]; then
  echo "Usage: $0 <tool-id>"
  echo "       $0 --list"
  echo ""
  echo "Available tools:"
  jq -r 'to_entries[] | "  \(.key)\t\(.value.label)"' "$MANIFEST"
  exit 0
fi

if [[ "$1" == "--list" ]]; then
  jq -r 'to_entries[] | "\(.key)\t\(.value.label)"' "$MANIFEST"
  exit 0
fi

TOOL_ID="$1"

if ! jq -e --arg id "$TOOL_ID" 'has($id)' "$MANIFEST" >/dev/null; then
  echo "ERROR: unknown tool '${TOOL_ID}'. Run '$0 --list' for supported tools." >&2
  exit 1
fi

KIND="$(jq -r --arg id "$TOOL_ID" '.[$id].kind' "$MANIFEST")"
LABEL="$(jq -r --arg id "$TOOL_ID" '.[$id].label' "$MANIFEST")"
BIN="$(jq -r --arg id "$TOOL_ID" '.[$id].bin' "$MANIFEST")"

# Cheap "already installed?" check — repeat invocations should not redo work.
if command -v "$BIN" &>/dev/null; then
  echo "${LABEL} is already installed: $(command -v "$BIN")"
  exit 0
fi

mkdir -p "${PREFIX}/bin"

case "$KIND" in
  npm)
    PACKAGE="$(jq -r --arg id "$TOOL_ID" '.[$id].package' "$MANIFEST")"
    VERSION="$(jq -r --arg id "$TOOL_ID" '.[$id].version' "$MANIFEST")"
    echo "Installing ${LABEL} (${PACKAGE}@${VERSION}) into ${PREFIX}..."
    npm install -g --prefix "$PREFIX" --omit=dev --no-fund --no-audit \
      "${PACKAGE}@${VERSION}"
    ;;
  gcloud-sdk)
    echo "Installing ${LABEL} into ${PREFIX}/google-cloud-sdk..."
    ARCH="$(uname -m | sed 's/aarch64/arm/')"
    TARBALL="/tmp/gcloud.tar.gz"
    curl -fsSL "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-${ARCH}.tar.gz" \
      -o "$TARBALL"
    tar xzf "$TARBALL" -C "$PREFIX"
    "${PREFIX}/google-cloud-sdk/install.sh" --quiet --usage-reporting false --path-update false
    rm -f "$TARBALL"
    ln -sf "${PREFIX}/google-cloud-sdk/bin/gcloud" "${PREFIX}/bin/gcloud"
    ln -sf "${PREFIX}/google-cloud-sdk/bin/gsutil" "${PREFIX}/bin/gsutil"
    ln -sf "${PREFIX}/google-cloud-sdk/bin/bq" "${PREFIX}/bin/bq"
    ;;
  *)
    echo "ERROR: unsupported install kind '${KIND}' for '${TOOL_ID}'." >&2
    exit 1
    ;;
esac

if command -v "$BIN" &>/dev/null; then
  echo "Done. ${LABEL} installed: $(command -v "$BIN")"
else
  echo "WARN: install finished but '${BIN}' is not on PATH yet — open a new shell." >&2
fi
