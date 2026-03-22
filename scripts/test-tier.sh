#!/usr/bin/env bash
#
# Run a specific test tier (1–6) with proper setup.
#
# Usage:
#   ./scripts/test-tier.sh <tier>
#   bun run test:t1   # via package.json shortcut
#
# Tiers:
#   1 — Type check (svelte-check + SDK unit tests)
#   2 — Non-admin unit tests (lib, cli, guardian, channels, scheduler)
#   3 — Admin unit tests (vitest)
#   4 — Mocked browser E2E (Playwright, no stack needed)
#   5 — Integration E2E (needs running stack)
#   6 — Full stack E2E incl. LLM pipeline (needs stack + Ollama)
#
set -euo pipefail

TIER="${1:-}"

if [[ -z "$TIER" || "$TIER" == "-h" || "$TIER" == "--help" ]]; then
	cat <<'EOF'
Usage: ./scripts/test-tier.sh <tier>

Tiers:
  1  Type check (svelte-check + SDK unit tests)
  2  Non-admin unit tests (lib, cli, guardian, channels, scheduler)
  3  Admin unit tests (vitest)
  4  Mocked browser E2E (Playwright, no stack needed)
  5  Integration E2E (needs running stack)
  6  Full stack E2E incl. LLM pipeline (needs stack + Ollama)
EOF
	exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ── Helpers ─────────────────────────────────────────────────────────────

ensure_dev_setup() {
	if [[ ! -f .dev/vault/stack/stack.env ]]; then
		echo "Seeding dev environment..."
		./scripts/dev-setup.sh --seed-env
	fi
}

ensure_admin_build() {
	# Build admin if the build output is missing or older than source
	if [[ ! -d packages/admin/build ]]; then
		echo "Building admin..."
		bun run admin:build
	fi
}

load_memory_token() {
	MEMORY_AUTH_TOKEN=""
	if [[ -f .dev/vault/stack/stack.env ]]; then
		MEMORY_AUTH_TOKEN=$(grep -E '^OP_MEMORY_TOKEN=' .dev/vault/stack/stack.env | cut -d= -f2- || echo "")
	fi
	export MEMORY_AUTH_TOKEN
}

ensure_stack_running() {
	# Check if the stack is already running and healthy
	local admin_healthy
	admin_healthy=$(docker inspect --format '{{.State.Health.Status}}' openpalm-admin-1 2>/dev/null || echo "missing")
	if [[ "$admin_healthy" == "healthy" ]]; then
		return 0
	fi

	echo "Stack not running. Setting up and starting..."
	ensure_dev_setup

	# Build and start with admin addon overlay
	bun run admin:build
	docker compose --project-directory . \
		-f .openpalm/stack/core.compose.yml \
		-f .openpalm/stack/addons/admin/compose.yml \
		-f compose.dev.yaml \
		--env-file .dev/vault/stack/stack.env \
		--env-file .dev/vault/stack/services/memory/managed.env \
		--env-file .dev/vault/user/user.env \
		--project-name openpalm up --build -d

	# Wait for all services to be healthy
	echo "Waiting for all services to be healthy..."
	for i in $(seq 1 30); do
		local all_healthy=true
		for svc in admin memory assistant guardian; do
			local status
			status=$(docker inspect --format '{{.State.Health.Status}}' "openpalm-${svc}-1" 2>/dev/null || echo "missing")
			if [[ "$status" != "healthy" ]]; then
				all_healthy=false
				break
			fi
		done
		if [[ "$all_healthy" == "true" ]]; then
			echo "All services healthy."
			return 0
		fi
		sleep 10
	done
	echo "WARNING: Not all services are healthy after 5 minutes."
	return 1
}

# ── Tier execution ──────────────────────────────────────────────────────

case "$TIER" in
1)
	echo "=== Tier 1: Type check (svelte-check + SDK) ==="
	bun run check
	;;
2)
	echo "=== Tier 2: Non-admin unit tests ==="
	bun run test
	;;
3)
	echo "=== Tier 3: Admin unit tests ==="
	bun run admin:test:unit
	;;
4)
	echo "=== Tier 4: Mocked browser E2E ==="
	ensure_admin_build
	bun run admin:test:e2e:mocked
	;;
5)
	echo "=== Tier 5: Integration E2E (stack-dependent) ==="
	ensure_stack_running
	load_memory_token
	export RUN_DOCKER_STACK_TESTS=1
	export ADMIN_TOKEN=dev-admin-token
	bun run admin:test:e2e
	;;
6)
	echo "=== Tier 6: Full stack E2E incl. LLM pipeline ==="
	ensure_stack_running
	load_memory_token
	export RUN_DOCKER_STACK_TESTS=1
	export RUN_LLM_TESTS=1
	export ADMIN_TOKEN=dev-admin-token
	bun run admin:test:e2e
	;;
*)
	echo "Unknown tier: $TIER (valid: 1-6)" >&2
	exit 1
	;;
esac
