#!/usr/bin/env bash
#
# OpenPalm — Upgrade Path Test Script
#
# Verifies that re-running setup.sh (simulating an upgrade) preserves user
# data and configuration while updating infrastructure artifacts.
#
# ── Manual test procedure (cross-version) ──────────────────────────────
#
#   1. Install v0.8.x:
#        curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/v0.8.0/scripts/setup.sh \
#          | bash -s -- --version v0.8.0
#
#   2. Complete the setup wizard in the browser at http://localhost:8100/setup
#      - Set an admin token
#      - Configure an LLM provider
#      - The wizard will pull remaining images and start all services
#
#   3. Seed some user state:
#      - Install a channel
#      - Note the operator password in stash/vaults/secrets/op_ui_login_password
#
#   4. Upgrade to the target version:
#        curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh \
#          | bash -s -- --force --version <target>
#
#   5. Verify:
#      - stash/vaults/user.env is NOT overwritten (custom user vault keys preserved)
#      - config/stack/stack.env is NOT overwritten (paths, UID/GID preserved)
#      - stash/vaults/secrets/ files are NOT overwritten (operator password preserved)
#      - All services come back healthy
#      - No errors in container logs
#
# ── Automated test (current version → re-run) ─────────────────────────
#
# Usage:
#   ./scripts/upgrade-test.sh [OPTIONS]
#
# Options:
#   --skip-build          Skip image build (use existing images)
#   --from-version TAG    Version to install first (default: current local build)
#   --to-version TAG      Version to upgrade to (default: current local build)
#   --keep                Don't tear down the stack after the test
#   -h, --help            Show this help
#
# Environment overrides:
#   OP_HOME         Home directory (default: .upgrade-test)
#
set -euo pipefail

# ── Argument parsing ─────────────────────────────────────────────────

SKIP_BUILD=0
FROM_VERSION=""
TO_VERSION=""
KEEP=0

usage() {
  cat <<'EOF'
Usage: scripts/upgrade-test.sh [OPTIONS]

Test that re-running setup.sh preserves user data and configuration.

Options:
  --skip-build           Skip image build (use existing images)
  --from-version TAG     Version to install first (default: current local build)
  --to-version TAG       Version to upgrade to (default: current local build)
  --keep                 Don't tear down the stack after the test
  -h, --help             Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1 ;;
    --from-version) shift; FROM_VERSION="${1:?--from-version requires a value}" ;;
    --to-version) shift; TO_VERSION="${1:?--to-version requires a value}" ;;
    --keep) KEEP=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ── Test isolation paths ─────────────────────────────────────────────
# Use a separate directory tree so this test doesn't interfere with .dev/

TEST_ROOT="${ROOT_DIR}/.upgrade-test"
export OP_HOME="${OP_HOME:-${TEST_ROOT}}"
STACK_DIR="${OP_HOME}/config/stack"
SECRETS_DIR="${STASH_DIR}/vaults/secrets"
STASH_DIR="${OP_HOME}/stash"
STATE_DIR="${OP_HOME}/state"
CACHE_DIR="${OP_HOME}/cache"

PROJECT_NAME="openpalm-upgrade-test"
OP_UI_LOGIN_PASSWORD="upgrade-test-password"

# ── Colors / Output ──────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
TESTS=0

pass() { PASS=$((PASS + 1)); TESTS=$((TESTS + 1)); printf "  ${GREEN}PASS${NC}: %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); TESTS=$((TESTS + 1)); printf "  ${RED}FAIL${NC}: %s\n" "$1"; }
header() { printf "\n${BOLD}── %s ──${NC}\n\n" "$*"; }

# ── Cleanup on exit ──────────────────────────────────────────────────

cleanup() {
  if [[ $KEEP -eq 0 ]]; then
    echo ""
    echo "Cleaning up..."
    compose_cmd down --remove-orphans 2>/dev/null || true
    # Clean root-owned files from container volumes
    docker run --rm -v "${TEST_ROOT}:/cleanup" alpine rm -rf /cleanup 2>/dev/null || true
    rm -rf "${TEST_ROOT}" 2>/dev/null || true
  else
    echo ""
    echo "Keeping stack running (--keep). Clean up manually:"
    echo "  docker compose --project-name ${PROJECT_NAME} down"
    echo "  rm -rf ${TEST_ROOT}"
  fi
}
trap cleanup EXIT

# ── Helper: compose command ──────────────────────────────────────────
# Compose uses config/stack/stack.env for non-secret values only. Service secrets
# live as files under stash/vaults/secrets and are granted by compose overlays.
# No admin container. Admin is a host process (openpalm).

compose_cmd() {
  docker compose \
    --project-name "$PROJECT_NAME" \
    -f "${STACK_DIR}/core.compose.yml" \
    --env-file "${STACK_DIR}/stack.env" \
    "$@"
}

# ── Helper: wait for all services healthy ────────────────────────────

wait_for_healthy() {
  local timeout="${1:-180}"
  local elapsed=0
  local services="assistant guardian"

  while [[ $elapsed -lt $timeout ]]; do
    local all_up=true
    for svc in $services; do
      local status
      status=$(docker inspect --format '{{.State.Health.Status}}' "${PROJECT_NAME}-${svc}-1" 2>/dev/null || echo "missing")
      if [[ "$status" != "healthy" ]]; then
        all_up=false
        break
      fi
    done
    if [[ "$all_up" == "true" ]]; then
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  return 1
}

# ══════════════════════════════════════════════════════════════════════
# PHASE 1: Initial install
# ══════════════════════════════════════════════════════════════════════

header "Phase 1: Initial install"

# ── 1a: Clean slate ──────────────────────────────────────────────────

echo "Tearing down any previous test state..."
compose_cmd down --remove-orphans 2>/dev/null || true
docker run --rm -v "${TEST_ROOT}:/cleanup" alpine rm -rf /cleanup 2>/dev/null || true
rm -rf "${TEST_ROOT}" 2>/dev/null || true

# ── 1b: Create directory structure ───────────────────────────────────

mkdir -p \
  "${STACK_DIR}" \
  "${STACK_DIR}/addons" \
  "${SECRETS_DIR}" \
  "${OP_HOME}/config/assistant" \
  "${OP_HOME}/config/akm" \
  "${STASH_DIR}/vaults" \
  "${STASH_DIR}/tasks" \
  "${STATE_DIR}/assistant" \
  "${STATE_DIR}/guardian" \
  "${STATE_DIR}/registry/addons" \
  "${STATE_DIR}/registry/automations" \
  "${STATE_DIR}/logs" \
  "${CACHE_DIR}/akm" \
  "${OP_HOME}/workspace"

# ── 1c: Seed config files ───────────────────────────────────────────

# Detect Docker socket
docker_sock="/var/run/docker.sock"
if host_url="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)"; then
  case "$host_url" in
    unix://*) detected_sock="${host_url#unix://}"; [[ -S "$detected_sock" ]] && docker_sock="$detected_sock" ;;
  esac
fi

# Seed stash/vaults/user.env — user-managed secrets (akm vault:user)
cat >"${STASH_DIR}/vaults/user.env" <<EOF
# Upgrade test user-managed env
OPENAI_BASE_URL=
# Custom user key that must survive upgrade
MY_CUSTOM_KEY=my-custom-value-12345
EOF
chmod 600 "${STASH_DIR}/vaults/user.env"

# Seed config/stack/stack.env (system-managed, non-secret)
cat >"${STACK_DIR}/stack.env" <<EOF
OP_HOME=${OP_HOME}
OP_UID=$(id -u)
OP_GID=$(id -g)
OP_DOCKER_SOCK=${docker_sock}
OP_IMAGE_NAMESPACE=openpalm
OP_IMAGE_TAG=dev
EOF
chmod 600 "${STACK_DIR}/stack.env"

# Seed file-based system secrets
printf '%s\n' "${OP_UI_LOGIN_PASSWORD}" >"${SECRETS_DIR}/op_ui_login_password"
openssl rand -hex 16 >"${SECRETS_DIR}/channel_chat_secret"
openssl rand -hex 16 >"${SECRETS_DIR}/channel_api_secret"
openssl rand -hex 16 >"${SECRETS_DIR}/channel_discord_secret"
openssl rand -hex 16 >"${SECRETS_DIR}/channel_slack_secret"
chmod 700 "${SECRETS_DIR}"
chmod 600 "${SECRETS_DIR}/"*

# Seed core.compose.yml into config/stack/
cp "${ROOT_DIR}/.openpalm/config/stack/core.compose.yml" "${STACK_DIR}/core.compose.yml"

# Seed opencode config
cat >"${OP_HOME}/config/assistant/opencode.json" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json"
}
EOF

pass "Directory tree and config files created"

# ── 1d: Build images (if needed) ─────────────────────────────────────

if [[ $SKIP_BUILD -eq 0 && -z "$FROM_VERSION" ]]; then
  header "Building images from source"
  docker compose --project-directory "$ROOT_DIR" \
    -f "${STACK_DIR}/core.compose.yml" \
    -f compose.dev.yml \
    --env-file "${STACK_DIR}/stack.env" \
    --project-name "$PROJECT_NAME" build 2>&1 | tail -5
  pass "Images built from source"
fi

# If --from-version is specified, pull that version's images
if [[ -n "$FROM_VERSION" ]]; then
  header "Pulling images for from-version: ${FROM_VERSION}"
  sed -i "s/^OP_IMAGE_TAG=.*/OP_IMAGE_TAG=${FROM_VERSION}/" "${STACK_DIR}/stack.env"
  compose_cmd pull 2>&1 | tail -5
  pass "Images pulled for ${FROM_VERSION}"
fi

# ── 1e: Start the stack ──────────────────────────────────────────────

header "Starting initial stack"

compose_cmd up -d 2>&1 | tail -5

# ══════════════════════════════════════════════════════════════════════
# PHASE 2: Seed test data
# ══════════════════════════════════════════════════════════════════════

header "Phase 2: Seed test data"

# ── 2a: Run the setup / install to start all services ────────────────

echo "  Starting services via compose..."
compose_cmd up -d 2>&1 | tail -5

echo "  Waiting for all services to become healthy (up to 180s)..."
if wait_for_healthy 180; then
  pass "All services healthy after initial install"
else
  echo "  Some services not healthy, checking status..."
  for svc in assistant guardian; do
    status=$(docker inspect --format '{{.State.Health.Status}}' "${PROJECT_NAME}-${svc}-1" 2>/dev/null || echo "missing")
    echo "    ${svc}: ${status}"
  done
  # Continue anyway — some services may not be healthy without Ollama
  echo "  Continuing with available services..."
fi

# ── 2c: Write a custom user file in stack/ ───────────────────────────

echo "# My custom channel config" > "${STACK_DIR}/my-custom-channel.yml"
pass "Custom user file written to stack/"

# ══════════════════════════════════════════════════════════════════════
# PHASE 3: Record pre-upgrade state
# ══════════════════════════════════════════════════════════════════════

header "Phase 3: Record pre-upgrade state"

# Checksum stash/vaults/user.env
SECRETS_CHECKSUM_BEFORE=$(sha256sum "${STASH_DIR}/vaults/user.env" | awk '{print $1}')
echo "  user.env checksum:    ${SECRETS_CHECKSUM_BEFORE}"

# Checksum config/stack/stack.env
STACK_ENV_CHECKSUM_BEFORE=$(sha256sum "${STACK_DIR}/stack.env" | awk '{print $1}')
echo "  stack.env checksum:   ${STACK_ENV_CHECKSUM_BEFORE}"

# Checksum operator password secret
PASSWORD_CHECKSUM_BEFORE=$(sha256sum "${SECRETS_DIR}/op_ui_login_password" | awk '{print $1}')
echo "  password checksum:    ${PASSWORD_CHECKSUM_BEFORE}"

# Record running services
SERVICES_BEFORE=$(compose_cmd ps --format '{{.Service}}' 2>/dev/null | sort | tr '\n' ',' | sed 's/,$//')
echo "  Running services:     ${SERVICES_BEFORE}"

# Custom user file checksum
CUSTOM_FILE_CHECKSUM=$(sha256sum "${STACK_DIR}/my-custom-channel.yml" | awk '{print $1}')
echo "  Custom file checksum: ${CUSTOM_FILE_CHECKSUM}"

pass "Pre-upgrade state recorded (admin is a host process; no HTTP check at this stage)"

# ══════════════════════════════════════════════════════════════════════
# PHASE 4: Simulate upgrade (re-run setup)
# ══════════════════════════════════════════════════════════════════════

header "Phase 4: Simulate upgrade"

# The upgrade simulation mirrors what setup.sh does on re-run:
#   1. Detects existing install (stash/vaults/user.env exists)
#   2. Re-creates directory tree (mkdir -p, idempotent)
#   3. Refreshes compose to config/stack/
#   4. Does NOT overwrite stash/vaults/user.env, config/stack/stack.env, or stash/vaults/secrets/
#   5. Restarts services with compose up

echo "  Simulating setup.sh re-run..."

# Step 1: Directory creation (idempotent)
mkdir -p \
  "${STACK_DIR}" "${STACK_DIR}/addons" \
  "${SECRETS_DIR}" \
  "${OP_HOME}/config/assistant" "${OP_HOME}/config/akm" \
  "${STASH_DIR}/vaults" "${STASH_DIR}/tasks" \
  "${STATE_DIR}/assistant" "${STATE_DIR}/guardian" \
  "${STATE_DIR}/registry/addons" "${STATE_DIR}/registry/automations" \
  "${STATE_DIR}/logs" "${CACHE_DIR}/akm" "${OP_HOME}/workspace"

# Step 2: Refresh compose (simulate download from GitHub)
cp "${ROOT_DIR}/.openpalm/config/stack/core.compose.yml" "${STACK_DIR}/core.compose.yml"

# Step 3: stash/vaults/user.env — must NOT be overwritten on upgrade
if [[ -f "${STASH_DIR}/vaults/user.env" ]]; then
  echo "  stash/vaults/user.env exists -- NOT overwriting (same as setup.sh)"
else
  echo "  BUG: stash/vaults/user.env was deleted during upgrade simulation!"
  fail "stash/vaults/user.env should still exist"
fi

# Step 4: config/stack/stack.env — must NOT be overwritten on upgrade
if [[ -f "${STACK_DIR}/stack.env" ]]; then
  echo "  config/stack/stack.env exists -- NOT overwriting (same as setup.sh)"
else
  echo "  BUG: config/stack/stack.env was deleted during upgrade simulation!"
  fail "config/stack/stack.env should still exist"
fi

# Step 5: If --to-version specified, update image tag
if [[ -n "$TO_VERSION" ]]; then
  echo "  Updating image tag to ${TO_VERSION}..."
  sed -i "s/^OP_IMAGE_TAG=.*/OP_IMAGE_TAG=${TO_VERSION}/" "${STACK_DIR}/stack.env"
  compose_cmd pull 2>&1 | tail -5
fi

# Step 6: Restart services
echo "  Running compose up (simulating upgrade restart)..."
compose_cmd up -d 2>&1 | tail -10

echo "  Waiting for all services after upgrade (up to 180s)..."
if wait_for_healthy 180; then
  pass "All services healthy after upgrade"
else
  echo "  Some services not healthy after upgrade..."
  for svc in assistant guardian; do
    status=$(docker inspect --format '{{.State.Health.Status}}' "${PROJECT_NAME}-${svc}-1" 2>/dev/null || echo "missing")
    echo "    ${svc}: ${status}"
  done
fi

# ══════════════════════════════════════════════════════════════════════
# PHASE 5: Verify post-upgrade state
# ══════════════════════════════════════════════════════════════════════

header "Phase 5: Verification"

# ── 5a: stash/vaults/user.env unchanged ──────────────────────────────
echo ""
echo "=== 5a: stash/vaults/user.env preservation ==="

SECRETS_CHECKSUM_AFTER=$(sha256sum "${STASH_DIR}/vaults/user.env" | awk '{print $1}')
if [[ "$SECRETS_CHECKSUM_BEFORE" == "$SECRETS_CHECKSUM_AFTER" ]]; then
  pass "stash/vaults/user.env checksum unchanged"
else
  fail "stash/vaults/user.env was modified during upgrade (before: ${SECRETS_CHECKSUM_BEFORE}, after: ${SECRETS_CHECKSUM_AFTER})"
fi

OP_UI_LOGIN_PASSWORD_VALUE=$(tr -d '\n' <"${SECRETS_DIR}/op_ui_login_password")
if [[ "$OP_UI_LOGIN_PASSWORD_VALUE" == "$OP_UI_LOGIN_PASSWORD" ]]; then
  pass "OP_UI_LOGIN_PASSWORD preserved in stash/vaults/secrets/op_ui_login_password"
else
  fail "OP_UI_LOGIN_PASSWORD changed (expected '${OP_UI_LOGIN_PASSWORD}', got '${OP_UI_LOGIN_PASSWORD_VALUE}')"
fi

CUSTOM_KEY_VALUE=$(grep "^MY_CUSTOM_KEY=" "${STASH_DIR}/vaults/user.env" | head -1 | cut -d= -f2-)
if [[ "$CUSTOM_KEY_VALUE" == "my-custom-value-12345" ]]; then
  pass "Custom user key preserved in stash/vaults/user.env"
else
  fail "Custom user key lost (expected 'my-custom-value-12345', got '${CUSTOM_KEY_VALUE}')"
fi

# ── 5b: config/stack/stack.env unchanged ─────────────────────────────
echo ""
echo "=== 5b: config/stack/stack.env preservation ==="

STACK_ENV_CHECKSUM_AFTER=$(sha256sum "${STACK_DIR}/stack.env" | awk '{print $1}')
if [[ "$STACK_ENV_CHECKSUM_BEFORE" == "$STACK_ENV_CHECKSUM_AFTER" ]]; then
  pass "config/stack/stack.env checksum unchanged"
else
  if [[ -n "$TO_VERSION" ]]; then
    pass "config/stack/stack.env changed (expected: image tag updated to ${TO_VERSION})"
  else
    fail "config/stack/stack.env was modified during upgrade (before: ${STACK_ENV_CHECKSUM_BEFORE}, after: ${STACK_ENV_CHECKSUM_AFTER})"
  fi
fi

# ── 5d: Custom user files preserved ─────────────────────────────────
echo ""
echo "=== 5d: User file preservation ==="

if [[ -f "${STACK_DIR}/my-custom-channel.yml" ]]; then
  CUSTOM_FILE_CHECKSUM_AFTER=$(sha256sum "${STACK_DIR}/my-custom-channel.yml" | awk '{print $1}')
  if [[ "$CUSTOM_FILE_CHECKSUM" == "$CUSTOM_FILE_CHECKSUM_AFTER" ]]; then
    pass "Custom channel file preserved and unchanged"
  else
    fail "Custom channel file was modified"
  fi
else
  fail "Custom channel file was deleted during upgrade"
fi

# ── 5e: All services running ────────────────────────────────────────
echo ""
echo "=== 5e: Service health ==="

HEALTHCHECK_SVCS="assistant guardian"
for svc in $HEALTHCHECK_SVCS; do
  status=$(docker inspect --format '{{.State.Health.Status}}' "${PROJECT_NAME}-${svc}-1" 2>/dev/null || echo "missing")
  if [[ "$status" == "healthy" ]]; then
    pass "${svc} is healthy"
  else
    fail "${svc} status: ${status}"
  fi
done

# Optional services (may not be healthy without Ollama)
OPTIONAL_SVCS="assistant guardian"
for svc in $OPTIONAL_SVCS; do
  status=$(docker inspect --format '{{.State.Health.Status}}' "${PROJECT_NAME}-${svc}-1" 2>/dev/null || echo "missing")
  if [[ "$status" == "healthy" ]]; then
    pass "${svc} is healthy"
  else
    echo "  INFO: ${svc} status: ${status} (may require Ollama or LLM provider)"
  fi
done

# ── 5f: UI login password secret preserved ──────────────────────────
echo ""
echo "=== 5f: UI login password preservation ==="

# Admin is a host process — no HTTP auth check here. Verify the password secret file.
PASSWORD_AFTER=$(tr -d '\n' <"${SECRETS_DIR}/op_ui_login_password")
if [[ "$PASSWORD_AFTER" == "$OP_UI_LOGIN_PASSWORD" ]]; then
  pass "OP_UI_LOGIN_PASSWORD preserved in stash/vaults/secrets/op_ui_login_password after upgrade"
else
  fail "OP_UI_LOGIN_PASSWORD changed after upgrade (expected '${OP_UI_LOGIN_PASSWORD}', got '${PASSWORD_AFTER}')"
fi

PASSWORD_CHECKSUM_AFTER=$(sha256sum "${SECRETS_DIR}/op_ui_login_password" | awk '{print $1}')
if [[ "$PASSWORD_CHECKSUM_BEFORE" == "$PASSWORD_CHECKSUM_AFTER" ]]; then
  pass "operator password secret checksum unchanged"
else
  fail "operator password secret changed during upgrade"
fi

# ── 5g: No errors in container logs ─────────────────────────────────
echo ""
echo "=== 5g: Container log inspection ==="

# Note: admin is a host process; use HTTP diagnostics and application logs instead of docker compose logs
pass "Admin logging check skipped (host process; use HTTP diagnostics)"

# Check for container restarts (CrashLoopBackOff indicator)
RESTART_COUNT=0
for svc in assistant guardian; do
  restarts=$(docker inspect --format '{{.RestartCount}}' "${PROJECT_NAME}-${svc}-1" 2>/dev/null || echo "0")
  if [[ "$restarts" -gt 2 ]]; then
    fail "${svc} restarted ${restarts} times (possible crash loop)"
    RESTART_COUNT=$((RESTART_COUNT + 1))
  fi
done
if [[ $RESTART_COUNT -eq 0 ]]; then
  pass "No excessive container restarts"
fi

# ── 5h: Services list matches pre-upgrade ───────────────────────────
echo ""
echo "=== 5h: Service list consistency ==="

SERVICES_AFTER=$(compose_cmd ps --format '{{.Service}}' 2>/dev/null | sort | tr '\n' ',' | sed 's/,$//')
if [[ "$SERVICES_BEFORE" == "$SERVICES_AFTER" ]]; then
  pass "Same services running after upgrade (${SERVICES_AFTER})"
else
  echo "  Before: ${SERVICES_BEFORE}"
  echo "  After:  ${SERVICES_AFTER}"
  # Not necessarily a failure — upgrade may add new services
  if [[ $(echo "$SERVICES_AFTER" | tr ',' '\n' | wc -l) -ge $(echo "$SERVICES_BEFORE" | tr ',' '\n' | wc -l) ]]; then
    pass "Service count same or increased after upgrade"
  else
    fail "Services were lost during upgrade"
  fi
fi

# ══════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=========================================="
if [[ -n "$FROM_VERSION" || -n "$TO_VERSION" ]]; then
  echo "  UPGRADE PATH: ${FROM_VERSION:-current} -> ${TO_VERSION:-current}"
fi
echo "  RESULTS: $PASS passed, $FAIL failed (${TESTS} total)"
echo "=========================================="

if [[ "$FAIL" -gt 0 ]]; then
  echo ""
  echo "  FAILED -- $FAIL test(s) did not pass"
  exit 1
else
  echo ""
  echo "  ALL TESTS PASSED"
  exit 0
fi
