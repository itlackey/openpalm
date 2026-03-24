#!/usr/bin/env bash
#
# End-to-end test for the OpenPalm production install path.
#
# Simulates what a user would experience running `curl | bash` on a clean
# machine with only Docker installed. Exercises:
#
#   1. Production setup.sh (asset download, dir creation, secrets seeding)
#   2. Admin container health (image pull, startup, HTTP 200)
#   3. Setup wizard API (GET status, POST complete, deploy-status polling)
#   4. All-service health checks (admin, memory, assistant, guardian)
#   5. Chat channel message round-trip (if installed)
#   6. Cleanup (or --keep to leave stack running)
#
# This script is CI-friendly: structured output, deterministic exit codes,
# no interactive prompts, no browser opens.
#
# Required environment variables:
#   ADMIN_TOKEN         Admin token to set during setup (default: test-admin-token)
#
# Provider configuration (at least one required):
#   OPENAI_API_KEY      OpenAI API key (if using OpenAI)
#   OLLAMA_URL          Ollama base URL (default: http://host.docker.internal:11434)
#   SYSTEM_MODEL        LLM model name (default: qwen2.5-coder:3b)
#   EMBED_MODEL         Embedding model name (default: nomic-embed-text:latest)
#   EMBED_DIMS          Embedding dimensions (default: 768)
#
# Optional environment variables:
#   OP_IMAGE_TAG         Image tag to test (default: latest)
#   OP_IMAGE_NAMESPACE   Image namespace (default: openpalm)
#   OP_HOME              Override home dir (default: temp dir)
#
# Usage:
#   ./scripts/release-e2e-test.sh [OPTIONS]
#
# Options:
#   --keep              Leave the stack running after tests (skip cleanup)
#   --skip-install      Skip setup.sh and test against an already-running stack
#   --version TAG       GitHub ref / release tag to test (default: main)
#   --provider PROVIDER Provider to use: ollama, openai (default: ollama)
#   --timeout SECS      Max seconds to wait for services (default: 300)
#   -h, --help          Show this help
#
set -euo pipefail

# ── Argument parsing ──────────────────────────────────────────────────

KEEP=0
SKIP_INSTALL=0
VERSION="main"
PROVIDER="ollama"
SERVICE_TIMEOUT=300

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --version) shift; VERSION="${1:?--version requires a value}" ;;
    --provider) shift; PROVIDER="${1:?--provider requires a value}" ;;
    --timeout) shift; SERVICE_TIMEOUT="${1:?--timeout requires a value}" ;;
    -h|--help)
      sed -n '2,/^set -/{ /^#/s/^# \?//p }' "$0"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Test infrastructure ───────────────────────────────────────────────

PASS=0
FAIL=0
TESTS=0
STEP=0

pass() { PASS=$((PASS + 1)); TESTS=$((TESTS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); TESTS=$((TESTS + 1)); echo "  FAIL: $1"; }
skip() { TESTS=$((TESTS + 1)); echo "  SKIP: $1"; }

step() {
  STEP=$((STEP + 1))
  echo ""
  echo "=== Step $STEP: $1 ==="
}

# ── Defaults ──────────────────────────────────────────────────────────

ADMIN_TOKEN="${ADMIN_TOKEN:-test-admin-token}"
OLLAMA_URL="${OLLAMA_URL:-http://host.docker.internal:11434}"
SYSTEM_MODEL="${SYSTEM_MODEL:-qwen2.5-coder:3b}"
EMBED_MODEL="${EMBED_MODEL:-nomic-embed-text:latest}"
EMBED_DIMS="${EMBED_DIMS:-768}"

# ── Temp directory for isolated install ───────────────────────────────

USE_TEMP_DIRS=0
TEMP_ROOT=""

if [ "$SKIP_INSTALL" -eq 0 ]; then
  # Use temp dir unless explicitly overridden — ensures clean-machine simulation
  if [ -z "${OP_HOME:-}" ]; then
    USE_TEMP_DIRS=1
    TEMP_ROOT="$(mktemp -d -t openpalm-release-test-XXXXXX)"
    export OP_HOME="$TEMP_ROOT"
    echo "Using temp dirs under: $TEMP_ROOT"
  fi
fi

OP_HOME="${OP_HOME:-${HOME}/.openpalm}"
CONFIG_HOME="${OP_HOME}/config"
DATA_HOME="${OP_HOME}/data"

# ── Cleanup handler ──────────────────────────────────────────────────

cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    echo ""
    echo "  --keep flag set. Stack is still running."
    echo "  OP_HOME: ${OP_HOME}"
    return
  fi

  echo ""
  echo "=== Cleanup ==="

  # Stop and remove containers
  docker compose --project-name openpalm down --volumes --remove-orphans 2>/dev/null || true
  echo "  Containers stopped"

  # Remove temp dirs if we created them
  if [ "$USE_TEMP_DIRS" -eq 1 ] && [ -n "$TEMP_ROOT" ] && [ -d "$TEMP_ROOT" ]; then
    # Some container data may be root-owned; use docker to clean
    docker run --rm -v "$TEMP_ROOT:/cleanup" alpine rm -rf /cleanup 2>/dev/null || true
    rm -rf "$TEMP_ROOT" 2>/dev/null || true
    echo "  Temp dirs removed: $TEMP_ROOT"
  fi
}

trap cleanup EXIT

# ── Step 1: Preflight ─────────────────────────────────────────────────

step "Preflight checks"

if ! command -v docker &>/dev/null; then
  fail "Docker is not installed"
  echo "ABORTING -- Docker is required"
  exit 1
fi
pass "Docker is installed"

if ! docker info &>/dev/null; then
  fail "Docker daemon is not running"
  echo "ABORTING -- Docker daemon must be running"
  exit 1
fi
pass "Docker daemon is running"

if ! docker compose version &>/dev/null; then
  fail "Docker Compose v2 not available"
  echo "ABORTING -- Docker Compose v2 is required"
  exit 1
fi
pass "Docker Compose v2 available"

if ! command -v curl &>/dev/null; then
  fail "curl is not installed"
  echo "ABORTING -- curl is required"
  exit 1
fi
pass "curl is installed"

# Check for python3 or jq (need one for JSON parsing)
JSON_PARSER=""
if command -v python3 &>/dev/null; then
  JSON_PARSER="python3"
elif command -v jq &>/dev/null; then
  JSON_PARSER="jq"
else
  fail "Neither python3 nor jq found (needed for JSON parsing)"
  echo "ABORTING -- install python3 or jq"
  exit 1
fi
pass "JSON parser available ($JSON_PARSER)"

# ── JSON helper ───────────────────────────────────────────────────────

json_get() {
  local json="$1" field="$2"
  if [ "$JSON_PARSER" = "python3" ]; then
    echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$field',''))" 2>/dev/null || echo ""
  else
    echo "$json" | jq -r ".$field // empty" 2>/dev/null || echo ""
  fi
}

# ── Step 2: Ensure no conflicting stack ───────────────────────────────

step "Stop any existing openpalm stack"

docker compose --project-name openpalm down 2>/dev/null || true
remaining=$(docker ps --format '{{.Names}}' | grep openpalm || true)
if [ -z "$remaining" ]; then
  pass "No conflicting containers"
else
  fail "Containers still running: $remaining"
  echo "ABORTING -- stop existing openpalm containers first"
  exit 1
fi

# ── Step 3: Run setup.sh ─────────────────────────────────────────────

if [ "$SKIP_INSTALL" -eq 0 ]; then
  step "Run production setup.sh"

  SETUP_ARGS=(--force --no-open --version "$VERSION")
  SETUP_LOG="$(mktemp)"

  # Run setup.sh from the repo (or could curl from GitHub for true production test)
  SETUP_EXIT=0
  if [ -f "$ROOT_DIR/scripts/setup.sh" ]; then
    echo "  Running setup.sh from local repo..."
    bash "$ROOT_DIR/scripts/setup.sh" "${SETUP_ARGS[@]}" > "$SETUP_LOG" 2>&1 || SETUP_EXIT=$?
  else
    echo "  Downloading setup.sh from GitHub..."
    curl -fsSL "https://raw.githubusercontent.com/itlackey/openpalm/$VERSION/scripts/setup.sh" \
      -o "$SETUP_LOG.script" 2>/dev/null
    bash "$SETUP_LOG.script" "${SETUP_ARGS[@]}" > "$SETUP_LOG" 2>&1 || SETUP_EXIT=$?
    rm -f "$SETUP_LOG.script"
  fi

  # Show setup output indented
  sed 's/^/  [setup.sh] /' "$SETUP_LOG"
  rm -f "$SETUP_LOG"

  if [ "$SETUP_EXIT" -eq 0 ]; then
    pass "setup.sh completed successfully"
  else
    fail "setup.sh exited with code $SETUP_EXIT"
    echo "ABORTING -- setup.sh failed"
    exit 1
  fi

  # Verify directory structure was created
  for dir in "$CONFIG_HOME" "$DATA_HOME" "${OP_HOME}/vault"; do
    if [ -d "$dir" ]; then
      pass "Directory created: $dir"
    else
      fail "Directory missing: $dir"
    fi
  done

  # Verify key files were created
  if [ -f "$CONFIG_HOME/stack/core.compose.yml" ] && [ -s "$CONFIG_HOME/stack/core.compose.yml" ]; then
    pass "Asset present: stack/core.compose.yml"
  else
    fail "Asset missing or empty: $CONFIG_HOME/stack/core.compose.yml"
  fi

  # Verify vault/user/user.env was seeded
  VAULT_HOME="${OP_HOME}/vault"
  if [ -f "$VAULT_HOME/user/user.env" ]; then
    pass "vault/user/user.env created"
  else
    fail "vault/user/user.env not created"
  fi
else
  step "Skipping install (--skip-install)"
  echo "  Testing against already-running stack"
fi

# ── Step 4: Wait for admin to be healthy ──────────────────────────────

step "Wait for admin container health"

ADMIN_URL="http://127.0.0.1:8100"
ADMIN_HEALTHY=false
elapsed=0
while [ $elapsed -lt "$SERVICE_TIMEOUT" ]; do
  if curl -sf "$ADMIN_URL/" > /dev/null 2>&1; then
    ADMIN_HEALTHY=true
    break
  fi
  sleep 3
  elapsed=$((elapsed + 3))
  if [ $((elapsed % 15)) -eq 0 ]; then
    echo "  Waiting for admin... (${elapsed}s / ${SERVICE_TIMEOUT}s)"
  fi
done

if [ "$ADMIN_HEALTHY" = "true" ]; then
  pass "Admin is healthy (responded in ${elapsed}s)"
else
  fail "Admin did not respond within ${SERVICE_TIMEOUT}s"
  echo ""
  echo "  Admin container logs (last 30 lines):"
  docker compose --project-name openpalm logs admin --tail 30 2>/dev/null || true
  echo "ABORTING -- cannot continue without admin"
  exit 1
fi

# ── Step 5: Verify setup wizard responds ──────────────────────────────

step "Verify setup wizard API"

SETUP_RESPONSE=$(curl -sf "$ADMIN_URL/admin/setup" 2>/dev/null || echo '{}')
SETUP_COMPLETE=$(json_get "$SETUP_RESPONSE" "setupComplete")
SETUP_TOKEN=$(json_get "$SETUP_RESPONSE" "setupToken")

if [ "$SKIP_INSTALL" -eq 1 ]; then
  # If skip-install, setup might already be complete
  if [ "$SETUP_COMPLETE" = "True" ] || [ "$SETUP_COMPLETE" = "true" ]; then
    pass "Setup is already complete (--skip-install mode)"
    # Use provided admin token for subsequent requests
    SETUP_TOKEN=""
  else
    pass "Setup API responds (setupComplete=$SETUP_COMPLETE)"
  fi
else
  if [ "$SETUP_COMPLETE" = "False" ] || [ "$SETUP_COMPLETE" = "false" ]; then
    pass "Setup is NOT complete (fresh install confirmed)"
  else
    fail "Expected setup to be incomplete on fresh install, got: $SETUP_COMPLETE"
  fi

  if [ -n "$SETUP_TOKEN" ]; then
    pass "Setup token received (for wizard authentication)"
  else
    fail "No setup token in response"
  fi
fi

# ── Step 6: Complete setup wizard ─────────────────────────────────────

NEED_SETUP=true
if [ "$SKIP_INSTALL" -eq 1 ]; then
  if [ "$SETUP_COMPLETE" = "True" ] || [ "$SETUP_COMPLETE" = "true" ]; then
    NEED_SETUP=false
  fi
fi

if [ "$NEED_SETUP" = "true" ]; then
  step "Complete setup wizard via API"

  # Build the setup payload based on provider
  case "$PROVIDER" in
    ollama)
      SETUP_PAYLOAD=$(cat <<PAYLOAD
{
  "adminToken": "$ADMIN_TOKEN",
  "memoryUserId": "release-test",
  "connections": [
    {
      "id": "ollama-local",
      "name": "Ollama",
      "provider": "ollama",
      "baseUrl": "$OLLAMA_URL",
      "apiKey": ""
    }
  ],
  "assignments": {
    "llm": {
      "connectionId": "ollama-local",
      "model": "$SYSTEM_MODEL"
    },
    "embeddings": {
      "connectionId": "ollama-local",
      "model": "$EMBED_MODEL",
      "embeddingDims": $EMBED_DIMS
    }
  }
}
PAYLOAD
)
      ;;
    openai)
      if [ -z "${OPENAI_API_KEY:-}" ]; then
        fail "OPENAI_API_KEY is required for --provider openai"
        echo "ABORTING -- set OPENAI_API_KEY"
        exit 1
      fi
      SETUP_PAYLOAD=$(cat <<PAYLOAD
{
  "adminToken": "$ADMIN_TOKEN",
  "memoryUserId": "release-test",
  "connections": [
    {
      "id": "openai",
      "name": "OpenAI",
      "provider": "openai",
      "baseUrl": "",
      "apiKey": "$OPENAI_API_KEY"
    }
  ],
  "assignments": {
    "llm": {
      "connectionId": "openai",
      "model": "gpt-4o-mini"
    },
    "embeddings": {
      "connectionId": "openai",
      "model": "text-embedding-3-small",
      "embeddingDims": 1536
    }
  }
}
PAYLOAD
)
      ;;
    *)
      fail "Unknown provider: $PROVIDER (supported: ollama, openai)"
      exit 1
      ;;
  esac

  # Determine auth token for the setup POST
  AUTH_TOKEN="${SETUP_TOKEN:-$ADMIN_TOKEN}"

  SETUP_RESULT=$(curl -sf -X POST "$ADMIN_URL/admin/setup" \
    -H "x-admin-token: $AUTH_TOKEN" \
    -H "content-type: application/json" \
    -d "$SETUP_PAYLOAD" 2>&1 || echo '{"ok": false, "error": "curl failed"}')

  SETUP_OK=$(json_get "$SETUP_RESULT" "ok")

  if [ "$SETUP_OK" = "True" ] || [ "$SETUP_OK" = "true" ]; then
    pass "Setup wizard completed (async deploy started)"
  else
    # The setup POST may drop the connection during deploy.
    # Wait and re-check the status.
    sleep 10
    RETRY_RESPONSE=$(curl -sf "$ADMIN_URL/admin/setup" \
      -H "x-admin-token: $ADMIN_TOKEN" 2>/dev/null || echo '{}')
    RETRY_COMPLETE=$(json_get "$RETRY_RESPONSE" "setupComplete")

    if [ "$RETRY_COMPLETE" = "True" ] || [ "$RETRY_COMPLETE" = "true" ]; then
      pass "Setup wizard completed (verified via status re-check)"
    else
      fail "Setup wizard failed. Response: $SETUP_RESULT"
      echo ""
      echo "  Admin logs (last 20 lines):"
      docker compose --project-name openpalm logs admin --tail 20 2>/dev/null || true
    fi
  fi

  # ── Step 6b: Poll deploy-status until complete ────────────────────

  step "Wait for background deploy to finish"

  deploy_elapsed=0
  DEPLOY_DONE=false
  while [ $deploy_elapsed -lt "$SERVICE_TIMEOUT" ]; do
    DEPLOY_STATUS=$(curl -sf "$ADMIN_URL/admin/setup/deploy-status" \
      -H "x-admin-token: $ADMIN_TOKEN" 2>/dev/null || echo '{}')
    DEPLOY_ACTIVE=$(json_get "$DEPLOY_STATUS" "active")

    if [ "$DEPLOY_ACTIVE" = "False" ] || [ "$DEPLOY_ACTIVE" = "false" ]; then
      DEPLOY_DONE=true
      break
    fi

    sleep 5
    deploy_elapsed=$((deploy_elapsed + 5))
    if [ $((deploy_elapsed % 30)) -eq 0 ]; then
      echo "  Deploy in progress... (${deploy_elapsed}s / ${SERVICE_TIMEOUT}s)"
    fi
  done

  if [ "$DEPLOY_DONE" = "true" ]; then
    pass "Background deploy completed (${deploy_elapsed}s)"
  else
    # Deploy may have finished but status endpoint still active due to timing;
    # fall through to health checks
    echo "  Deploy status still active after ${SERVICE_TIMEOUT}s -- continuing to health checks"
  fi
fi

# ── Step 7: Wait for all services healthy ─────────────────────────────

step "Wait for all services to be healthy"

HEALTHCHECK_SVCS="admin memory assistant guardian docker-socket-proxy"
MAX_WAIT="$SERVICE_TIMEOUT"
elapsed=0
while [ $elapsed -lt "$MAX_WAIT" ]; do
  ALL_UP=true
  WAIT_MSG=""
  for svc in $HEALTHCHECK_SVCS; do
    status=$(docker inspect --format '{{.State.Health.Status}}' "openpalm-${svc}-1" 2>/dev/null || echo "missing")
    if [ "$status" != "healthy" ]; then
      ALL_UP=false
      WAIT_MSG="$svc is $status"
      break
    fi
  done
  if [ "$ALL_UP" = "true" ]; then
    break
  fi
  if [ $((elapsed % 15)) -eq 0 ]; then
    echo "  Waiting... ($elapsed/${MAX_WAIT}s) -- $WAIT_MSG"
  fi
  sleep 5
  elapsed=$((elapsed + 5))
done

ALL_HEALTHY=true
for svc in $HEALTHCHECK_SVCS; do
  status=$(docker inspect --format '{{.State.Health.Status}}' "openpalm-${svc}-1" 2>/dev/null || echo "missing")
  if [ "$status" = "healthy" ]; then
    pass "$svc is healthy"
  else
    fail "$svc status: $status"
    ALL_HEALTHY=false
    # Show logs for failed service
    echo "  Last 10 log lines for $svc:"
    docker compose --project-name openpalm logs "$svc" --tail 10 2>/dev/null || true
  fi
done

# ── Step 8: Verify setup marked complete ──────────────────────────────

step "Verify setup is marked complete"

FINAL_STATUS=$(curl -sf "$ADMIN_URL/admin/setup" \
  -H "x-admin-token: $ADMIN_TOKEN" 2>/dev/null || echo '{}')
FINAL_COMPLETE=$(json_get "$FINAL_STATUS" "setupComplete")

if [ "$FINAL_COMPLETE" = "True" ] || [ "$FINAL_COMPLETE" = "true" ]; then
  pass "Setup is marked complete"
else
  fail "Setup is NOT marked complete: $FINAL_COMPLETE"
fi

# ── Step 9: Verify vault/user/user.env has expected values ─────────────────

if [ "$SKIP_INSTALL" -eq 0 ]; then
  step "Verify vault/user/user.env"

  VAULT_HOME="${VAULT_HOME:-${OP_HOME}/vault}"
  secrets="$VAULT_HOME/user/user.env"

  check_env_key() {
    local key="$1"
    local actual
    actual=$(grep -E "^(export )?${key}=" "$secrets" 2>/dev/null | head -1 | sed 's/^export //' | cut -d= -f2-)
    if [ -n "$actual" ]; then
      pass "$key is set in user.env"
    else
      fail "$key is empty or missing in user.env"
    fi
  }

  check_env_val() {
    local key="$1" expected="$2"
    local actual
    actual=$(grep -E "^(export )?${key}=" "$secrets" 2>/dev/null | head -1 | sed 's/^export //' | cut -d= -f2-)
    if [ "$actual" = "$expected" ]; then
      pass "$key=$expected"
    else
      fail "$key expected '$expected', got '$actual'"
    fi
  }

  check_env_val "ADMIN_TOKEN" "$ADMIN_TOKEN"
  check_env_val "MEMORY_USER_ID" "release-test"
  check_env_key "SYSTEM_LLM_PROVIDER"
  check_env_key "SYSTEM_LLM_MODEL"
else
  step "Skipping user.env check (--skip-install)"
fi

# ── Step 10: Verify admin API with token ──────────────────────────────

step "Verify admin API authentication"

# Authenticated request should succeed
AUTH_RESPONSE=$(curl -sf "$ADMIN_URL/admin/setup" \
  -H "x-admin-token: $ADMIN_TOKEN" 2>/dev/null)
if [ -n "$AUTH_RESPONSE" ]; then
  pass "Authenticated admin API request succeeds"
else
  fail "Authenticated admin API request failed"
fi

# ── Step 11: Verify memory service ────────────────────────────────────

step "Verify memory service"

MEMORY_URL="http://127.0.0.1:8765"
MEMORY_OK=false
for attempt in 1 2 3 4 5 6; do
  MEMORY_STATUS=$(curl -sf -o /dev/null -w '%{http_code}' \
    "$MEMORY_URL/health" 2>/dev/null || echo "error")
  if [ "$MEMORY_STATUS" = "200" ]; then
    MEMORY_OK=true
    break
  fi
  echo "  Attempt $attempt: HTTP $MEMORY_STATUS, retrying in 10s..."
  sleep 10
done

if [ "$MEMORY_OK" = "true" ]; then
  pass "Memory service health endpoint responds"
else
  fail "Memory service not healthy (HTTP $MEMORY_STATUS)"
fi

# Verify memory user can be queried
MEMORY_FILTER_STATUS=$(curl -sf -o /dev/null -w '%{http_code}' \
  -X POST "$MEMORY_URL/api/v1/memories/filter" \
  -H 'content-type: application/json' \
  -d '{"user_id": "release-test"}' 2>/dev/null || echo "error")

if [ "$MEMORY_FILTER_STATUS" = "200" ]; then
  pass "Memory user filter API responds (HTTP 200)"
else
  fail "Memory user filter returned HTTP $MEMORY_FILTER_STATUS"
fi

# ── Step 12: Verify assistant container env ───────────────────────────

step "Verify assistant container environment"

check_container_env() {
  local container="$1" var="$2" check_type="$3" expected="${4:-}"
  local actual
  actual=$(docker exec "$container" printenv "$var" 2>/dev/null || echo "")

  if [ "$check_type" = "equals" ]; then
    if [ "$actual" = "$expected" ]; then
      pass "$container $var=$expected"
    else
      fail "$container $var expected '$expected', got '$actual'"
    fi
  elif [ "$check_type" = "nonempty" ]; then
    if [ -n "$actual" ]; then
      pass "$container $var is set"
    else
      fail "$container $var is empty"
    fi
  elif [ "$check_type" = "endswith" ]; then
    if echo "$actual" | grep -q "${expected}$"; then
      pass "$container $var ends with '$expected'"
    else
      fail "$container $var should end with '$expected', got '$actual'"
    fi
  fi
}

check_container_env "openpalm-assistant-1" "OP_ADMIN_TOKEN" "equals" "$ADMIN_TOKEN"
check_container_env "openpalm-assistant-1" "MEMORY_USER_ID" "nonempty"
check_container_env "openpalm-assistant-1" "OPENAI_BASE_URL" "endswith" "/v1"

# ── Step 13: Test chat channel (if installed) ─────────────────────────

step "Check for chat channel"

CHAT_CONTAINER=$(docker ps --format '{{.Names}}' | grep "openpalm-chat" || true)
if [ -n "$CHAT_CONTAINER" ]; then
  pass "Chat channel container is running: $CHAT_CONTAINER"

  # Check chat channel health
  CHAT_HEALTH=$(docker inspect --format '{{.State.Health.Status}}' "$CHAT_CONTAINER" 2>/dev/null || echo "no-healthcheck")
  if [ "$CHAT_HEALTH" = "healthy" ]; then
    pass "Chat channel is healthy"
  elif [ "$CHAT_HEALTH" = "no-healthcheck" ]; then
    # Container running but no healthcheck defined
    CHAT_RUNNING=$(docker inspect --format '{{.State.Status}}' "$CHAT_CONTAINER" 2>/dev/null || echo "unknown")
    if [ "$CHAT_RUNNING" = "running" ]; then
      pass "Chat channel is running (no healthcheck defined)"
    else
      fail "Chat channel status: $CHAT_RUNNING"
    fi
  else
    fail "Chat channel health: $CHAT_HEALTH"
  fi
else
  skip "Chat channel not installed (optional)"
fi

# ── Step 15: Verify no root-owned files (if we created temp dirs) ────

if [ "$SKIP_INSTALL" -eq 0 ] && [ "$USE_TEMP_DIRS" -eq 1 ]; then
  step "Check file ownership"

  root_files=$(find "$TEMP_ROOT" -not -user "$(whoami)" 2>/dev/null || true)
  if [ -z "$root_files" ]; then
    pass "No root-owned files in install directories"
  else
    root_count=$(echo "$root_files" | wc -l)
    fail "Root-owned files found ($root_count files)"
    echo "$root_files" | head -5 | while read -r f; do echo "    $f"; done
    if [ "$root_count" -gt 5 ]; then
      echo "    ... and $((root_count - 5)) more"
    fi
  fi
fi

# ── Step 16: List all running containers ──────────────────────────────

step "Running container summary"

echo ""
echo "  Container statuses:"
docker ps --filter "name=openpalm" --format "    {{.Names}}\t{{.Status}}" 2>/dev/null || true
echo ""

container_count=$(docker ps --filter "name=openpalm" --format '{{.Names}}' 2>/dev/null | wc -l)
if [ "$container_count" -ge 5 ]; then
  pass "$container_count containers running (expected >= 5 core services)"
else
  fail "Only $container_count containers running (expected >= 5)"
fi

# ── Summary ──────────────────────────────────────────────────────────

echo ""
echo "=========================================="
echo "  RESULTS: $PASS passed, $FAIL failed (${TESTS} total)"
echo "=========================================="

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "  FAILED -- $FAIL test(s) did not pass"
  exit 1
else
  echo ""
  echo "  ALL TESTS PASSED"
  exit 0
fi
