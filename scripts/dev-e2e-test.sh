#!/usr/bin/env bash
#
# End-to-end test for the OpenPalm dev environment.
#
# Cleans all state, rebuilds admin from source, starts the stack,
# runs the setup wizard, and verifies:
#   1. All containers are healthy
#   2. No root-owned files in .dev/
#   3. secrets.env has correct values
#   4. Assistant container has correct env vars
#   5. Memory user is provisioned
#   6. Setup is marked complete
#
# Usage:
#   ./scripts/dev-e2e-test.sh [--skip-build]
#
# Options:
#   --skip-build   Skip npm + Docker image build (use existing image)
#
set -euo pipefail

SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help) echo "Usage: $0 [--skip-build]"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PASS=0
FAIL=0
TESTS=0

pass() { PASS=$((PASS + 1)); TESTS=$((TESTS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); TESTS=$((TESTS + 1)); echo "  FAIL: $1"; }

# ── Step 1: Stop everything ──────────────────────────────────────────
echo ""
echo "=== Step 1: Stop all containers ==="
docker compose --project-name openpalm down 2>/dev/null || true
remaining=$(docker ps --format '{{.Names}}' | grep openpalm || true)
if [ -z "$remaining" ]; then
  pass "All containers stopped"
else
  fail "Containers still running: $remaining"
fi

# ── Step 2: Clean all state ──────────────────────────────────────────
echo ""
echo "=== Step 2: Clean .dev/ state ==="

# Config
echo "# OpenPalm secrets" > .dev/config/secrets.env

# Data — remove everything except models (HF cache)
rm -f .dev/data/memory/default_config.json
rm -f .dev/data/memory/memory.db
rm -f .dev/data/memory/memory.py
rm -f .dev/data/local-models.json
rm -f .dev/data/local-models.yml
rm -f .dev/data/stack.env
rm -f .dev/data/docker-compose.yml
rm -rf .dev/data/backups

# Config — remove generated assistant config so the wizard writes a fresh one
rm -f .dev/config/assistant/opencode.json

# Root-owned data from containers (qdrant, caddy, opencode logs)
docker run --rm -v "$ROOT_DIR/.dev/data/memory:/c" alpine sh -c \
  "rm -rf /c/qdrant" 2>/dev/null || true
docker run --rm -v "$ROOT_DIR/.dev/data/caddy:/c" alpine sh -c \
  "rm -rf /c/data /c/config" 2>/dev/null || true
docker run --rm -v "$ROOT_DIR/.dev/data/opencode:/c" alpine sh -c \
  "find /c -user root -delete" 2>/dev/null || true
docker run --rm -v "$ROOT_DIR/.dev/config/assistant:/c" alpine sh -c \
  "find /c -user root -delete" 2>/dev/null || true

# State artifacts
rm -f .dev/state/artifacts/secrets.env
rm -f .dev/state/artifacts/stack.env
rm -f .dev/state/artifacts/docker-compose.yml
rm -f .dev/state/artifacts/Caddyfile
rm -f .dev/state/artifacts/local-models.yml
rm -f .dev/state/artifacts/manifest.json
rm -f .dev/state/setup-complete
rm -rf .dev/state/artifacts/channels
rm -f .dev/state/audit/admin-audit.jsonl
rm -f .dev/state/audit/guardian-audit.log

pass "State cleaned"

# ── Step 3: Seed fresh config ────────────────────────────────────────
echo ""
echo "=== Step 3: Seed config ==="
./scripts/dev-setup.sh --seed-env --force

# Clear ADMIN_TOKEN from seeded secrets so admin starts in first-boot state.
# dev-setup seeds it for convenience, but the e2e test needs to verify the wizard sets it.
sed -i 's/^ADMIN_TOKEN=.*/ADMIN_TOKEN=/' .dev/config/secrets.env
sed -i 's/^ADMIN_TOKEN=.*/ADMIN_TOKEN=/' .dev/state/artifacts/secrets.env

# Use a dev-only image tag so the wizard's pull step doesn't overwrite locally
# built images with remote ones (e.g. an older Python-based memory:latest).
sed -i 's/^OPENPALM_IMAGE_TAG=.*/OPENPALM_IMAGE_TAG=dev/' .dev/data/stack.env
sed -i 's/^OPENPALM_IMAGE_TAG=.*/OPENPALM_IMAGE_TAG=dev/' .dev/state/artifacts/stack.env

pass "Config seeded (ADMIN_TOKEN cleared, image tag set to dev)"

# ── Step 3b: Ensure local models available on Ollama ─────────────────
echo ""
echo "=== Step 3b: Ensure Ollama models available ==="

OLLAMA_URL="http://localhost:11434"
SYSTEM_MODEL="qwen2.5-coder:3b"
EMBED_MODEL="nomic-embed-text:latest"

# Verify Ollama is running
if ! curl -sf "$OLLAMA_URL/api/tags" > /dev/null 2>&1; then
  fail "Ollama is not running at $OLLAMA_URL"
  echo "ABORTING — Ollama is required for e2e tests"
  exit 1
fi

# Pull models if not already available (idempotent)
for model_info in "$SYSTEM_MODEL|System LLM" "$EMBED_MODEL|Embedding"; do
  IFS='|' read -r model_name model_label <<< "$model_info"
  available=$(curl -sf "$OLLAMA_URL/api/tags" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(m['name']=='$model_name' for m in d.get('models',[])) else 'no')" 2>/dev/null || echo "no")
  if [ "$available" = "yes" ]; then
    echo "  $model_label model already available: $model_name"
  else
    echo "  Pulling $model_label model: $model_name..."
    curl -sf "$OLLAMA_URL/api/pull" -d "{\"name\":\"$model_name\"}" > /dev/null 2>&1
  fi
done

# Verify models are available
AVAILABLE_MODELS=$(curl -sf "$OLLAMA_URL/api/tags" | python3 -c "import sys,json; d=json.load(sys.stdin); print(' '.join(m['name'] for m in d.get('models',[])))" 2>/dev/null || echo "")
if echo "$AVAILABLE_MODELS" | grep -q "qwen2.5-coder:3b"; then
  pass "System model available in Ollama"
else
  fail "System model not found in Ollama. Available: $AVAILABLE_MODELS"
fi
if echo "$AVAILABLE_MODELS" | grep -q "nomic-embed-text"; then
  pass "Embedding model available in Ollama"
else
  fail "Embedding model not found in Ollama. Available: $AVAILABLE_MODELS"
fi

# ── Step 4: Build all images from source ──────────────────────────
if [ "$SKIP_BUILD" -eq 0 ]; then
  echo ""
  echo "=== Step 4: Build all images from source ==="
  npm run admin:build 2>&1 | tail -3
  docker compose --project-directory . \
    -f .dev/state/artifacts/docker-compose.yml \
    -f compose.dev.yaml \
    --env-file .dev/state/artifacts/stack.env \
    --env-file .dev/state/artifacts/secrets.env \
    --project-name openpalm build 2>&1 | tail -5
  pass "All images built"
else
  echo ""
  echo "=== Step 4: Skipping build (--skip-build) ==="
fi

# ── Step 5: Start stack ─────────────────────────────────────────────
echo ""
echo "=== Step 5: Start stack ==="
docker compose --project-directory . \
  -f .dev/state/artifacts/docker-compose.yml \
  -f compose.dev.yaml \
  --env-file .dev/state/artifacts/stack.env \
  --env-file .dev/state/artifacts/secrets.env \
  --project-name openpalm up -d 2>&1 | tail -10

# Wait for admin to be healthy
echo "  Waiting for admin health..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8100/ > /dev/null 2>&1; then
    break
  fi
  sleep 2
done

if curl -sf http://localhost:8100/ > /dev/null 2>&1; then
  pass "Stack started"
else
  fail "Admin not healthy after 60s"
  echo "ABORTING — cannot continue without admin"
  exit 1
fi

# ── Step 6: Verify setup is NOT complete ─────────────────────────────
echo ""
echo "=== Step 6: Verify fresh state ==="
SETUP_RESPONSE=$(curl -s http://localhost:8100/admin/setup)
SETUP_COMPLETE=$(echo "$SETUP_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['setupComplete'])" 2>/dev/null)
SETUP_TOKEN=$(echo "$SETUP_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('setupToken',''))" 2>/dev/null)

if [ "$SETUP_COMPLETE" = "False" ]; then
  pass "Setup is NOT complete (fresh state)"
else
  fail "Setup should not be complete yet"
fi

# ── Step 7: Run setup wizard ─────────────────────────────────────────
echo ""
echo "=== Step 7: Run setup wizard ==="
SETUP_RESULT=$(curl -s -X POST http://localhost:8100/admin/setup \
  -H "x-admin-token: $SETUP_TOKEN" \
  -H "content-type: application/json" \
  -d "{
    \"adminToken\": \"dev-admin-token\",
    \"memoryUserId\": \"node\",
    \"connections\": [
      {
        \"id\": \"ollama-local\",
        \"name\": \"Ollama\",
        \"provider\": \"ollama\",
        \"baseUrl\": \"http://host.docker.internal:11434\",
        \"apiKey\": \"\"
      }
    ],
    \"assignments\": {
      \"llm\": {
        \"connectionId\": \"ollama-local\",
        \"model\": \"qwen2.5-coder:3b\"
      },
      \"embeddings\": {
        \"connectionId\": \"ollama-local\",
        \"model\": \"nomic-embed-text:latest\",
        \"embeddingDims\": 768
      }
    }
  }" 2>&1)

SETUP_OK=$(echo "$SETUP_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null || echo "False")

if [ "$SETUP_OK" = "True" ]; then
  pass "Setup wizard completed"
else
  # Caddy restart may drop the connection — check if setup completed anyway
  sleep 5
  SETUP_COMPLETE2=$(curl -s http://localhost:8100/admin/setup -H "x-admin-token: dev-admin-token" 2>/dev/null | \
    python3 -c "import sys,json; print(json.load(sys.stdin)['setupComplete'])" 2>/dev/null || echo "unknown")
  if [ "$SETUP_COMPLETE2" = "True" ]; then
    pass "Setup wizard completed (verified via status check)"
  else
    fail "Setup wizard failed. Response: $SETUP_RESULT"
  fi
fi

# ── Step 8: Wait for containers ──────────────────────────────────────
echo ""
echo "=== Step 8: Wait for all containers healthy ==="

# Poll until all services are ready (max 120s)
# Healthchecked services must be "healthy"; caddy (no healthcheck) must be "running".
HEALTHCHECK_SVCS="admin memory assistant guardian docker-socket-proxy"
MAX_WAIT=120
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
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
  # Also check caddy is running
  caddy_status=$(docker inspect --format '{{.State.Status}}' "openpalm-caddy-1" 2>/dev/null || echo "missing")
  if [ "$caddy_status" != "running" ]; then
    ALL_UP=false
    WAIT_MSG="caddy is $caddy_status"
  fi
  if [ "$ALL_UP" = "true" ]; then
    break
  fi
  echo "  Waiting... ($ELAPSED/${MAX_WAIT}s) — $WAIT_MSG"
  sleep 10
  ELAPSED=$((ELAPSED + 10))
done

ALL_HEALTHY=true
for svc in $HEALTHCHECK_SVCS; do
  status=$(docker inspect --format '{{.State.Health.Status}}' "openpalm-${svc}-1" 2>/dev/null || echo "missing")
  if [ "$status" = "healthy" ]; then
    pass "$svc is healthy"
  else
    fail "$svc status: $status"
    ALL_HEALTHY=false
  fi
done

# Caddy doesn't have a healthcheck — check if running
caddy_status=$(docker inspect --format '{{.State.Status}}' "openpalm-caddy-1" 2>/dev/null || echo "missing")
if [ "$caddy_status" = "running" ]; then
  pass "caddy is running"
else
  fail "caddy status: $caddy_status"
  ALL_HEALTHY=false
fi

# ── Step 9: Check for root-owned files ───────────────────────────────
echo ""
echo "=== Step 9: Root-owned file check ==="
root_files=$(find .dev -not -user "$(whoami)" 2>/dev/null || true)
if [ -z "$root_files" ]; then
  pass "No root-owned files in .dev/"
else
  fail "Root-owned files found:"
  echo "$root_files" | while read -r f; do echo "    $f"; done
fi

# ── Step 10: Verify secrets.env ──────────────────────────────────────
echo ""
echo "=== Step 10: Verify secrets.env ==="
secrets=".dev/config/secrets.env"

check_env_val() {
  local key="$1" expected="$2"
  local actual
  actual=$(grep "^${key}=" "$secrets" 2>/dev/null | head -1 | cut -d= -f2-)
  if [ "$actual" = "$expected" ]; then
    pass "$key=$expected"
  else
    fail "$key expected '$expected', got '$actual'"
  fi
}

check_env_val "ADMIN_TOKEN" "dev-admin-token"
check_env_val "MEMORY_USER_ID" "node"
check_env_val "SYSTEM_LLM_PROVIDER" "ollama"
check_env_val "SYSTEM_LLM_MODEL" "qwen2.5-coder:3b"
check_env_val "SYSTEM_LLM_BASE_URL" "http://host.docker.internal:11434"

# ── Step 11: Verify assistant env ────────────────────────────────────
echo ""
echo "=== Step 11: Verify assistant container env ==="

check_container_env() {
  local var="$1" expected="$2"
  local actual
  actual=$(docker exec openpalm-assistant-1 printenv "$var" 2>/dev/null || echo "")
  if [ "$actual" = "$expected" ]; then
    pass "assistant $var=$expected"
  else
    fail "assistant $var expected '$expected', got '$actual'"
  fi
}

check_container_env "OPENPALM_ADMIN_TOKEN" "dev-admin-token"
check_container_env "MEMORY_USER_ID" "node"

# OPENAI_BASE_URL should end with /v1
BASE_URL=$(docker exec openpalm-assistant-1 printenv OPENAI_BASE_URL 2>/dev/null || echo "")
if echo "$BASE_URL" | grep -q "/v1$"; then
  pass "assistant OPENAI_BASE_URL ends with /v1: $BASE_URL"
else
  fail "assistant OPENAI_BASE_URL should end with /v1, got: $BASE_URL"
fi

# ── Step 12: Verify Memory user provisioned ──────────────────────
echo ""
echo "=== Step 12: Verify Memory user provisioned ==="

# Check memory API is responding (curl from host since memory port is published)
OM_STATUS="error"
for attempt in 1 2 3 4 5 6; do
  OM_STATUS=$(curl -sf -o /dev/null -w '%{http_code}' \
    -X POST http://localhost:8765/api/v1/memories/filter \
    -H 'content-type: application/json' \
    -d '{"user_id": "node"}' 2>/dev/null || echo "error")
  if [ "$OM_STATUS" = "200" ]; then
    break
  fi
  echo "  Attempt $attempt: HTTP $OM_STATUS, retrying in 10s..."
  sleep 10
done

if [ "$OM_STATUS" = "200" ]; then
  pass "Memory user 'node' is reachable"
else
  fail "Memory not responding for user 'node' (HTTP $OM_STATUS)"
fi

# ── Step 13: Verify setup marked complete ────────────────────────────
echo ""
echo "=== Step 13: Verify setup complete ==="
FINAL_STATUS=$(curl -s http://localhost:8100/admin/setup -H "x-admin-token: dev-admin-token" | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['setupComplete'])" 2>/dev/null || echo "unknown")

if [ "$FINAL_STATUS" = "True" ]; then
  pass "Setup is marked complete"
else
  fail "Setup is NOT marked complete: $FINAL_STATUS"
fi

# ── Step 14: Verify assistant can record and recall a memory ─────────
echo ""
echo "=== Step 14: Verify assistant memory tools ==="

# Use the actual assistant (opencode run) to add a memory via the memory-add tool
echo "  Sending memory-add request to assistant..."
ADD_OUTPUT=$(docker exec openpalm-assistant-1 timeout 120 opencode run \
  "Use your memory-add tool to remember this fact: My favorite color is blue and I live in Austin Texas." \
  --format json 2>&1)

# Check if the memory-add tool was called and succeeded
ADD_TOOL_RESULT=$(echo "$ADD_OUTPUT" | grep '"tool":"memory-add"' | head -1)
if echo "$ADD_TOOL_RESULT" | grep -q '"status":"completed"'; then
  ADD_TOOL_OUTPUT=$(echo "$ADD_TOOL_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['part']['state']['output'])" 2>/dev/null || echo "")
  if echo "$ADD_TOOL_OUTPUT" | grep -qi "error"; then
    fail "memory-add tool returned error: $ADD_TOOL_OUTPUT"
  else
    pass "Assistant used memory-add tool successfully"
  fi
else
  fail "Assistant did not use memory-add tool. Output: $(echo "$ADD_OUTPUT" | tail -3)"
fi

# Wait for memory to be indexed
sleep 5

# Use the assistant to search memories via memory-search tool
echo "  Sending memory-search request to assistant..."
SEARCH_OUTPUT=$(docker exec openpalm-assistant-1 timeout 120 opencode run \
  "Use your memory-search tool to search for what you know about my favorite color." \
  --format json 2>&1)

# Check if memory-search found the memory
SEARCH_TOOL_RESULT=$(echo "$SEARCH_OUTPUT" | grep '"tool":"memory-search"' | head -1)
if echo "$SEARCH_TOOL_RESULT" | grep -q '"status":"completed"'; then
  SEARCH_TOOL_OUTPUT=$(echo "$SEARCH_TOOL_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['part']['state']['output'])" 2>/dev/null || echo "")
  if echo "$SEARCH_TOOL_OUTPUT" | grep -qi "blue"; then
    pass "Assistant recalled memory (found 'blue' in search results)"
  elif echo "$SEARCH_TOOL_OUTPUT" | grep -qi "error"; then
    fail "memory-search tool returned error: $SEARCH_TOOL_OUTPUT"
  else
    fail "memory-search did not find the stored memory. Output: $SEARCH_TOOL_OUTPUT"
  fi
else
  fail "Assistant did not use memory-search tool. Output: $(echo "$SEARCH_OUTPUT" | tail -3)"
fi

# ── Step 15: Verify memory OPENAI_BASE_URL env ───────────────────
echo ""
echo "=== Step 15: Verify memory container env ==="
OM_BASE_URL=$(docker exec openpalm-memory-1 printenv OPENAI_BASE_URL 2>/dev/null || echo "")
if [ -n "$OM_BASE_URL" ]; then
  pass "memory OPENAI_BASE_URL=$OM_BASE_URL"
else
  fail "memory OPENAI_BASE_URL is empty"
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "=========================================="
echo "  RESULTS: $PASS passed, $FAIL failed (${TESTS} total)"
echo "=========================================="

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "  FAILED — $FAIL test(s) did not pass"
  exit 1
else
  echo ""
  echo "  ALL TESTS PASSED"
  exit 0
fi
