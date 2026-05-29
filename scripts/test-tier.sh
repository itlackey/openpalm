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
#   2 — Non-UI unit tests (lib, cli, guardian, channels, scheduler)
#   3 — UI unit tests (vitest)
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
  2  Non-UI unit tests (lib, cli, guardian, channels, scheduler)
  3  UI unit tests (vitest)
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
		-f .dev/config/stack/core.compose.yml \
		-f compose.dev.yml \
		--env-file .dev/config/stack/stack.env \
		--project-name "${COMPOSE_PROJECT_NAME:-openpalm}" "$@"
}

ensure_dev_setup() {
	if [[ ! -f .dev/config/stack/stack.env ]]; then
		echo "Seeding dev environment..."
		./scripts/dev-setup.sh --seed-env
	fi
}

ensure_ui_build() {
	# Build UI if the build output is missing or older than source
	if [[ ! -d packages/ui/build ]]; then
		echo "Building UI..."
		bun run ui:build
	fi
}

# ── UI host process lifecycle (v0.11.0: UI runs on the host, not in a container) ────
UI_PID_FILE="${ROOT_DIR}/.dev/admin.pid"
UI_LOG_FILE="${ROOT_DIR}/.dev/admin.log"
UI_PORT="${OP_HOST_UI_PORT:-3880}"

start_ui_host() {
	# Idempotent: kill any stale admin first
	stop_ui_host
	echo "Starting UI host process on port ${UI_PORT}..."
	OP_HOME="${ROOT_DIR}/.dev" \
	OP_HOST_UI_PORT="${UI_PORT}" \
		bun run packages/cli/src/main.ts --no-open >"${UI_LOG_FILE}" 2>&1 &
	echo $! >"${UI_PID_FILE}"
	# Wait for /health — the bare `openpalm` autoRun also runs docker
	# compose up -d before starting the UI, so allow time for recreate
	for i in $(seq 1 120); do
		if curl -sf "http://127.0.0.1:${UI_PORT}/health" >/dev/null 2>&1; then
			echo "UI host process ready at http://127.0.0.1:${UI_PORT}"
			return 0
		fi
		sleep 1
	done
	echo "ERROR: UI host process did not become ready within 120s" >&2
	tail -30 "${UI_LOG_FILE}" >&2
	return 1
}

stop_ui_host() {
	if [[ -f "${UI_PID_FILE}" ]]; then
		local pid
		pid=$(cat "${UI_PID_FILE}" 2>/dev/null || echo "")
		if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
			echo "Stopping UI host process (PID $pid)..."
			kill "$pid" 2>/dev/null || true
			wait "$pid" 2>/dev/null || true
		fi
		rm -f "${UI_PID_FILE}"
	fi
}

trap stop_ui_host EXIT

rebuild_stack() {
	# Always rebuild and recreate containers from source to ensure
	# compose config changes (env_file paths, mounts, env vars) are
	# picked up. Docker restart does NOT re-read compose config.
	ensure_dev_setup

	echo "Building UI..."
	bun run ui:build

	echo "Stopping previous stack containers..."
	dev_compose down --remove-orphans 2>/dev/null || true

	echo "Rebuilding and recreating stack from source..."
	dev_compose up --build --force-recreate -d

	# Wait for all services to be healthy
	echo "Waiting for all services to be healthy..."
	for i in $(seq 1 30); do
		local all_healthy=true
		for svc in assistant guardian; do
			local status
			status=$(docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME:-openpalm}-${svc}-1" 2>/dev/null || echo "missing")
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
	echo "=== Tier 2: Non-UI unit tests ==="
	bun run test
	;;
3)
	echo "=== Tier 3: UI unit tests ==="
	bun run ui:test:unit
	;;
4)
	echo "=== Tier 4: Mocked browser E2E ==="
	ensure_ui_build
	bun run ui:test:e2e:mocked
	;;
5)
	echo "=== Tier 5: Integration E2E (stack-dependent) ==="
	rebuild_stack
	start_ui_host
	bun run ui:test:stack
	;;
6)
	echo "=== Tier 6: Full stack E2E incl. LLM pipeline ==="
	rebuild_stack
	start_ui_host
	bun run ui:test:llm
	;;
*)
	echo "Unknown tier: $TIER (valid: 1-6)" >&2
	exit 1
	;;
esac
