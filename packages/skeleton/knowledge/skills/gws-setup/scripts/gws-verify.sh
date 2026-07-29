#!/usr/bin/env bash
# gws-verify.sh — Verify Google Workspace CLI authentication
#
# Checks that gws credentials are present and working. Tests against
# the knowledge/secrets/.gws/ config directory used by the assistant container.
#
# Usage:
#   ./scripts/gws-verify.sh [--op-home ~/.openpalm] [--container]
#
# Options:
#   --container   Run verification inside the assistant container instead of host
set -euo pipefail

OP_HOME="${OP_HOME:-${HOME}/.openpalm}"
IN_CONTAINER=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --op-home)     OP_HOME="$2"; shift 2 ;;
    --container)   IN_CONTAINER=true; shift ;;
    -h|--help)
      echo "Usage: $0 [--op-home PATH] [--container]"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

GWS_DIR="${OP_HOME}/knowledge/secrets/.gws"
PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"
  if [[ "$result" == "ok" ]]; then
    echo "  [PASS] ${label}"
    ((PASS++))
  else
    echo "  [FAIL] ${label} — ${result}"
    ((FAIL++))
  fi
}

echo "=== GWS CLI Verification ==="
echo ""

# Check 1: gws binary
if command -v gws &>/dev/null; then
  check "gws CLI installed" "ok"
else
  check "gws CLI installed" "not found on PATH (install via the install-optional-tool skill: install-tool.sh gws)"
fi

# Check 2: gcloud binary
if command -v gcloud &>/dev/null; then
  check "gcloud CLI installed" "ok"
else
  check "gcloud CLI installed" "not found (needed for 'gws auth setup')"
fi

# Check 3: Config directory exists
if [[ -d "$GWS_DIR" ]]; then
  check "Config directory (${GWS_DIR})" "ok"
else
  check "Config directory (${GWS_DIR})" "directory not found"
fi

# Check 4: Credentials file or encrypted store
if [[ -f "${GWS_DIR}/credentials.json" ]]; then
  check "Credentials file" "ok"
elif ls "${GWS_DIR}/"*.enc 2>/dev/null | head -1 &>/dev/null; then
  check "Encrypted credentials" "ok"
elif [[ -n "${GOOGLE_WORKSPACE_CLI_TOKEN:-}" ]]; then
  check "Token env var" "ok"
elif [[ -n "${GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE:-}" ]]; then
  if [[ -f "${GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE}" ]]; then
    check "Credentials file (env)" "ok"
  else
    check "Credentials file (env)" "file not found: ${GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE}"
  fi
else
  check "Credentials" "no credentials found in ${GWS_DIR}/"
fi

# Check 5: Live API test
echo ""
echo "  Testing API access..."
export GOOGLE_WORKSPACE_CLI_CONFIG_DIR="${GWS_DIR}"
if gws drive files list --params '{"pageSize": 1}' &>/dev/null; then
  check "Drive API access" "ok"
else
  check "Drive API access" "failed (check scopes and token expiry)"
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

if [[ "$FAIL" -gt 0 ]]; then
  echo ""
  echo "To set up credentials, run: ./scripts/gws-setup.sh"
  exit 1
fi
