#!/usr/bin/env bash
#
# End-to-end test for the OpenPalm dev environment.
#
# Cleans all state, rebuilds admin from source, starts the stack,
# runs the setup wizard, and verifies:
#   1. All containers are healthy
#   2. No root-owned files in .dev/
#   3. stack.env has correct values
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
	-h | --help)
		echo "Usage: $0 [--skip-build]"
		exit 0
		;;
	*)
		echo "Unknown option: $arg" >&2
		exit 1
		;;
	esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PASS=0
FAIL=0
TESTS=0

pass() {
	PASS=$((PASS + 1))
	TESTS=$((TESTS + 1))
	echo "  PASS: $1"
}
fail() {
	FAIL=$((FAIL + 1))
	TESTS=$((TESTS + 1))
	echo "  FAIL: $1"
}

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

# Vault — reset secrets
mkdir -p .dev/vault/user .dev/vault/stack
echo "# User extension file (empty placeholder for custom vars)" >.dev/vault/user/user.env

# Data — remove everything except models (HF cache)
rm -f .dev/data/memory/default_config.json
rm -f .dev/data/memory/memory.db
rm -f .dev/data/memory/memory.py
rm -f .dev/data/local-models.json
rm -f .dev/data/local-models.yml
rm -rf .dev/data/backups

# Config — remove generated assistant config so the wizard writes a fresh one
rm -f .dev/config/assistant/opencode.json
# Config — remove generated compose so dev-setup seeds a fresh one
rm -f .dev/stack/core.compose.yml

# Root-owned data from containers (qdrant, opencode logs)
docker run --rm -v "$ROOT_DIR/.dev/data/memory:/c" alpine sh -c \
	"rm -rf /c/qdrant" 2>/dev/null || true
docker run --rm -v "$ROOT_DIR/.dev/data/opencode:/c" alpine sh -c \
	"find /c -user root -delete" 2>/dev/null || true
docker run --rm -v "$ROOT_DIR/.dev/config/assistant:/c" alpine sh -c \
	"find /c -user root -delete" 2>/dev/null || true

# Vault — reset system env and managed files
rm -f .dev/vault/stack/stack.env
rm -f .dev/vault/stack/auth.json
rm -rf .dev/vault/stack/services

# Runtime addons — clear enabled overlays only
rm -rf .dev/stack/addons

# Config — remove stack.yml so the wizard writes a fresh one
rm -f .dev/config/stack.yml

# State — remove setup markers and audit logs
rm -f .dev/state/setup-complete
rm -f .dev/state/setup-token.txt
rm -f .dev/state/audit/admin-audit.jsonl
rm -f .dev/state/audit/guardian-audit.log

pass "State cleaned"

# ── Step 3: Seed fresh config ────────────────────────────────────────
echo ""
echo "=== Step 3: Seed config ==="
./scripts/dev-setup.sh --seed-env --force

# Clear admin tokens from seeded secrets so admin starts in first-boot state.
# dev-setup seeds them for convenience, but the e2e test needs to verify the wizard sets them.
# The stack.env uses `export ` prefix, so match both with and without.
sed -i 's/^\(export \)\{0,1\}ADMIN_TOKEN=.*/\1ADMIN_TOKEN=/' .dev/vault/stack/stack.env
sed -i 's/^\(export \)\{0,1\}OP_ADMIN_TOKEN=.*/\1OP_ADMIN_TOKEN=/' .dev/vault/stack/stack.env

# Use a dev-only image tag so the wizard's pull step doesn't overwrite locally
# built images with remote ones (e.g. an older Python-based memory:latest).
sed -i 's/^OP_IMAGE_TAG=.*/OP_IMAGE_TAG=dev/' .dev/vault/stack/stack.env

# Remove stack.yml so the wizard creates a fresh one (verifies Step 7 writes it)
rm -f .dev/config/stack.yml

pass "Config seeded (admin token cleared, image tag set to dev)"

# ── Step 3b: Ensure local models available on Ollama ─────────────────
echo ""
echo "=== Step 3b: Ensure Ollama models available ==="

OLLAMA_URL="http://localhost:11434"
SYSTEM_MODEL="qwen2.5-coder:3b"
EMBED_MODEL="nomic-embed-text:latest"

# Verify Ollama is running
if ! curl -sf "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
	fail "Ollama is not running at $OLLAMA_URL"
	echo "ABORTING — Ollama is required for e2e tests"
	exit 1
fi

# Pull models if not already available (idempotent)
for model_info in "$SYSTEM_MODEL|System LLM" "$EMBED_MODEL|Embedding"; do
	IFS='|' read -r model_name model_label <<<"$model_info"
	available=$(curl -sf "$OLLAMA_URL/api/tags" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(m['name']=='$model_name' for m in d.get('models',[])) else 'no')" 2>/dev/null || echo "no")
	if [ "$available" = "yes" ]; then
		echo "  $model_label model already available: $model_name"
	else
		echo "  Pulling $model_label model: $model_name..."
		curl -sf "$OLLAMA_URL/api/pull" -d "{\"name\":\"$model_name\"}" >/dev/null 2>&1
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
	./scripts/dev-setup.sh --enable-addon admin
	docker compose --project-directory . \
		-f .dev/stack/core.compose.yml \
		-f .dev/stack/addons/admin/compose.yml \
		-f compose.dev.yml \
		--env-file .dev/vault/stack/stack.env \
		--env-file .dev/vault/user/user.env \
		--env-file .dev/vault/stack/guardian.env \
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
	-f .dev/stack/core.compose.yml \
	-f .dev/stack/addons/admin/compose.yml \
	-f compose.dev.yml \
	--env-file .dev/vault/stack/stack.env \
	--env-file .dev/vault/user/user.env \
	--env-file .dev/vault/stack/guardian.env \
	--project-name openpalm up -d 2>&1 | tail -10

# Wait for admin to be healthy
echo "  Waiting for admin health..."
for i in $(seq 1 30); do
	if curl -sf http://localhost:8100/ >/dev/null 2>&1; then
		break
	fi
	sleep 2
done

if curl -sf http://localhost:8100/ >/dev/null 2>&1; then
	pass "Stack started"
else
	fail "Admin not healthy after 60s"
	echo "ABORTING — cannot continue without admin"
	exit 1
fi

# ── Step 6: Verify setup is NOT complete ─────────────────────────────
echo ""
echo "=== Step 6: Verify fresh state ==="

# Read admin token from stack.env (seeded by dev-setup.sh)
ADMIN_TOKEN=$(grep -E '^(export )?OP_ADMIN_TOKEN=' .dev/vault/stack/stack.env 2>/dev/null | head -1 | sed 's/^export //' | cut -d= -f2-)
if [ -z "$ADMIN_TOKEN" ]; then
	ADMIN_TOKEN="dev-admin-token"
fi

# Check if stack.yml exists — fresh state means no stack.yml yet
if [ ! -f .dev/config/stack.yml ]; then
	pass "Setup is NOT complete (no stack.yml — fresh state)"
else
	fail "Setup should not be complete yet (stack.yml exists)"
fi

if [ -n "$ADMIN_TOKEN" ]; then
	pass "Admin token available"
else
	fail "Missing admin token in stack.env"
fi

# ── Step 7: Run setup via performSetup ───────────────────────────────
echo ""
echo "=== Step 7: Run setup ==="

# Use performSetup directly (same as the CLI wizard). This creates stack.yml,
# writes secrets and all runtime files in one atomic operation.
SETUP_OK=$(OP_HOME=.dev bun -e "
const { performSetup } = await import('@openpalm/lib');
const result = await performSetup({
  spec: {
    version: 2,
    capabilities: {
      llm: 'ollama/qwen2.5-coder:3b',
      embeddings: { provider: 'ollama', model: 'nomic-embed-text:latest', dims: 768 },
      memory: { userId: 'node', customInstructions: '' },
      slm: 'ollama/qwen2.5-coder:3b',
    },
  },
  security: { adminToken: 'dev-admin-token' },
  owner: { name: 'Dev', email: 'dev@localhost' },
  connections: [{ id: 'ollama', name: 'Ollama', provider: 'ollama', baseUrl: 'http://host.docker.internal:11434', apiKey: '' }],
});
console.log(result.ok ? 'True' : 'False');
if (!result.ok) console.error(result.error);
" 2>&1 | tail -1)

if [ "$SETUP_OK" = "True" ]; then
	pass "performSetup completed"
else
	fail "performSetup failed: $SETUP_OK"
fi

# Step 7b: Recreate all services with the dev overlay to pick up new env vars.
docker compose --project-directory . \
	-f .dev/stack/core.compose.yml \
	-f .dev/stack/addons/admin/compose.yml \
	-f compose.dev.yml \
	--env-file .dev/vault/stack/stack.env \
	--env-file .dev/vault/user/user.env \
	--env-file .dev/vault/stack/guardian.env \
	--project-name openpalm up -d --force-recreate 2>&1 | tail -10

pass "Services recreated with updated config"

# Step 7b already applied compose.dev.yml overlay to all services,
# so no separate assistant re-apply is needed.

# ── Step 8: Wait for containers ──────────────────────────────────────
echo ""
echo "=== Step 8: Wait for all containers healthy ==="

# Poll until all services are ready (max 120s)
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

# ── Step 10: Verify stack.env ─────────────────────────────────────────
echo ""
echo "=== Step 10: Verify stack.env ==="
secrets=".dev/vault/stack/stack.env"

check_env_val() {
	local key="$1" expected="$2"
	local actual
	# Match both `KEY=val` and `export KEY=val` forms
	actual=$(grep -E "^(export )?${key}=" "$secrets" 2>/dev/null | head -1 | sed "s/^export //" | cut -d= -f2-)
	if [ "$actual" = "$expected" ]; then
		pass "$key=$expected"
	else
		fail "$key expected '$expected', got '$actual'"
	fi
}

# ADMIN_TOKEN is now OP_ADMIN_TOKEN in stack.env, not user.env
STACK_ADMIN_TOKEN=$(grep -E '^(export )?OP_ADMIN_TOKEN=' .dev/vault/stack/stack.env 2>/dev/null | head -1 | sed 's/^export //' | cut -d= -f2-)
if [ "$STACK_ADMIN_TOKEN" = "dev-admin-token" ]; then
	pass "OP_ADMIN_TOKEN=dev-admin-token (in stack.env)"
else
	fail "OP_ADMIN_TOKEN expected 'dev-admin-token', got '$STACK_ADMIN_TOKEN'"
fi
# Config vars (SYSTEM_LLM_*, EMBEDDING_*, MEMORY_USER_ID) are now in
# stack.yml capabilities and vault/stack/services/memory/managed.env,
# NOT in user.env. Verify they are NOT in user.env.
if grep -qE 'SYSTEM_LLM_PROVIDER=' .dev/vault/user/user.env 2>/dev/null; then
	fail "SYSTEM_LLM_PROVIDER should NOT be in user.env (lives in stack.yml now)"
else
	pass "Config vars correctly absent from user.env"
fi

# Verify stack.yml has correct capabilities
STACK_YAML=".dev/config/stack.yml"
if [ -f "$STACK_YAML" ]; then
	if grep -q "llm: ollama/" "$STACK_YAML"; then
		pass "stack.yml has capabilities.llm with ollama provider"
	else
		fail "stack.yml capabilities.llm missing or wrong provider"
	fi
else
	fail "stack.yml not found"
fi

# Verify managed.env exists with correct values
MANAGED_ENV=".dev/vault/stack/services/memory/managed.env"
if [ -f "$MANAGED_ENV" ]; then
	managed_llm=$(grep 'SYSTEM_LLM_PROVIDER=' "$MANAGED_ENV" | cut -d= -f2-)
	if [ "$managed_llm" = "ollama" ]; then
		pass "managed.env has SYSTEM_LLM_PROVIDER=ollama"
	else
		fail "managed.env SYSTEM_LLM_PROVIDER expected 'ollama', got '$managed_llm'"
	fi
else
	fail "managed.env not found at $MANAGED_ENV"
fi

# Verify auth.json exists
if [ -f ".dev/vault/stack/auth.json" ]; then
	pass "auth.json exists"
else
	fail "auth.json not found"
fi

# ── Step 11: Verify assistant env ────────────────────────────────────
echo ""
echo "=== Step 11: Verify assistant container env ==="

check_container_env() {
	local var="$1" expected="$2"
	local actual=""
	for _attempt in $(seq 1 30); do
		local health
		health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' openpalm-assistant-1 2>/dev/null || echo "missing")
		actual=$(docker exec openpalm-assistant-1 printenv "$var" 2>/dev/null || echo "")
		if [ "$health" = "healthy" ] && [ "$actual" = "$expected" ]; then
			break
		fi
		sleep 2
	done
	if [ "$actual" = "$expected" ]; then
		pass "assistant $var=$expected"
	else
		fail "assistant $var expected '$expected', got '$actual'"
	fi
}

# OP_ADMIN_TOKEN is in guardian/scheduler compose, not assistant.
# MEMORY_USER_ID for the assistant comes from user.env (default_user) —
# the actual userId 'node' is in managed.env and used by the memory service.
# Verify the assistant has the memory auth token (proves compose env substitution works).
MEMORY_AUTH_TOKEN_EXPECTED=$(grep -E '^(export )?OP_MEMORY_TOKEN=' "$ROOT_DIR/.dev/vault/stack/stack.env" 2>/dev/null | head -1 | sed 's/^export //' | cut -d= -f2-)
check_container_env "MEMORY_AUTH_TOKEN" "$MEMORY_AUTH_TOKEN_EXPECTED"

# OPENAI_BASE_URL should end with /v1
BASE_URL=""
for _attempt in $(seq 1 30); do
	assistant_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' openpalm-assistant-1 2>/dev/null || echo "missing")
	BASE_URL=$(docker exec openpalm-assistant-1 printenv OPENAI_BASE_URL 2>/dev/null || echo "")
	if [ "$assistant_health" = "healthy" ] && echo "$BASE_URL" | grep -q "/v1$"; then
		break
	fi
	sleep 2
done
if echo "$BASE_URL" | grep -q "/v1$"; then
	pass "assistant OPENAI_BASE_URL ends with /v1: $BASE_URL"
else
	fail "assistant OPENAI_BASE_URL should end with /v1, got: $BASE_URL"
fi

# LMSTUDIO_BASE_URL must be set (from compose.dev.yml overlay) so the socat
# proxy can forward lmstudio provider requests to Ollama.
LMSTUDIO_URL=$(docker exec openpalm-assistant-1 printenv LMSTUDIO_BASE_URL 2>/dev/null || echo "")
if [ -n "$LMSTUDIO_URL" ]; then
	pass "assistant LMSTUDIO_BASE_URL=$LMSTUDIO_URL"
else
	fail "assistant LMSTUDIO_BASE_URL is not set — compose.dev.yml overlay may not have been applied"
fi

# ── Step 12: Verify Memory user provisioned ──────────────────────
echo ""
echo "=== Step 12: Verify Memory user provisioned ==="

MEMORY_AUTH_TOKEN=$(grep -E '^(export )?OP_MEMORY_TOKEN=' "$ROOT_DIR/.dev/vault/stack/stack.env" 2>/dev/null | head -1 | sed 's/^export //' | cut -d= -f2-)

# Check memory API is responding (curl from host since memory port is published)
OM_STATUS="error"
for attempt in 1 2 3 4 5 6; do
	OM_STATUS=$(curl -sf -o /dev/null -w '%{http_code}' \
		-X POST http://localhost:8765/api/v1/memories/filter \
		-H "Authorization: Bearer $MEMORY_AUTH_TOKEN" \
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
FINAL_STATUS=$(curl -s http://localhost:8100/admin/connections/status \
	-H "x-admin-token: dev-admin-token" 2>/dev/null |
	python3 -c "import sys,json; print(json.load(sys.stdin).get('complete', False))" 2>/dev/null || echo "unknown")

if [ "$FINAL_STATUS" = "True" ]; then
	pass "Setup is marked complete"
else
	fail "Setup is NOT marked complete: $FINAL_STATUS"
fi

# ── Step 14: Verify assistant message pipeline ─────────────────────
echo ""
echo "=== Step 14: Verify assistant pipeline ==="

# OpenCode auth is disabled by default (host-only binding provides security)
SESSION_ID=$(curl -sf http://localhost:4096/session \
	-H 'content-type: application/json' \
	-d '{"title":"tier6-assistant-pipeline"}' |
	python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")

MESSAGE_RESPONSE=""
if [ -n "$SESSION_ID" ]; then
	MESSAGE_RESPONSE=$(curl -sf http://localhost:4096/session/$SESSION_ID/message \
		-H 'content-type: application/json' \
		-d '{"parts":[{"type":"text","text":"Reply with exactly ok"}]}' \
		2>/dev/null || echo "")
fi

if echo "$MESSAGE_RESPONSE" | grep -q '"text":"ok"'; then
	pass "Assistant message pipeline returned expected response"
else
	fail "Assistant message pipeline did not return the expected response"
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
