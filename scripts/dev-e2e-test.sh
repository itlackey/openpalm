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

# Root-owned data from containers (qdrant, caddy, .mem0)
docker run --rm -v "$ROOT_DIR/.dev/data/memory:/c" alpine sh -c \
  "rm -rf /c/qdrant /c/.mem0" 2>/dev/null || true
docker run --rm -v "$ROOT_DIR/.dev/data/caddy:/c" alpine sh -c \
  "rm -rf /c/data /c/config" 2>/dev/null || true

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
pass "Config seeded"

# ── Step 3b: Ensure local models available ───────────────────────────
echo ""
echo "=== Step 3b: Ensure local models in Docker Model Runner ==="

MODELS_DIR="$ROOT_DIR/.dev/data/models"
mkdir -p "$MODELS_DIR"

# System LLM model
SYSTEM_GGUF="$MODELS_DIR/Qwen3.5-4B-Q4_K_M.gguf"
SYSTEM_MODEL_REF="huggingface.co/unsloth/qwen3.5-4b-gguf"
SYSTEM_GGUF_URL="https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf"

# Embedding model
EMBED_GGUF="$MODELS_DIR/bge-base-en-v1.5-q4_k_m.gguf"
EMBED_MODEL_REF="huggingface.co/compendiumlabs/bge-base-en-v1.5-gguf"
EMBED_GGUF_URL="https://huggingface.co/CompendiumLabs/bge-base-en-v1.5-gguf/resolve/main/bge-base-en-v1.5-q4_k_m.gguf"

# Download GGUF files if not present
for gguf_info in "$SYSTEM_GGUF|$SYSTEM_GGUF_URL|System LLM" "$EMBED_GGUF|$EMBED_GGUF_URL|Embedding"; do
  IFS='|' read -r gguf_file gguf_url gguf_label <<< "$gguf_info"
  if [ ! -f "$gguf_file" ]; then
    echo "  Downloading $gguf_label GGUF..."
    curl -L -o "$gguf_file" "$gguf_url" 2>&1 | tail -1
  else
    echo "  $gguf_label GGUF already present: $(basename "$gguf_file")"
  fi
done

# Package into Docker Model Runner (idempotent — overwrites if exists)
for pkg_info in "$SYSTEM_GGUF|$SYSTEM_MODEL_REF" "$EMBED_GGUF|$EMBED_MODEL_REF"; do
  IFS='|' read -r gguf_file model_ref <<< "$pkg_info"
  if [ -f "$gguf_file" ]; then
    echo "  Packaging $(basename "$gguf_file") as $model_ref..."
    docker model rm "$model_ref" 2>/dev/null || true
    docker model package --gguf "$gguf_file" "$model_ref" 2>&1 | tail -1
  else
    fail "GGUF file missing: $gguf_file"
  fi
done

# Verify models are available
AVAILABLE_MODELS=$(curl -sf http://localhost:12434/engines/v1/models 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(' '.join(m['id'] for m in d.get('data',[])))" 2>/dev/null || echo "")
if echo "$AVAILABLE_MODELS" | grep -q "qwen3.5"; then
  pass "System model available in Model Runner"
else
  fail "System model not found in Model Runner. Available: $AVAILABLE_MODELS"
fi
if echo "$AVAILABLE_MODELS" | grep -q "bge-base"; then
  pass "Embedding model available in Model Runner"
else
  fail "Embedding model not found in Model Runner. Available: $AVAILABLE_MODELS"
fi

# ── Step 4: Build admin ─────────────────────────────────────────────
if [ "$SKIP_BUILD" -eq 0 ]; then
  echo ""
  echo "=== Step 4: Build admin ==="
  npm run admin:build 2>&1 | tail -3
  docker compose --project-directory . \
    -f .dev/state/artifacts/docker-compose.yml \
    -f compose.dev.yaml \
    --env-file .dev/state/artifacts/stack.env \
    --env-file .dev/state/artifacts/secrets.env \
    --project-name openpalm build admin 2>&1 | tail -3
  pass "Admin built"
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
    \"llmProvider\": \"model-runner\",
    \"llmBaseUrl\": \"http://host.docker.internal:12434/engines\",
    \"systemModel\": \"huggingface.co/unsloth/qwen3.5-4b-gguf\",
    \"embeddingModel\": \"hf.co/CompendiumLabs/bge-base-en-v1.5-gguf\",
    \"embeddingDims\": 768
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
echo "  Waiting 30s for containers to stabilize..."
sleep 30

ALL_HEALTHY=true
for svc in admin memory assistant guardian docker-socket-proxy; do
  status=$(docker inspect --format '{{.State.Health.Status}}' "openpalm-${svc}-1" 2>/dev/null || echo "missing")
  if [ "$status" = "healthy" ]; then
    pass "$svc is healthy"
  else
    fail "$svc status: $status"
    ALL_HEALTHY=false
  fi
done

# Caddy doesn't have a healthcheck — check if running
status=$(docker inspect --format '{{.State.Status}}' "openpalm-caddy-1" 2>/dev/null || echo "missing")
if [ "$status" = "running" ]; then
  pass "caddy is running"
else
  fail "caddy status: $status"
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
check_env_val "SYSTEM_LLM_PROVIDER" "model-runner"
check_env_val "SYSTEM_LLM_MODEL" "huggingface.co/unsloth/qwen3.5-4b-gguf"
check_env_val "SYSTEM_LLM_BASE_URL" "http://host.docker.internal:12434/engines"
check_env_val "OPENAI_BASE_URL" "http://host.docker.internal:12434/engines/v1"

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

# Use POST /api/v1/memories/filter (GET /memories/ has an upstream pagination bug)
OM_STATUS="error"
for attempt in 1 2 3 4 5 6; do
  OM_STATUS=$(docker exec openpalm-memory-1 python3 -c \
    "import requests; r=requests.post('http://localhost:8765/api/v1/memories/filter', json={'user_id': 'node'}); print(r.status_code)" 2>/dev/null || echo "error")
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
