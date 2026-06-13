#!/usr/bin/env bash
#
# End-to-end test for the OpenPalm production install path.
#
# Simulates what a user would experience running `curl | bash` on a clean
# machine with only Docker installed. Exercises:
#
#   1. Production setup.sh (asset download, dir creation, secrets seeding)
#   2. Admin host process health (HTTP 200)
#   3. Setup wizard API (GET status, POST complete, deploy-status polling)
#   4. Core-service health checks (assistant, guardian)
#   5. Chat channel message round-trip (if installed)
#   6. Cleanup (or --keep to leave stack running)
#
# This script is CI-friendly: structured output, deterministic exit codes,
# no interactive prompts, no browser opens.
#
# Required environment variables:
#   OP_UI_LOGIN_PASSWORD         Admin password to set during setup (default: test-admin-token)
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
#   --local-setup       Use the local repo's setup.sh instead of GitHub raw
#   --version TAG       GitHub ref / release tag to test (default: main)
#   --provider PROVIDER Provider to use: ollama, openai (default: ollama)
#   --timeout SECS      Max seconds to wait for services (default: 300)
#   -h, --help          Show this help
#
set -euo pipefail

# ── Argument parsing ──────────────────────────────────────────────────

KEEP=0
SKIP_INSTALL=0
LOCAL_SETUP=0
VERSION="main"
PROVIDER="ollama"
SERVICE_TIMEOUT=300

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --local-setup) LOCAL_SETUP=1 ;;
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

OP_UI_LOGIN_PASSWORD="${OP_UI_LOGIN_PASSWORD:-test-admin-token}"
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
STASH_HOME="${OP_HOME}/knowledge"

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

  # Prefer the published install script so this exercises the release path.
  SETUP_EXIT=0
  if [ "$LOCAL_SETUP" -eq 1 ] && [ -f "$ROOT_DIR/scripts/setup.sh" ]; then
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
  for dir in "$CONFIG_HOME" "$OP_HOME/data" "$STASH_HOME"; do
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

  # Verify knowledge/env/user.env was seeded
  if [ -f "$STASH_HOME/env/user.env" ]; then
    pass "knowledge/env/user.env created"
  else
    fail "knowledge/env/user.env not created"
  fi
else
  step "Skipping install (--skip-install)"
  echo "  Testing against already-running stack"
fi

# ── Step 4: Wait for admin host process to be healthy ─────────────────

step "Wait for admin host process health"

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
  echo "  Note: admin is a host process; use HTTP diagnostics instead"
  echo "ABORTING -- cannot continue without admin"
  exit 1
fi

# ── Step 5: Verify setup wizard responds ──────────────────────────────

step "Verify setup wizard API"

SETUP_RESPONSE=$(curl -sf "$ADMIN_URL/api/setup/status" 2>/dev/null || echo '{}')
SETUP_COMPLETE=$(json_get "$SETUP_RESPONSE" "setupComplete")

if [ "$SKIP_INSTALL" -eq 1 ]; then
  # If skip-install, setup might already be complete
  if [ "$SETUP_COMPLETE" = "True" ] || [ "$SETUP_COMPLETE" = "true" ]; then
    pass "Setup is already complete (--skip-install mode)"
    :
  else
    pass "Setup API responds (setupComplete=$SETUP_COMPLETE)"
  fi
else
  if [ "$SETUP_COMPLETE" = "False" ] || [ "$SETUP_COMPLETE" = "false" ]; then
    pass "Setup is NOT complete (fresh install confirmed)"
  else
    fail "Expected setup to be incomplete on fresh install, got: $SETUP_COMPLETE"
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
  "version": 2,
  "security": { "uiLoginPassword": "$OP_UI_LOGIN_PASSWORD" },
  "connections": [
    {
      "id": "ollama-local",
      "name": "Ollama",
      "provider": "ollama",
      "baseUrl": "$OLLAMA_URL",
      "apiKey": ""
    }
  ],
  "llm": { "provider": "ollama", "model": "$SYSTEM_MODEL", "baseUrl": "$OLLAMA_URL" },
  "embedding": { "provider": "ollama", "model": "$EMBED_MODEL", "dims": $EMBED_DIMS, "baseUrl": "$OLLAMA_URL" }
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
  "version": 2,
  "security": { "uiLoginPassword": "$OP_UI_LOGIN_PASSWORD" },
  "connections": [
    {
      "id": "openai",
      "name": "OpenAI",
      "provider": "openai",
      "baseUrl": "",
      "apiKey": "$OPENAI_API_KEY"
    }
  ],
  "llm": { "provider": "openai", "model": "gpt-4o-mini", "baseUrl": "" },
  "embedding": { "provider": "openai", "model": "text-embedding-3-small", "dims": 1536, "baseUrl": "" }
}
PAYLOAD
)
      ;;
    *)
      fail "Unknown provider: $PROVIDER (supported: ollama, openai)"
      exit 1
      ;;
  esac

  SETUP_RESULT=$(curl -sf -X POST "$ADMIN_URL/api/setup/complete" \
    -H "content-type: application/json" \
    -d "$SETUP_PAYLOAD" 2>&1 || echo '{"ok": false, "error": "curl failed"}')

  SETUP_OK=$(json_get "$SETUP_RESULT" "ok")

  if [ "$SETUP_OK" = "True" ] || [ "$SETUP_OK" = "true" ]; then
    pass "Setup wizard completed (async deploy started)"
  else
    # The setup POST may drop the connection during deploy.
    # Wait and re-check the status.
    sleep 10
    RETRY_RESPONSE=$(curl -sf "$ADMIN_URL/api/setup/status" 2>/dev/null || echo '{}')
    RETRY_COMPLETE=$(json_get "$RETRY_RESPONSE" "setupComplete")

    if [ "$RETRY_COMPLETE" = "True" ] || [ "$RETRY_COMPLETE" = "true" ]; then
      pass "Setup wizard completed (verified via status re-check)"
    else
      fail "Setup wizard failed. Response: $SETUP_RESULT"
      echo ""
      echo "  Note: admin is a host process; use HTTP diagnostics instead"
    fi
  fi

  # ── Step 6b: Poll deploy-status until complete ────────────────────

  step "Wait for background deploy to finish"

  deploy_elapsed=0
  DEPLOY_DONE=false
  while [ $deploy_elapsed -lt "$SERVICE_TIMEOUT" ]; do
    DEPLOY_STATUS=$(curl -sf "$ADMIN_URL/api/setup/deploy-status" 2>/dev/null || echo '{}')
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

HEALTHCHECK_SVCS="assistant guardian"
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

FINAL_STATUS=$(curl -sf "$ADMIN_URL/api/setup/status" 2>/dev/null || echo '{}')
FINAL_COMPLETE=$(json_get "$FINAL_STATUS" "setupComplete")

if [ "$FINAL_COMPLETE" = "True" ] || [ "$FINAL_COMPLETE" = "true" ]; then
  pass "Setup is marked complete"
else
  fail "Setup is NOT marked complete: $FINAL_COMPLETE"
fi

# ── Step 9: Verify stack.env has expected values ─────────────────

if [ "$SKIP_INSTALL" -eq 0 ]; then
  step "Verify stack.env"

  stack_env="$STASH_HOME/env/stack.env"

  check_stack_env_val() {
    local key="$1" expected="$2"
    local actual
    actual=$(grep -E "^(export )?${key}=" "$stack_env" 2>/dev/null | head -1 | sed 's/^export //' | cut -d= -f2-)
    if [ "$actual" = "$expected" ]; then
      pass "$key=$expected (in stack.env)"
    else
      fail "$key expected '$expected', got '$actual' (in stack.env)"
    fi
  }

  check_stack_env_key() {
    local key="$1"
    local actual
    actual=$(grep -E "^(export )?${key}=" "$stack_env" 2>/dev/null | head -1 | sed 's/^export //' | cut -d= -f2-)
    if [ -n "$actual" ]; then
      pass "$key is set in stack.env"
    else
      fail "$key is empty or missing in stack.env"
    fi
  }

  if grep -Eq '^(export )?(.*SECRET|.*TOKEN|.*PASSWORD|.*API_KEY|.*PRIVATE_KEY|.*CLIENT_SECRET|.*AUTH_JSON|.*CREDENTIALS)=' "$stack_env"; then
    fail "stack.env contains a secret-like key"
  else
    pass "stack.env contains non-secret runtime configuration only"
  fi

  password_secret="$STASH_HOME/secrets/op_ui_login_password"
  if [ -f "$password_secret" ] && [ "$(tr -d '\n' < "$password_secret")" = "$OP_UI_LOGIN_PASSWORD" ]; then
    pass "UI login password is stored in knowledge/secrets/op_ui_login_password"
  else
    fail "UI login password secret file missing or incorrect"
  fi

  # LLM and embedding configuration live in config/akm/config.json, NOT stack.env.
  if [ -f "$CONFIG_HOME/akm/config.json" ]; then
    pass "config/akm/config.json exists"
  else
    fail "config/akm/config.json missing"
  fi
else
  step "Skipping stack.env check (--skip-install)"
fi

# ── Step 10: Verify admin API with token ──────────────────────────────

step "Verify admin API authentication"

COOKIE_JAR="$(mktemp)"
LOGIN_RESPONSE=$(curl -sf -c "$COOKIE_JAR" -X POST "$ADMIN_URL/admin/auth/login" \
  -H "content-type: application/json" \
  -d "{\"password\":\"$OP_UI_LOGIN_PASSWORD\"}" 2>/dev/null || true)
AUTH_RESPONSE=$(curl -sf -b "$COOKIE_JAR" "$ADMIN_URL/admin/health" 2>/dev/null || true)
rm -f "$COOKIE_JAR"
if echo "$LOGIN_RESPONSE" | grep -q '"ok":true' && echo "$AUTH_RESPONSE" | grep -q '"ok":true'; then
  pass "Authenticated admin API request succeeds"
else
  fail "Authenticated admin API request failed"
fi

# ── Step 11: Verify assistant container env ───────────────────────────

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

# Provider credentials live in OpenCode auth.json and AKM/user env, not in
# assistant process env from stack.env. The UI login password is host-side only.
for forbidden in OP_UI_LOGIN_PASSWORD OPENAI_API_KEY GROQ_API_KEY; do
  actual=$(docker exec "openpalm-assistant-1" printenv "$forbidden" 2>/dev/null || true)
  if [ -z "$actual" ]; then
    pass "assistant does not receive $forbidden"
  else
    fail "assistant unexpectedly receives $forbidden"
  fi
done

# ── Step 12: Test guardian-hosted chat/api edge (if installed) ────────

step "Check for guardian-hosted chat/api edge"

CHAT_CONTAINER=$(docker ps --format '{{.Names}}' | grep "openpalm-guardian-api" || true)
if [ -n "$CHAT_CONTAINER" ]; then
  pass "Guardian-hosted chat/api edge is running: $CHAT_CONTAINER"

  # Check chat channel health
  CHAT_HEALTH=$(docker inspect --format '{{.State.Health.Status}}' "$CHAT_CONTAINER" 2>/dev/null || echo "no-healthcheck")
  if [ "$CHAT_HEALTH" = "healthy" ]; then
    pass "Guardian-hosted chat/api edge is healthy"
  elif [ "$CHAT_HEALTH" = "no-healthcheck" ]; then
    # Container running but no healthcheck defined
    CHAT_RUNNING=$(docker inspect --format '{{.State.Status}}' "$CHAT_CONTAINER" 2>/dev/null || echo "unknown")
    if [ "$CHAT_RUNNING" = "running" ]; then
      pass "Guardian-hosted chat/api edge is running (no healthcheck defined)"
    else
      fail "Guardian-hosted chat/api edge status: $CHAT_RUNNING"
    fi
  else
    fail "Guardian-hosted chat/api edge health: $CHAT_HEALTH"
  fi
else
  skip "Guardian-hosted chat/api edge not installed (optional)"
fi

# ── Step 13: Verify no root-owned files (if we created temp dirs) ────

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

# ── Step 14: List all running containers ──────────────────────────────

step "Running container summary"

echo ""
echo "  Container statuses:"
docker ps --filter "name=openpalm" --format "    {{.Names}}\t{{.Status}}" 2>/dev/null || true
echo ""

container_count=$(docker ps --filter "name=openpalm" --format '{{.Names}}' 2>/dev/null | wc -l)
if [ "$container_count" -ge 2 ]; then
  pass "$container_count containers running (expected >= 2 core services)"
else
  fail "Only $container_count containers running (expected >= 2)"
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
