#!/usr/bin/env bash
set -euo pipefail

# Admin entrypoint — supervises SvelteKit (port 8100) and OpenCode (port 3881).
# Both run as background children of this bash supervisor so we can:
#   1. Forward SIGTERM/SIGINT to both children for clean shutdown.
#   2. Exit (and let Compose restart) when EITHER child dies, so a crashed
#      OpenCode does not leave the container "healthy" from SvelteKit alone.

SVELTEKIT_PORT="${PORT:-8100}"
OPENCODE_PORT="${OPENCODE_PORT:-3881}"

# ── Seed admin OpenCode config if not already present ─────────────────
OPENCODE_CFG="${OPENCODE_CONFIG_DIR:-/etc/opencode}/opencode.jsonc"
if [ ! -f "$OPENCODE_CFG" ]; then
	mkdir -p "$(dirname "$OPENCODE_CFG")" 2>/dev/null || true
	if ! cp /app/opencode.jsonc "$OPENCODE_CFG" 2>/dev/null; then
		echo "WARN: failed to seed OpenCode config at $OPENCODE_CFG" >&2
	fi
fi

# Note: varlock-based runtime redaction was retired in #391. Log redaction
# is enforced in-process by @openpalm/lib's logger, which masks values for
# keys matching `_TOKEN | _SECRET | _KEY | _PASSWORD`.

OPENCODE_PID=""
SVELTEKIT_PID=""

# ── Start OpenCode in background ──────────────────────────────────────
start_opencode() {
	if ! command -v opencode >/dev/null 2>&1; then
		echo "WARN: opencode not found — admin AI assistant disabled" >&2
		return 0
	fi

	# Ensure OpenCode user dirs exist under HOME
	mkdir -p \
		"${HOME}/.config/opencode" \
		"${HOME}/.local/state/opencode" \
		"${HOME}/.local/share/opencode" \
		"${HOME}/.cache" \
		2>/dev/null || true

	# Ensure bun's user-writable directories exist
	mkdir -p \
		"${BUN_INSTALL:-${HOME}/.bun}/bin" \
		"${BUN_INSTALL_CACHE_DIR:-${HOME}/.cache/bun/install}" \
		2>/dev/null || true

	echo "Starting admin OpenCode on port ${OPENCODE_PORT}..."
	opencode web --hostname 0.0.0.0 --port "$OPENCODE_PORT" --print-logs &
	OPENCODE_PID=$!
	echo "Admin OpenCode started (PID ${OPENCODE_PID})"
}

# ── Start SvelteKit in background ─────────────────────────────────────
start_sveltekit() {
	echo "Starting admin SvelteKit on port ${SVELTEKIT_PORT}..."
	node build/index.js &
	SVELTEKIT_PID=$!
	echo "Admin SvelteKit started (PID ${SVELTEKIT_PID})"
}

# ── Cleanup on exit ───────────────────────────────────────────────────
cleanup() {
	if [ -n "${OPENCODE_PID:-}" ] && kill -0 "$OPENCODE_PID" 2>/dev/null; then
		kill -TERM "$OPENCODE_PID" 2>/dev/null || true
	fi
	if [ -n "${SVELTEKIT_PID:-}" ] && kill -0 "$SVELTEKIT_PID" 2>/dev/null; then
		kill -TERM "$SVELTEKIT_PID" 2>/dev/null || true
	fi
	wait 2>/dev/null || true
}
trap cleanup TERM INT EXIT

start_opencode
start_sveltekit

# ── Supervisor: exit when either child dies ──────────────────────────
# `wait -n` returns when ANY child exits, with that child's status. The
# container then exits and Compose's `restart: unless-stopped` recreates
# it, instead of pretending healthy with one crashed component.
if [ -n "${OPENCODE_PID:-}" ]; then
	wait -n "$OPENCODE_PID" "$SVELTEKIT_PID"
else
	wait -n "$SVELTEKIT_PID"
fi
exit_status=$?
echo "Admin supervisor: a child process exited (status ${exit_status}); shutting down container." >&2
exit "$exit_status"
