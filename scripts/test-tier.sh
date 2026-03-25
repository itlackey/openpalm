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
#   5 — Integration E2E (needs running stack — rebuilds containers)
#   6 — Full stack E2E incl. LLM pipeline (needs stack + Ollama — no-skip enforced)
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
  5  Integration E2E (rebuilds and starts stack)
  6  Full stack E2E incl. LLM pipeline (rebuilds stack, enforces no skips)
EOF
	exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ── Helpers ─────────────────────────────────────────────────────────────

dev_compose() {
	docker compose --project-directory . \
		-f .dev/stack/core.compose.yml \
		-f .dev/stack/addons/admin/compose.yml \
		-f compose.dev.yml \
		--env-file .dev/vault/stack/stack.env \
		--env-file .dev/vault/stack/services/memory/managed.env \
		--env-file .dev/vault/user/user.env \
		--env-file .dev/vault/stack/guardian.env \
		--project-name openpalm "$@"
}

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

rebuild_stack() {
	# Always rebuild and recreate containers from source to ensure
	# compose config changes (env_file paths, mounts, env vars) are
	# picked up. Docker restart does NOT re-read compose config.
	ensure_dev_setup

	echo "Building admin..."
	bun run admin:build
	./scripts/dev-setup.sh --enable-addon admin

	echo "Stopping previous stack containers..."
	dev_compose down --remove-orphans 2>/dev/null || true

	echo "Rebuilding and recreating stack from source..."
	dev_compose up --build --force-recreate -d

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
			# Wait for admin OpenCode subprocess to start (health check only
			# verifies the admin HTTP server, not its internal OpenCode process)
			echo "Waiting for admin OpenCode subprocess..."
			for j in $(seq 1 12); do
				if curl -sS -o /dev/null -w '' http://localhost:3881/ 2>/dev/null; then
					echo "Admin OpenCode ready."
					return 0
				fi
				sleep 5
			done
			echo "WARNING: Admin OpenCode not reachable on :3881 after 60s (tests may fail)"
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
	rebuild_stack
	load_memory_token
	bun run admin:test:stack
	;;
6)
	echo "=== Tier 6: Full stack E2E incl. LLM pipeline ==="
	rebuild_stack
	load_memory_token
	bun run admin:test:llm
	;;
*)
	echo "Unknown tier: $TIER (valid: 1-6)" >&2
	exit 1
	;;
esac
