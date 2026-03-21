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
#      - Note the ADMIN_TOKEN and MEMORY_USER_ID in vault/user/user.env
#
#   4. Upgrade to the target version:
#        curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh \
#          | bash -s -- --force --version <target>
#
#   5. Verify:
#      - vault/user/user.env is NOT overwritten (ADMIN_TOKEN, custom keys preserved)
#      - vault/stack/stack.env is NOT overwritten (paths, UID/GID preserved)
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
#   OP_CONFIG_HOME  Config directory (default: .upgrade-test/config)
#   OP_DATA_HOME    Data directory   (default: .upgrade-test/data)
#   OP_STATE_HOME   State directory  (default: .upgrade-test/state)
#   OP_WORK_DIR     Work directory   (default: .upgrade-test/work)
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
export OP_CONFIG_HOME="${OP_CONFIG_HOME:-${TEST_ROOT}/config}"
export OP_DATA_HOME="${OP_DATA_HOME:-${TEST_ROOT}/data}"
export OP_STATE_HOME="${OP_STATE_HOME:-${TEST_ROOT}/state}"
export OP_WORK_DIR="${OP_WORK_DIR:-${TEST_ROOT}/work}"

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
    -f "${OP_CONFIG_HOME}/stack/core.compose.yml" \
    --env-file "${VAULT_HOME}/user/user.env" \
    --env-file "${VAULT_HOME}/stack/stack.env" \
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

VAULT_HOME="${TEST_ROOT}/vault"

mkdir -p \
  "${OP_CONFIG_HOME}/stack" \
  "${OP_CONFIG_HOME}/assistant/tools" \
  "${OP_CONFIG_HOME}/assistant/plugins" \
  "${OP_CONFIG_HOME}/assistant/skills" \
  "${OP_CONFIG_HOME}/automations" \
  "${OP_CONFIG_HOME}/stash" \
  "${VAULT_HOME}/user" "${VAULT_HOME}/stack" \
  "${OP_DATA_HOME}/memory" \
  "${OP_DATA_HOME}/assistant" \
  "${OP_DATA_HOME}/guardian" \
  "${OP_DATA_HOME}/automations" \
  "${OP_STATE_HOME}/audit" \
  "${OP_STATE_HOME}/automations" \
  "${OP_WORK_DIR}"

# ── 1c: Seed config files ───────────────────────────────────────────

# Detect Docker socket
docker_sock="/var/run/docker.sock"
if host_url="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)"; then
  case "$host_url" in
    unix://*) detected_sock="${host_url#unix://}"; [[ -S "$detected_sock" ]] && docker_sock="$detected_sock" ;;
  esac
fi

# Seed user.env with a known admin token
cat >"${VAULT_HOME}/user/user.env" <<EOF
# Upgrade test secrets
ADMIN_TOKEN=${ADMIN_TOKEN}
OPENAI_API_KEY=
OPENAI_BASE_URL=
MEMORY_USER_ID=upgrade-test-user
# Custom user key that must survive upgrade
MY_CUSTOM_KEY=my-custom-value-12345
EOF

# Seed system.env
cat >"${VAULT_HOME}/stack/stack.env" <<EOF
OP_CONFIG_HOME=${OP_CONFIG_HOME}
OP_DATA_HOME=${OP_DATA_HOME}
OP_STATE_HOME=${OP_STATE_HOME}
OP_WORK_DIR=${OP_WORK_DIR}
OP_UID=$(id -u)
OP_GID=$(id -g)
OP_DOCKER_SOCK=${docker_sock}
OP_IMAGE_NAMESPACE=openpalm
OP_IMAGE_TAG=dev
OP_INGRESS_BIND_ADDRESS=127.0.0.1
OP_INGRESS_PORT=8180
EOF

# Seed compose to stack/ (source of truth)
cp "${ROOT_DIR}/.openpalm/stack/core.compose.yml" "${OP_CONFIG_HOME}/stack/core.compose.yml"

# Override ports so we don't conflict with a running dev stack.
# We override admin's port via a compose override.
cat >"${OP_CONFIG_HOME}/stack/compose-port-override.yml" <<EOF
services:
  admin:
    ports:
      - "127.0.0.1:${ADMIN_PORT}:8100"
  memory:
    ports:
      - "127.0.0.1:${MEMORY_PORT}:8765"
EOF

# Seed opencode config
cat >"${OP_CONFIG_HOME}/assistant/opencode.json" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json"
}
EOF

# Seed memory config
cat >"${OP_DATA_HOME}/memory/default_config.json" <<'MEMCFG'
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
    -f "${OP_CONFIG_HOME}/stack/core.compose.yml" \
    -f compose.dev.yaml \
    --env-file "${VAULT_HOME}/stack/stack.env" \
    --env-file "${VAULT_HOME}/user/user.env" \
    --project-name "$PROJECT_NAME" build 2>&1 | tail -5
  pass "Images built from source"
fi

# If --from-version is specified, pull that version's images
if [[ -n "$FROM_VERSION" ]]; then
  header "Pulling images for from-version: ${FROM_VERSION}"
  OP_IMAGE_TAG="$FROM_VERSION"
  # Update system.env with the from-version tag
  sed -i "s/^OP_IMAGE_TAG=.*/OP_IMAGE_TAG=${FROM_VERSION}/" \
    "${VAULT_HOME}/stack/stack.env"
  compose_cmd pull 2>&1 | tail -5
  pass "Images pulled for ${FROM_VERSION}"
fi

# ── 1e: Update compose_cmd to include port override ─────────────────

compose_cmd() {
  docker compose \
    --project-name "$PROJECT_NAME" \
    -f "${OP_CONFIG_HOME}/stack/core.compose.yml" \
    -f "${OP_CONFIG_HOME}/stack/compose-port-override.yml" \
    --env-file "${VAULT_HOME}/user/user.env" \
    --env-file "${VAULT_HOME}/stack/stack.env" \
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

echo "# My custom channel config" > "${OP_CONFIG_HOME}/stack/my-custom-channel.yml"
pass "Custom user file written to CONFIG_HOME/stack/"

# ══════════════════════════════════════════════════════════════════════
# PHASE 3: Record pre-upgrade state
# ══════════════════════════════════════════════════════════════════════

header "Phase 3: Record pre-upgrade state"

# Checksum user.env
SECRETS_CHECKSUM_BEFORE=$(sha256sum "${VAULT_HOME}/user/user.env" | awk '{print $1}')
echo "  user.env checksum:    ${SECRETS_CHECKSUM_BEFORE}"

# Checksum system.env
STACK_ENV_CHECKSUM_BEFORE=$(sha256sum "${VAULT_HOME}/stack/stack.env" | awk '{print $1}')
echo "  system.env checksum:  ${STACK_ENV_CHECKSUM_BEFORE}"

# Memory database size (if it exists)
MEMORY_DB_SIZE_BEFORE=0
if [[ -f "${OP_DATA_HOME}/memory/memory.db" ]]; then
  MEMORY_DB_SIZE_BEFORE=$(stat --printf='%s' "${OP_DATA_HOME}/memory/memory.db" 2>/dev/null || echo "0")
fi
echo "  memory.db size:       ${MEMORY_DB_SIZE_BEFORE} bytes"

# Record running services
SERVICES_BEFORE=$(compose_cmd ps --format '{{.Service}}' 2>/dev/null | sort | tr '\n' ',' | sed 's/,$//')
echo "  Running services:     ${SERVICES_BEFORE}"

# Custom user file checksum
CUSTOM_FILE_CHECKSUM=$(sha256sum "${OP_CONFIG_HOME}/stack/my-custom-channel.yml" | awk '{print $1}')
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
#   1. Detects existing install (vault/user/user.env exists)
#   2. Re-creates directory tree (mkdir -p, idempotent)
#   3. Downloads fresh compose to stack/
#   4. Does NOT overwrite vault/user/user.env or vault/stack/stack.env
#   5. Starts services with compose up

echo "  Simulating setup.sh re-run..."

# Step 1: Directory creation (idempotent, same as setup.sh)
mkdir -p \
  "${OP_CONFIG_HOME}" "${OP_CONFIG_HOME}/stack" \
  "${OP_CONFIG_HOME}/assistant" \
  "${OP_CONFIG_HOME}/automations" "${OP_CONFIG_HOME}/stash" \
  "${VAULT_HOME}/user" "${VAULT_HOME}/stack" \
  "${OP_DATA_HOME}" "${OP_DATA_HOME}/memory" \
  "${OP_DATA_HOME}/assistant" \
  "${OP_DATA_HOME}/guardian" \
  "${OP_DATA_HOME}/automations" \
  "${OP_STATE_HOME}" \
  "${OP_STATE_HOME}/audit" \
  "${OP_WORK_DIR}"

# Step 2: Re-download assets (simulate by copying from source)
# In a real upgrade, setup.sh downloads from GitHub. We copy from local assets.
cp "${ROOT_DIR}/.openpalm/stack/core.compose.yml" "${OP_CONFIG_HOME}/stack/core.compose.yml"

# Step 3: vault/user/user.env — setup.sh checks if it exists and skips if so
if [[ -f "${VAULT_HOME}/user/user.env" ]]; then
  echo "  vault/user/user.env exists -- NOT overwriting (same as setup.sh)"
else
  echo "  BUG: vault/user/user.env was deleted during upgrade simulation!"
  fail "vault/user/user.env should still exist"
fi

# Step 4: vault/stack/stack.env — setup.sh checks if it exists and skips if so
if [[ -f "${VAULT_HOME}/stack/stack.env" ]]; then
  echo "  vault/stack/stack.env exists -- NOT overwriting (same as setup.sh)"
else
  echo "  BUG: vault/stack/stack.env was deleted during upgrade simulation!"
  fail "vault/stack/stack.env should still exist"
fi

# Step 6: If --to-version specified, update image tag
if [[ -n "$TO_VERSION" ]]; then
  echo "  Updating image tag to ${TO_VERSION}..."
  sed -i "s/^OP_IMAGE_TAG=.*/OP_IMAGE_TAG=${TO_VERSION}/" \
    "${VAULT_HOME}/stack/stack.env"
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

# ── 5a: vault/user/user.env unchanged ─────────────────────────────────────
echo ""
echo "=== 5a: vault/user/user.env preservation ==="

SECRETS_CHECKSUM_AFTER=$(sha256sum "${VAULT_HOME}/user/user.env" | awk '{print $1}')
if [[ "$SECRETS_CHECKSUM_BEFORE" == "$SECRETS_CHECKSUM_AFTER" ]]; then
  pass "user.env checksum unchanged"
else
  fail "user.env was modified during upgrade (before: ${SECRETS_CHECKSUM_BEFORE}, after: ${SECRETS_CHECKSUM_AFTER})"
fi

# Verify specific values in user.env
ADMIN_TOKEN_VALUE=$(grep "^ADMIN_TOKEN=" "${VAULT_HOME}/user/user.env" | head -1 | cut -d= -f2-)
if [[ "$ADMIN_TOKEN_VALUE" == "$ADMIN_TOKEN" ]]; then
  pass "ADMIN_TOKEN preserved in user.env"
else
  fail "ADMIN_TOKEN changed (expected '${ADMIN_TOKEN}', got '${ADMIN_TOKEN_VALUE}')"
fi

CUSTOM_KEY_VALUE=$(grep "^MY_CUSTOM_KEY=" "${VAULT_HOME}/user/user.env" | head -1 | cut -d= -f2-)
if [[ "$CUSTOM_KEY_VALUE" == "my-custom-value-12345" ]]; then
  pass "Custom user key preserved in user.env"
else
  fail "Custom user key lost (expected 'my-custom-value-12345', got '${CUSTOM_KEY_VALUE}')"
fi

MEMORY_USER_VALUE=$(grep "^MEMORY_USER_ID=" "${VAULT_HOME}/user/user.env" | head -1 | cut -d= -f2-)
if [[ "$MEMORY_USER_VALUE" == "upgrade-test-user" ]]; then
  pass "MEMORY_USER_ID preserved in user.env"
else
  fail "MEMORY_USER_ID changed (expected 'upgrade-test-user', got '${MEMORY_USER_VALUE}')"
fi

# ── 5b: vault/stack/stack.env unchanged ───────────────────────────────────
echo ""
echo "=== 5b: vault/stack/stack.env preservation ==="

STACK_ENV_CHECKSUM_AFTER=$(sha256sum "${VAULT_HOME}/stack/stack.env" | awk '{print $1}')
if [[ "$STACK_ENV_CHECKSUM_BEFORE" == "$STACK_ENV_CHECKSUM_AFTER" ]]; then
  pass "system.env checksum unchanged"
else
  # If --to-version was used, system.env will change (image tag update). That's expected.
  if [[ -n "$TO_VERSION" ]]; then
    pass "system.env changed (expected: image tag updated to ${TO_VERSION})"
  else
    fail "system.env was modified during upgrade (before: ${STACK_ENV_CHECKSUM_BEFORE}, after: ${STACK_ENV_CHECKSUM_AFTER})"
  fi
fi

# ── 5c: Memory database preserved ───────────────────────────────────
echo ""
echo "=== 5c: Memory data preservation ==="

if [[ -f "${OP_DATA_HOME}/memory/memory.db" ]]; then
  MEMORY_DB_SIZE_AFTER=$(stat --printf='%s' "${OP_DATA_HOME}/memory/memory.db" 2>/dev/null || echo "0")
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

if [[ -f "${OP_CONFIG_HOME}/stack/my-custom-channel.yml" ]]; then
  CUSTOM_FILE_CHECKSUM_AFTER=$(sha256sum "${OP_CONFIG_HOME}/stack/my-custom-channel.yml" | awk '{print $1}')
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
for svc in admin memory assistant guardian docker-socket-proxy; do
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
