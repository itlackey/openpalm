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
#      - Add a memory via the assistant or memory API
#      - Install a channel
#      - Note the ADMIN_TOKEN and MEMORY_USER_ID in secrets.env
#
#   4. Upgrade to the target version:
#        curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh \
#          | bash -s -- --force --version <target>
#
#   5. Verify:
#      - secrets.env is NOT overwritten (ADMIN_TOKEN, custom keys preserved)
#      - stack.env is NOT overwritten (paths, UID/GID preserved)
#      - Memory database still exists and responds
#      - All services come back healthy
#      - Admin token still authenticates
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
#   OPENPALM_CONFIG_HOME  Config directory (default: .upgrade-test/config)
#   OPENPALM_DATA_HOME    Data directory   (default: .upgrade-test/data)
#   OPENPALM_STATE_HOME   State directory  (default: .upgrade-test/state)
#   OPENPALM_WORK_DIR     Work directory   (default: .upgrade-test/work)
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
export OPENPALM_CONFIG_HOME="${OPENPALM_CONFIG_HOME:-${TEST_ROOT}/config}"
export OPENPALM_DATA_HOME="${OPENPALM_DATA_HOME:-${TEST_ROOT}/data}"
export OPENPALM_STATE_HOME="${OPENPALM_STATE_HOME:-${TEST_ROOT}/state}"
export OPENPALM_WORK_DIR="${OPENPALM_WORK_DIR:-${TEST_ROOT}/work}"

PROJECT_NAME="openpalm-upgrade-test"
ADMIN_PORT=8101
ADMIN_URL="http://127.0.0.1:${ADMIN_PORT}"
MEMORY_PORT=8766
ADMIN_TOKEN="upgrade-test-token"

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

compose_cmd() {
  docker compose \
    --project-name "$PROJECT_NAME" \
    -f "${OPENPALM_STATE_HOME}/artifacts/docker-compose.yml" \
    --env-file "${OPENPALM_CONFIG_HOME}/secrets.env" \
    --env-file "${OPENPALM_STATE_HOME}/artifacts/stack.env" \
    "$@"
}

# ── Helper: wait for admin health ────────────────────────────────────

wait_for_admin() {
  local timeout="${1:-90}"
  local elapsed=0
  while [[ $elapsed -lt $timeout ]]; do
    if curl -sf "${ADMIN_URL}/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  return 1
}

# ── Helper: wait for all services healthy ────────────────────────────

wait_for_healthy() {
  local timeout="${1:-180}"
  local elapsed=0
  local services="admin memory assistant guardian docker-socket-proxy"

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
  "${OPENPALM_CONFIG_HOME}/channels" \
  "${OPENPALM_CONFIG_HOME}/assistant/tools" \
  "${OPENPALM_CONFIG_HOME}/assistant/plugins" \
  "${OPENPALM_CONFIG_HOME}/assistant/skills" \
  "${OPENPALM_CONFIG_HOME}/automations" \
  "${OPENPALM_CONFIG_HOME}/stash" \
  "${OPENPALM_DATA_HOME}/memory" \
  "${OPENPALM_DATA_HOME}/assistant" \
  "${OPENPALM_DATA_HOME}/guardian" \
  "${OPENPALM_DATA_HOME}/caddy/data" \
  "${OPENPALM_DATA_HOME}/caddy/config" \
  "${OPENPALM_DATA_HOME}/automations" \
  "${OPENPALM_STATE_HOME}/artifacts/channels/public" \
  "${OPENPALM_STATE_HOME}/artifacts/channels/lan" \
  "${OPENPALM_STATE_HOME}/audit" \
  "${OPENPALM_STATE_HOME}/automations" \
  "${OPENPALM_WORK_DIR}"

# ── 1c: Seed config files ───────────────────────────────────────────

# Detect Docker socket
docker_sock="/var/run/docker.sock"
if host_url="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)"; then
  case "$host_url" in
    unix://*) detected_sock="${host_url#unix://}"; [[ -S "$detected_sock" ]] && docker_sock="$detected_sock" ;;
  esac
fi

# Seed secrets.env with a known admin token
cat >"${OPENPALM_CONFIG_HOME}/secrets.env" <<EOF
# Upgrade test secrets
ADMIN_TOKEN=${ADMIN_TOKEN}
OPENAI_API_KEY=
OPENAI_BASE_URL=
MEMORY_USER_ID=upgrade-test-user
# Custom user key that must survive upgrade
MY_CUSTOM_KEY=my-custom-value-12345
EOF

# Seed stack.env
cat >"${OPENPALM_DATA_HOME}/stack.env" <<EOF
OPENPALM_CONFIG_HOME=${OPENPALM_CONFIG_HOME}
OPENPALM_DATA_HOME=${OPENPALM_DATA_HOME}
OPENPALM_STATE_HOME=${OPENPALM_STATE_HOME}
OPENPALM_WORK_DIR=${OPENPALM_WORK_DIR}
OPENPALM_UID=$(id -u)
OPENPALM_GID=$(id -g)
OPENPALM_DOCKER_SOCK=${docker_sock}
OPENPALM_IMAGE_NAMESPACE=openpalm
OPENPALM_IMAGE_TAG=dev
OPENPALM_INGRESS_BIND_ADDRESS=127.0.0.1
OPENPALM_INGRESS_PORT=8180
EOF

# Seed compose and Caddyfile to DATA_HOME (source of truth)
cp "${ROOT_DIR}/assets/docker-compose.yml" "${OPENPALM_DATA_HOME}/docker-compose.yml"
cp "${ROOT_DIR}/assets/Caddyfile" "${OPENPALM_DATA_HOME}/caddy/Caddyfile"

# Stage artifacts for compose
cp "${OPENPALM_DATA_HOME}/docker-compose.yml" "${OPENPALM_STATE_HOME}/artifacts/docker-compose.yml"
cp "${OPENPALM_DATA_HOME}/caddy/Caddyfile" "${OPENPALM_STATE_HOME}/artifacts/Caddyfile"
cp "${OPENPALM_DATA_HOME}/stack.env" "${OPENPALM_STATE_HOME}/artifacts/stack.env"
cp "${OPENPALM_CONFIG_HOME}/secrets.env" "${OPENPALM_STATE_HOME}/artifacts/secrets.env"

# Override ports so we don't conflict with a running dev stack.
# The compose file uses OPENPALM_INGRESS_PORT for Caddy (8180) and hardcodes
# admin to 127.0.0.1:8100. We override admin's port via a compose override.
cat >"${OPENPALM_STATE_HOME}/artifacts/compose-port-override.yml" <<EOF
services:
  admin:
    ports:
      - "127.0.0.1:${ADMIN_PORT}:8100"
  memory:
    ports:
      - "127.0.0.1:${MEMORY_PORT}:8765"
EOF

# Seed opencode config
cat >"${OPENPALM_CONFIG_HOME}/assistant/opencode.json" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json"
}
EOF

# Seed memory config
cat >"${OPENPALM_DATA_HOME}/memory/default_config.json" <<'MEMCFG'
{
  "mem0": {
    "llm": {
      "provider": "ollama",
      "config": {
        "model": "qwen2.5-coder:3b",
        "temperature": 0.1,
        "max_tokens": 2000,
        "api_key": "not-needed",
        "openai_base_url": "http://host.docker.internal:11434"
      }
    },
    "embedder": {
      "provider": "ollama",
      "config": {
        "model": "nomic-embed-text:latest",
        "api_key": "not-needed",
        "openai_base_url": "http://host.docker.internal:11434"
      }
    },
    "vector_store": {
      "provider": "sqlite-vec",
      "config": {
        "collection_name": "memory",
        "db_path": "/data/memory.db",
        "embedding_model_dims": 768
      }
    }
  },
  "memory": {
    "custom_instructions": ""
  }
}
MEMCFG

pass "Directory tree and config files created"

# ── 1d: Build images (if needed) ─────────────────────────────────────

if [[ $SKIP_BUILD -eq 0 && -z "$FROM_VERSION" ]]; then
  header "Building images from source"
  npm run admin:build 2>&1 | tail -3
  docker compose --project-directory "$ROOT_DIR" \
    -f "${OPENPALM_STATE_HOME}/artifacts/docker-compose.yml" \
    -f compose.dev.yaml \
    --env-file "${OPENPALM_STATE_HOME}/artifacts/stack.env" \
    --env-file "${OPENPALM_STATE_HOME}/artifacts/secrets.env" \
    --project-name "$PROJECT_NAME" build 2>&1 | tail -5
  pass "Images built from source"
fi

# If --from-version is specified, pull that version's images
if [[ -n "$FROM_VERSION" ]]; then
  header "Pulling images for from-version: ${FROM_VERSION}"
  OPENPALM_IMAGE_TAG="$FROM_VERSION"
  # Update stack.env with the from-version tag
  sed -i "s/^OPENPALM_IMAGE_TAG=.*/OPENPALM_IMAGE_TAG=${FROM_VERSION}/" \
    "${OPENPALM_DATA_HOME}/stack.env"
  sed -i "s/^OPENPALM_IMAGE_TAG=.*/OPENPALM_IMAGE_TAG=${FROM_VERSION}/" \
    "${OPENPALM_STATE_HOME}/artifacts/stack.env"
  compose_cmd pull 2>&1 | tail -5
  pass "Images pulled for ${FROM_VERSION}"
fi

# ── 1e: Update compose_cmd to include port override ─────────────────

compose_cmd() {
  docker compose \
    --project-name "$PROJECT_NAME" \
    -f "${OPENPALM_STATE_HOME}/artifacts/docker-compose.yml" \
    -f "${OPENPALM_STATE_HOME}/artifacts/compose-port-override.yml" \
    --env-file "${OPENPALM_CONFIG_HOME}/secrets.env" \
    --env-file "${OPENPALM_STATE_HOME}/artifacts/stack.env" \
    "$@"
}

# ── 1f: Start the stack ──────────────────────────────────────────────

header "Starting initial stack"

compose_cmd up -d docker-socket-proxy admin 2>&1 | tail -5

echo "  Waiting for admin to become healthy..."
if wait_for_admin 90; then
  pass "Admin is healthy"
else
  fail "Admin did not become healthy within 90s"
  echo "Container logs:"
  compose_cmd logs admin 2>&1 | tail -20
  exit 1
fi

# ══════════════════════════════════════════════════════════════════════
# PHASE 2: Seed test data
# ══════════════════════════════════════════════════════════════════════

header "Phase 2: Seed test data"

# ── 2a: Run the setup / install to start all services ────────────────

echo "  Calling admin install endpoint..."
INSTALL_RESULT=$(curl -sf -X POST "${ADMIN_URL}/admin/install" \
  -H "x-admin-token: ${ADMIN_TOKEN}" \
  -H "content-type: application/json" \
  -d '{}' 2>&1 || echo '{"ok":false}')

INSTALL_OK=$(echo "$INSTALL_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null || echo "False")

if [[ "$INSTALL_OK" == "True" ]]; then
  pass "Install endpoint returned ok"
else
  # Install may fail if images aren't available — for dev builds with compose overlay,
  # we need to start services manually
  echo "  Install API returned: $INSTALL_RESULT"
  echo "  Starting services manually via compose..."
  compose_cmd up -d 2>&1 | tail -5
fi

echo "  Waiting for all services to become healthy (up to 180s)..."
if wait_for_healthy 180; then
  pass "All services healthy after initial install"
else
  echo "  Some services not healthy, checking status..."
  for svc in admin memory assistant guardian docker-socket-proxy; do
    status=$(docker inspect --format '{{.State.Health.Status}}' "${PROJECT_NAME}-${svc}-1" 2>/dev/null || echo "missing")
    echo "    ${svc}: ${status}"
  done
  # Continue anyway — memory might not be healthy if Ollama models aren't available
  echo "  Continuing with available services..."
fi

# ── 2b: Seed a test memory via the memory API ────────────────────────

echo "  Adding test memory via memory API..."
MEMORY_ADD_RESULT=$(curl -sf -X POST "http://127.0.0.1:${MEMORY_PORT}/api/v1/memories/" \
  -H "content-type: application/json" \
  -d '{
    "messages": [{"role":"user","content":"My favorite programming language is Rust and I have been coding for 15 years."}],
    "user_id": "upgrade-test-user"
  }' 2>&1 || echo '{"error":"failed"}')

if echo "$MEMORY_ADD_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'results' in d or 'id' in d else 1)" 2>/dev/null; then
  pass "Test memory seeded via memory API"
else
  echo "  Memory API response: $MEMORY_ADD_RESULT"
  echo "  (Memory seeding may fail if Ollama models are not available — this is ok for config-only tests)"
fi

# ── 2c: Write a custom user file in CONFIG_HOME ─────────────────────

echo "# My custom channel config" > "${OPENPALM_CONFIG_HOME}/channels/my-custom-channel.yml"
pass "Custom user file written to CONFIG_HOME/channels/"

# ══════════════════════════════════════════════════════════════════════
# PHASE 3: Record pre-upgrade state
# ══════════════════════════════════════════════════════════════════════

header "Phase 3: Record pre-upgrade state"

# Checksum secrets.env
SECRETS_CHECKSUM_BEFORE=$(sha256sum "${OPENPALM_CONFIG_HOME}/secrets.env" | awk '{print $1}')
echo "  secrets.env checksum: ${SECRETS_CHECKSUM_BEFORE}"

# Checksum stack.env
STACK_ENV_CHECKSUM_BEFORE=$(sha256sum "${OPENPALM_DATA_HOME}/stack.env" | awk '{print $1}')
echo "  stack.env checksum:   ${STACK_ENV_CHECKSUM_BEFORE}"

# Memory database size (if it exists)
MEMORY_DB_SIZE_BEFORE=0
if [[ -f "${OPENPALM_DATA_HOME}/memory/memory.db" ]]; then
  MEMORY_DB_SIZE_BEFORE=$(stat --printf='%s' "${OPENPALM_DATA_HOME}/memory/memory.db" 2>/dev/null || echo "0")
fi
echo "  memory.db size:       ${MEMORY_DB_SIZE_BEFORE} bytes"

# Record running services
SERVICES_BEFORE=$(compose_cmd ps --format '{{.Service}}' 2>/dev/null | sort | tr '\n' ',' | sed 's/,$//')
echo "  Running services:     ${SERVICES_BEFORE}"

# Custom user file checksum
CUSTOM_FILE_CHECKSUM=$(sha256sum "${OPENPALM_CONFIG_HOME}/channels/my-custom-channel.yml" | awk '{print $1}')
echo "  Custom file checksum: ${CUSTOM_FILE_CHECKSUM}"

# Record admin token works
AUTH_CHECK_BEFORE=$(curl -sf -o /dev/null -w '%{http_code}' \
  "${ADMIN_URL}/admin/containers/list" \
  -H "x-admin-token: ${ADMIN_TOKEN}" 2>/dev/null || echo "error")
echo "  Admin auth status:    ${AUTH_CHECK_BEFORE}"

pass "Pre-upgrade state recorded"

# ══════════════════════════════════════════════════════════════════════
# PHASE 4: Simulate upgrade (re-run setup)
# ══════════════════════════════════════════════════════════════════════

header "Phase 4: Simulate upgrade"

# The upgrade simulation mirrors what setup.sh does on re-run:
#   1. Detects existing install (secrets.env exists)
#   2. Re-creates directory tree (mkdir -p, idempotent)
#   3. Downloads fresh assets (compose, Caddyfile) to DATA_HOME
#   4. Copies assets to STATE_HOME staging
#   5. Does NOT overwrite secrets.env or stack.env
#   6. Starts services with compose up

echo "  Simulating setup.sh re-run..."

# Step 1: Directory creation (idempotent, same as setup.sh)
mkdir -p \
  "${OPENPALM_CONFIG_HOME}" "${OPENPALM_CONFIG_HOME}/channels" \
  "${OPENPALM_CONFIG_HOME}/assistant" \
  "${OPENPALM_CONFIG_HOME}/automations" "${OPENPALM_CONFIG_HOME}/stash" \
  "${OPENPALM_DATA_HOME}" "${OPENPALM_DATA_HOME}/memory" \
  "${OPENPALM_DATA_HOME}/assistant" \
  "${OPENPALM_DATA_HOME}/guardian" "${OPENPALM_DATA_HOME}/caddy/data" \
  "${OPENPALM_DATA_HOME}/caddy/config" \
  "${OPENPALM_DATA_HOME}/automations" \
  "${OPENPALM_STATE_HOME}" "${OPENPALM_STATE_HOME}/artifacts" \
  "${OPENPALM_STATE_HOME}/audit" \
  "${OPENPALM_STATE_HOME}/artifacts/channels" \
  "${OPENPALM_WORK_DIR}"

# Step 2: Re-download assets (simulate by copying from source)
# In a real upgrade, setup.sh downloads from GitHub. We copy from local assets.
cp "${ROOT_DIR}/assets/docker-compose.yml" "${OPENPALM_DATA_HOME}/docker-compose.yml"
cp "${ROOT_DIR}/assets/Caddyfile" "${OPENPALM_DATA_HOME}/caddy/Caddyfile"

# Step 3: Stage artifacts (same as setup.sh)
cp "${OPENPALM_DATA_HOME}/docker-compose.yml" "${OPENPALM_STATE_HOME}/artifacts/docker-compose.yml"
cp "${OPENPALM_DATA_HOME}/caddy/Caddyfile" "${OPENPALM_STATE_HOME}/artifacts/Caddyfile"

# Step 4: secrets.env — setup.sh checks if it exists and skips if so
if [[ -f "${OPENPALM_CONFIG_HOME}/secrets.env" ]]; then
  echo "  secrets.env exists -- NOT overwriting (same as setup.sh)"
else
  echo "  BUG: secrets.env was deleted during upgrade simulation!"
  fail "secrets.env should still exist"
fi

# Step 5: stack.env — setup.sh checks if it exists and skips if so
if [[ -f "${OPENPALM_DATA_HOME}/stack.env" ]]; then
  echo "  stack.env exists -- NOT overwriting (same as setup.sh)"
else
  echo "  BUG: stack.env was deleted during upgrade simulation!"
  fail "stack.env should still exist"
fi

# Step 6: If --to-version specified, update image tag
if [[ -n "$TO_VERSION" ]]; then
  echo "  Updating image tag to ${TO_VERSION}..."
  sed -i "s/^OPENPALM_IMAGE_TAG=.*/OPENPALM_IMAGE_TAG=${TO_VERSION}/" \
    "${OPENPALM_DATA_HOME}/stack.env"
  sed -i "s/^OPENPALM_IMAGE_TAG=.*/OPENPALM_IMAGE_TAG=${TO_VERSION}/" \
    "${OPENPALM_STATE_HOME}/artifacts/stack.env"
  compose_cmd pull 2>&1 | tail -5
fi

# Step 7: Restart services (same as setup.sh for IS_UPDATE=1)
echo "  Running compose up (simulating upgrade restart)..."
compose_cmd up -d 2>&1 | tail -10

echo "  Waiting for admin to become healthy after upgrade..."
if wait_for_admin 90; then
  pass "Admin healthy after upgrade"
else
  fail "Admin not healthy after upgrade"
  compose_cmd logs admin 2>&1 | tail -20
fi

echo "  Waiting for all services after upgrade (up to 180s)..."
if wait_for_healthy 180; then
  pass "All services healthy after upgrade"
else
  echo "  Some services not healthy after upgrade..."
  for svc in admin memory assistant guardian docker-socket-proxy; do
    status=$(docker inspect --format '{{.State.Health.Status}}' "${PROJECT_NAME}-${svc}-1" 2>/dev/null || echo "missing")
    echo "    ${svc}: ${status}"
  done
fi

# ══════════════════════════════════════════════════════════════════════
# PHASE 5: Verify post-upgrade state
# ══════════════════════════════════════════════════════════════════════

header "Phase 5: Verification"

# ── 5a: secrets.env unchanged ────────────────────────────────────────
echo ""
echo "=== 5a: secrets.env preservation ==="

SECRETS_CHECKSUM_AFTER=$(sha256sum "${OPENPALM_CONFIG_HOME}/secrets.env" | awk '{print $1}')
if [[ "$SECRETS_CHECKSUM_BEFORE" == "$SECRETS_CHECKSUM_AFTER" ]]; then
  pass "secrets.env checksum unchanged"
else
  fail "secrets.env was modified during upgrade (before: ${SECRETS_CHECKSUM_BEFORE}, after: ${SECRETS_CHECKSUM_AFTER})"
fi

# Verify specific values in secrets.env
ADMIN_TOKEN_VALUE=$(grep "^ADMIN_TOKEN=" "${OPENPALM_CONFIG_HOME}/secrets.env" | head -1 | cut -d= -f2-)
if [[ "$ADMIN_TOKEN_VALUE" == "$ADMIN_TOKEN" ]]; then
  pass "ADMIN_TOKEN preserved in secrets.env"
else
  fail "ADMIN_TOKEN changed (expected '${ADMIN_TOKEN}', got '${ADMIN_TOKEN_VALUE}')"
fi

CUSTOM_KEY_VALUE=$(grep "^MY_CUSTOM_KEY=" "${OPENPALM_CONFIG_HOME}/secrets.env" | head -1 | cut -d= -f2-)
if [[ "$CUSTOM_KEY_VALUE" == "my-custom-value-12345" ]]; then
  pass "Custom user key preserved in secrets.env"
else
  fail "Custom user key lost (expected 'my-custom-value-12345', got '${CUSTOM_KEY_VALUE}')"
fi

MEMORY_USER_VALUE=$(grep "^MEMORY_USER_ID=" "${OPENPALM_CONFIG_HOME}/secrets.env" | head -1 | cut -d= -f2-)
if [[ "$MEMORY_USER_VALUE" == "upgrade-test-user" ]]; then
  pass "MEMORY_USER_ID preserved in secrets.env"
else
  fail "MEMORY_USER_ID changed (expected 'upgrade-test-user', got '${MEMORY_USER_VALUE}')"
fi

# ── 5b: stack.env unchanged ──────────────────────────────────────────
echo ""
echo "=== 5b: stack.env preservation ==="

STACK_ENV_CHECKSUM_AFTER=$(sha256sum "${OPENPALM_DATA_HOME}/stack.env" | awk '{print $1}')
if [[ "$STACK_ENV_CHECKSUM_BEFORE" == "$STACK_ENV_CHECKSUM_AFTER" ]]; then
  pass "stack.env checksum unchanged"
else
  # If --to-version was used, stack.env will change (image tag update). That's expected.
  if [[ -n "$TO_VERSION" ]]; then
    pass "stack.env changed (expected: image tag updated to ${TO_VERSION})"
  else
    fail "stack.env was modified during upgrade (before: ${STACK_ENV_CHECKSUM_BEFORE}, after: ${STACK_ENV_CHECKSUM_AFTER})"
  fi
fi

# ── 5c: Memory database preserved ───────────────────────────────────
echo ""
echo "=== 5c: Memory data preservation ==="

if [[ -f "${OPENPALM_DATA_HOME}/memory/memory.db" ]]; then
  MEMORY_DB_SIZE_AFTER=$(stat --printf='%s' "${OPENPALM_DATA_HOME}/memory/memory.db" 2>/dev/null || echo "0")
  if [[ "$MEMORY_DB_SIZE_AFTER" -ge "$MEMORY_DB_SIZE_BEFORE" && "$MEMORY_DB_SIZE_AFTER" -gt 0 ]]; then
    pass "memory.db preserved (${MEMORY_DB_SIZE_BEFORE} -> ${MEMORY_DB_SIZE_AFTER} bytes)"
  elif [[ "$MEMORY_DB_SIZE_BEFORE" -eq 0 && "$MEMORY_DB_SIZE_AFTER" -eq 0 ]]; then
    pass "memory.db not created (Ollama models likely not available — config-only test)"
  else
    fail "memory.db shrunk (${MEMORY_DB_SIZE_BEFORE} -> ${MEMORY_DB_SIZE_AFTER} bytes)"
  fi
else
  if [[ "$MEMORY_DB_SIZE_BEFORE" -eq 0 ]]; then
    pass "memory.db not present (was not created before upgrade either)"
  else
    fail "memory.db was deleted during upgrade"
  fi
fi

# Check memory API responds (if memory container is healthy)
MEMORY_STATUS=$(docker inspect --format '{{.State.Health.Status}}' "${PROJECT_NAME}-memory-1" 2>/dev/null || echo "missing")
if [[ "$MEMORY_STATUS" == "healthy" ]]; then
  MEMORY_API_STATUS=$(curl -sf -o /dev/null -w '%{http_code}' \
    -X POST "http://127.0.0.1:${MEMORY_PORT}/api/v1/memories/filter" \
    -H 'content-type: application/json' \
    -d '{"user_id": "upgrade-test-user"}' 2>/dev/null || echo "error")
  if [[ "$MEMORY_API_STATUS" == "200" ]]; then
    pass "Memory API responds after upgrade"
  else
    fail "Memory API returned HTTP ${MEMORY_API_STATUS} after upgrade"
  fi
else
  echo "  Memory container not healthy (${MEMORY_STATUS}) — skipping API check"
fi

# ── 5d: Custom user files preserved ─────────────────────────────────
echo ""
echo "=== 5d: User file preservation ==="

if [[ -f "${OPENPALM_CONFIG_HOME}/channels/my-custom-channel.yml" ]]; then
  CUSTOM_FILE_CHECKSUM_AFTER=$(sha256sum "${OPENPALM_CONFIG_HOME}/channels/my-custom-channel.yml" | awk '{print $1}')
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

HEALTHCHECK_SVCS="admin docker-socket-proxy"
for svc in $HEALTHCHECK_SVCS; do
  status=$(docker inspect --format '{{.State.Health.Status}}' "${PROJECT_NAME}-${svc}-1" 2>/dev/null || echo "missing")
  if [[ "$status" == "healthy" ]]; then
    pass "${svc} is healthy"
  else
    fail "${svc} status: ${status}"
  fi
done

# Caddy doesn't have a healthcheck — check if running
caddy_status=$(docker inspect --format '{{.State.Status}}' "${PROJECT_NAME}-caddy-1" 2>/dev/null || echo "missing")
if [[ "$caddy_status" == "running" ]]; then
  pass "caddy is running"
else
  fail "caddy status: ${caddy_status}"
fi

# Optional services (may not be healthy without Ollama)
OPTIONAL_SVCS="memory assistant guardian"
for svc in $OPTIONAL_SVCS; do
  status=$(docker inspect --format '{{.State.Health.Status}}' "${PROJECT_NAME}-${svc}-1" 2>/dev/null || echo "missing")
  if [[ "$status" == "healthy" ]]; then
    pass "${svc} is healthy"
  else
    echo "  INFO: ${svc} status: ${status} (may require Ollama or LLM provider)"
  fi
done

# ── 5f: Admin token still works ─────────────────────────────────────
echo ""
echo "=== 5f: Admin authentication ==="

AUTH_CHECK_AFTER=$(curl -sf -o /dev/null -w '%{http_code}' \
  "${ADMIN_URL}/admin/containers/list" \
  -H "x-admin-token: ${ADMIN_TOKEN}" 2>/dev/null || echo "error")

if [[ "$AUTH_CHECK_AFTER" == "200" ]]; then
  pass "Admin token still authenticates (HTTP 200)"
else
  fail "Admin token failed after upgrade (HTTP ${AUTH_CHECK_AFTER})"
fi

# Verify unauthorized requests are rejected
UNAUTH_CHECK=$(curl -sf -o /dev/null -w '%{http_code}' \
  "${ADMIN_URL}/admin/containers/list" \
  -H "x-admin-token: wrong-token" 2>/dev/null || echo "error")

if [[ "$UNAUTH_CHECK" == "401" || "$UNAUTH_CHECK" == "403" ]]; then
  pass "Unauthorized requests correctly rejected (HTTP ${UNAUTH_CHECK})"
else
  fail "Unauthorized request not rejected (HTTP ${UNAUTH_CHECK})"
fi

# ── 5g: No errors in container logs ─────────────────────────────────
echo ""
echo "=== 5g: Container log inspection ==="

# Check admin logs for fatal errors (ignore expected warnings)
ADMIN_ERRORS=$(compose_cmd logs admin --tail=100 2>&1 | grep -iE 'fatal|panic|unhandled.*exception|ENOENT.*secrets' || true)
if [[ -z "$ADMIN_ERRORS" ]]; then
  pass "No fatal errors in admin logs"
else
  fail "Errors found in admin logs:"
  echo "$ADMIN_ERRORS" | head -5 | while read -r line; do echo "    $line"; done
fi

# Check for container restarts (CrashLoopBackOff indicator)
RESTART_COUNT=0
for svc in admin memory assistant guardian docker-socket-proxy caddy; do
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
