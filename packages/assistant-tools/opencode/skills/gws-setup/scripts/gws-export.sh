#!/usr/bin/env bash
# gws-export.sh — Export gws credentials for headless/CI environments
#
# Exports authenticated gws credentials from the host and saves them
# to vault/user/.gws/ for use in Docker containers or CI pipelines.
#
# Usage:
#   ./scripts/gws-export.sh [--op-home ~/.openpalm]
#
# Prerequisites:
#   - gws CLI installed and authenticated (run 'gws auth login' first)
set -euo pipefail

OP_HOME="${OP_HOME:-${HOME}/.openpalm}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --op-home) OP_HOME="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--op-home PATH]"
      echo ""
      echo "Exports gws CLI credentials to vault/user/.gws/ for Docker/CI use."
      echo "Run 'gws auth login' on the host first."
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

VAULT_GWS="${OP_HOME}/vault/user/.gws"

if ! command -v gws &>/dev/null; then
  echo "ERROR: gws CLI not found."
  exit 1
fi

mkdir -p "${VAULT_GWS}"

echo "Exporting gws credentials..."
gws auth export --unmasked > "${VAULT_GWS}/credentials.json"
chmod 600 "${VAULT_GWS}/credentials.json"

echo "Credentials exported to: ${VAULT_GWS}/credentials.json"
echo ""

# Also copy the full config dir for encryption key and other state
GWS_CONFIG="${GOOGLE_WORKSPACE_CLI_CONFIG_DIR:-${HOME}/.config/gws}"
if [[ -d "$GWS_CONFIG" ]]; then
  echo "Copying full gws config from ${GWS_CONFIG}/..."
  cp -r "${GWS_CONFIG}/." "${VAULT_GWS}/"
  echo "Config directory synced to ${VAULT_GWS}/"
fi

echo ""
echo "Verify: GOOGLE_WORKSPACE_CLI_CONFIG_DIR=${VAULT_GWS} gws drive files list --params '{\"pageSize\": 1}'"
echo ""
echo "Recreate the assistant container to pick up changes:"
echo "  docker compose ... up -d --force-recreate --no-deps assistant"
