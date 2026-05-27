#!/usr/bin/env bash
#
# End-to-end test for the OpenPalm dev environment (v0.11.0).
#
# v0.11.0 architecture:
#   - UI is a HOST PROCESS (`openpalm`), not a container
#   - Compose stack: assistant + guardian containers only
#   - Directory layout: config/stack/, stash/vaults/, state/, cache/
#
# Cleans state, rebuilds all images from source, starts the stack and
# admin process, then verifies:
#   1. All containers are healthy (assistant + guardian)
#   2. UI host process responds on the configured port
#   3. Setup wizard route serves
#   4. Admin API auth works (correct + wrong tokens)
#   5. Admin health endpoint responds correctly
#
# Isolation:
#   - COMPOSE_PROJECT_NAME (default: openpalm-e2e) — never touches user stack
#   - OP_E2E_HOME (default: .dev-e2e) — never touches user .dev/
#   - OP_E2E_UI_PORT (default: 3890) — avoids :3880 if user has admin up
#
# Usage:
#   ./scripts/dev-e2e-test.sh [--skip-build] [--keep] [--playwright]
#
# Options:
#   --skip-build   Reuse existing images instead of rebuilding
#   --keep         Leave the stack/admin running after tests for inspection
#   --playwright   Also run Playwright browser tests (*.stack.ts) against the isolated stack
#
set -euo pipefail

SKIP_BUILD=0
KEEP=0
RUN_PLAYWRIGHT=0
for arg in "$@"; do
	case "$arg" in
	--skip-build) SKIP_BUILD=1 ;;
	--keep) KEEP=1 ;;
	--playwright) RUN_PLAYWRIGHT=1 ;;
	-h | --help)
		echo "Usage: $0 [--skip-build] [--keep] [--playwright]"
		echo "  --playwright  Run Playwright stack tests against the isolated stack after curl checks"
		exit 0
		;;
	*) echo "Unknown option: $arg" >&2; exit 1 ;;
	esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ── Isolation knobs ──────────────────────────────────────────────────
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-openpalm-e2e}"
OP_E2E_HOME="${OP_E2E_HOME:-${ROOT_DIR}/.dev-e2e}"
OP_E2E_UI_PORT="${OP_E2E_UI_PORT:-3890}"
UI_URL="http://127.0.0.1:${OP_E2E_UI_PORT}"

PASS=0
FAIL=0
UI_PID=""

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

# ── Compose helper bound to OP_E2E_HOME ──────────────────────────────
dev_compose() {
	docker compose --project-directory . \
		-f "${OP_E2E_HOME}/config/stack/core.compose.yml" \
		-f compose.dev.yml \
		--env-file "${OP_E2E_HOME}/config/stack/stack.env" \
		--env-file "${OP_E2E_HOME}/config/stack/guardian.env" \
		--project-name "$COMPOSE_PROJECT_NAME" "$@"
}

# ── Cleanup on exit ──────────────────────────────────────────────────
cleanup() {
	echo ""
	if [[ -n "$UI_PID" ]] && kill -0 "$UI_PID" 2>/dev/null; then
		echo "Stopping UI host process (PID $UI_PID)..."
		kill "$UI_PID" 2>/dev/null || true
		wait "$UI_PID" 2>/dev/null || true
	fi
	if [[ $KEEP -eq 0 ]]; then
		echo "Cleaning up containers and ${OP_E2E_HOME}..."
		dev_compose down --remove-orphans --volumes 2>/dev/null || true
		# Clean root-owned files from container volumes before rm -rf
		docker run --rm -v "${OP_E2E_HOME}:/cleanup" alpine rm -rf /cleanup 2>/dev/null || true
		rm -rf "${OP_E2E_HOME}" 2>/dev/null || true
	else
		echo "Keeping stack running (--keep). Clean up manually:"
		echo "  docker compose --project-name ${COMPOSE_PROJECT_NAME} down"
		echo "  rm -rf ${OP_E2E_HOME}"
	fi
}
trap cleanup EXIT

# ── Step 1: Clean previous test state ────────────────────────────────
echo "=== Step 1: Clean isolated test state ==="
dev_compose down --remove-orphans --volumes 2>/dev/null || true
docker run --rm -v "${OP_E2E_HOME}:/cleanup" alpine rm -rf /cleanup 2>/dev/null || true
rm -rf "$OP_E2E_HOME" 2>/dev/null || true
pass "Previous test state cleaned"

# ── Step 2: Seed isolated OP_E2E_HOME ────────────────────────────────
echo ""
echo "=== Step 2: Seed isolated OP_HOME at $OP_E2E_HOME ==="
# Use dev-setup.sh but redirect DEV_ROOT to our isolated dir
# dev-setup.sh hardcodes .dev, so we cp the skeleton manually instead
mkdir -p "${OP_E2E_HOME}"
cp -r .openpalm/. "${OP_E2E_HOME}/"

# Seed stack.env with isolated values
mkdir -p "${OP_E2E_HOME}/config/stack"
docker_sock="/var/run/docker.sock"
cat > "${OP_E2E_HOME}/config/stack/stack.env" <<EOF
OP_HOME=${OP_E2E_HOME}
OP_UID=$(id -u)
OP_GID=$(id -g)
OP_DOCKER_SOCK=${docker_sock}
OP_IMAGE_NAMESPACE=openpalm
OP_IMAGE_TAG=dev
OP_UI_LOGIN_PASSWORD=e2e-test-password-$(date +%s)
OP_ASSISTANT_PORT=${OP_E2E_ASSISTANT_PORT:-3891}
# Guardian has no host port mapping (network-only). Channels reach it via
# http://guardian:8080 over the channel_lan Docker network.
# Note: OP_VOICE_PORT is unused; voice compose binds via OP_VOICE_PORT_HOST.
OP_VOICE_PORT_HOST=${OP_E2E_VOICE_PORT:-8187}
OP_HOST_UI_PORT=${OP_E2E_UI_PORT}
OP_ADMIN_PORT=${OP_E2E_UI_PORT}
OP_SETUP_COMPLETE=true
EOF
chmod 600 "${OP_E2E_HOME}/config/stack/stack.env"

touch "${OP_E2E_HOME}/config/stack/guardian.env"
chmod 600 "${OP_E2E_HOME}/config/stack/guardian.env"

# Empty user.env (akm vault:user is the source of truth at runtime)
mkdir -p "${OP_E2E_HOME}/stash/vaults"
touch "${OP_E2E_HOME}/stash/vaults/user.env"
chmod 600 "${OP_E2E_HOME}/stash/vaults/user.env"

pass "Isolated OP_HOME seeded from .openpalm/"

# ── Step 3: Build UI ─────────────────────────────────────────────────
if [[ $SKIP_BUILD -eq 0 ]]; then
	echo ""
	echo "=== Step 3: Build UI ==="
	bun run ui:build 2>&1 | tail -3
	pass "UI built"
else
	if [[ ! -f packages/ui/build/index.js ]]; then
		fail "UI build missing (need to rebuild — drop --skip-build)"
		exit 1
	fi
	echo "=== Step 3: Skipping UI build (--skip-build) ==="
fi

# ── Step 4: Build container images ──────────────────────────────────
# v0.11.0: openpalm-base was inlined into the assistant Dockerfile, so a
# single `compose build` is sufficient — no separate base-image step.
if [[ $SKIP_BUILD -eq 0 ]]; then
	echo ""
	echo "=== Step 4: Build container images ==="
	dev_compose build 2>&1 | tail -5
	pass "Container images built"
else
	echo "=== Step 4: Skipping container build (--skip-build) ==="
fi

# ── Step 5: Start stack ──────────────────────────────────────────────
echo ""
echo "=== Step 5: Start stack ==="
BUILDX_BUILDER=default dev_compose up -d 2>&1 | tail -10

echo "  Waiting for services to be healthy (up to 60s)..."
for i in $(seq 1 30); do
	all_healthy=true
	for svc in assistant guardian; do
		status=$(docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-${svc}-1" 2>/dev/null || echo "missing")
		if [[ "$status" != "healthy" ]]; then
			all_healthy=false
			break
		fi
	done
	if [[ "$all_healthy" == "true" ]]; then
		break
	fi
	sleep 2
done

for svc in assistant guardian; do
	status=$(docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-${svc}-1" 2>/dev/null || echo "missing")
	if [[ "$status" == "healthy" ]]; then
		pass "${svc} container healthy"
	else
		fail "${svc} container status: $status"
		dev_compose logs "$svc" --tail 30 2>&1 | sed 's/^/    /' | tail -30
	fi
done

# ── Step 6: Start UI host process ─────────────────────────────────
echo ""
echo "=== Step 6: Start UI host process on port $OP_E2E_UI_PORT ==="
OP_HOME="$OP_E2E_HOME" \
OP_HOST_UI_PORT="$OP_E2E_UI_PORT" \
bun run packages/cli/src/main.ts --no-open > "${OP_E2E_HOME}/ui.log" 2>&1 &
UI_PID=$!
echo "  UI host PID: $UI_PID"

echo "  Waiting for UI to listen..."
for i in $(seq 1 30); do
	if curl -sf "${UI_URL}/health" >/dev/null 2>&1; then
		break
	fi
	sleep 1
done

if curl -sf "${UI_URL}/health" >/dev/null 2>&1; then
	pass "UI host process listening at $UI_URL"
else
	fail "UI host process not responding"
	cat "${OP_E2E_HOME}/ui.log" | tail -30 | sed 's/^/    /'
	exit 1
fi

# ── Step 7: Verify UI endpoints ───────────────────────────────────
echo ""
echo "=== Step 7: Verify UI endpoints ==="
UI_TOKEN=$(grep '^OP_UI_LOGIN_PASSWORD=' "${OP_E2E_HOME}/config/stack/stack.env" | cut -d= -f2-)

# /health
status=$(curl -s -o /dev/null -w "%{http_code}" "${UI_URL}/health")
[[ "$status" == "200" ]] && pass "/health → 200" || fail "/health returned $status"

# / (redirect to setup OR home)
status=$(curl -s -o /dev/null -w "%{http_code}" "${UI_URL}/")
[[ "$status" == "200" || "$status" == "302" ]] && pass "/ → $status" || fail "/ returned $status"

# /setup wizard
status=$(curl -s -o /dev/null -w "%{http_code}" "${UI_URL}/setup")
[[ "$status" == "200" ]] && pass "/setup wizard → 200" || fail "/setup returned $status"

# /admin/containers/list with correct token
status=$(curl -s -o /dev/null -w "%{http_code}" -H "x-admin-token: $UI_TOKEN" "${UI_URL}/admin/containers/list")
[[ "$status" == "200" ]] && pass "/admin/containers/list (auth) → 200" || fail "/admin/containers/list (auth) returned $status"

# /admin/containers/list without token (must 401)
status=$(curl -s -o /dev/null -w "%{http_code}" "${UI_URL}/admin/containers/list")
[[ "$status" == "401" ]] && pass "/admin/containers/list (no auth) → 401" || fail "/admin/containers/list (no auth) returned $status"

# /admin/health verifies admin is responding and assistant is reachable
health=$(curl -sf -H "x-admin-token: $UI_TOKEN" "${UI_URL}/admin/health" 2>/dev/null || echo "")
if echo "$health" | grep -q '"ok":true'; then
	pass "/admin/health responds with ok:true"
else
	fail "/admin/health did not return ok:true (got: $(echo "$health" | head -c 200))"
fi

# ── Step 8: Verify container ↔ admin pipeline ────────────────────────
echo ""
echo "=== Step 8: Verify container API surface ==="
# Containers report status through /admin/containers/list
list=$(curl -sf -H "x-admin-token: $UI_TOKEN" "${UI_URL}/admin/containers/list" 2>/dev/null || echo "")
if echo "$list" | grep -q '"assistant"' && echo "$list" | grep -q '"guardian"'; then
	pass "Admin reports both assistant and guardian containers"
else
	fail "Admin container list missing services: $list"
fi

# ── Step 9 (optional): Playwright browser tests ──────────────────────
if [[ $RUN_PLAYWRIGHT -eq 1 ]]; then
	echo ""
	echo "=== Step 9: Playwright stack tests ==="
	OP_E2E_ASSISTANT_PORT="${OP_E2E_ASSISTANT_PORT:-3891}"
	PW_EXIT=0
	STACK_ENV_PATH="${OP_E2E_HOME}/config/stack/stack.env" \
	OP_HOME="${OP_E2E_HOME}" \
	RUN_DOCKER_STACK_TESTS=1 \
	ADMIN_URL="${UI_URL}" \
	OP_UI_LOGIN_PASSWORD="${UI_TOKEN}" \
	ADMIN_TOKEN="${UI_TOKEN}" \
	ASSISTANT_URL="http://127.0.0.1:${OP_E2E_ASSISTANT_PORT}" \
	npm --prefix packages/ui run test:e2e || PW_EXIT=$?

	if [[ $PW_EXIT -eq 0 ]]; then
		pass "Playwright stack tests passed"
	else
		fail "Playwright stack tests failed (exit $PW_EXIT)"
	fi
fi

# ── Results ──────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  Tests: $((PASS + FAIL))   Pass: $PASS   Fail: $FAIL"
echo "============================================================"

if [[ $FAIL -gt 0 ]]; then
	exit 1
fi
exit 0
