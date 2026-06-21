#!/bin/bash
set -euo pipefail

resolve_version() {
  local override="$1" platform="$2" name="$3"
  [ -n "$override" ] && echo "$override" && return
  [ -n "$platform" ] && echo "$platform" && return
  echo "ERROR: Cannot resolve version for $name. Set OP_${name}_VERSION or PLATFORM_VERSION." >&2
  exit 1
}

# ── Exact-pinned components ───────────────────────────────────────────────────
install_artifact() {
  local pkg="$1" version="$2" prefix="$3"
  echo "Installing ${pkg}@${version}..."
  # The image is FROM oven/bun:1.3-slim, which ships no node/npm. Use bun, the
  # runtime this entrypoint already relies on. bun installs into the cwd's
  # node_modules, so cd into the prefix; the exact-version pin (${version}) is a
  # security boundary and must not be loosened to a range.
  mkdir -p "$prefix"
  ( cd "$prefix" && bun add "${pkg}@${version}" --production )
}

GUARDIAN_VERSION=$(resolve_version "${OP_GUARDIAN_VERSION:-}" "${PLATFORM_VERSION:-}" "GUARDIAN")
install_artifact "@openpalm/guardian" "$GUARDIAN_VERSION" /opt/openpalm/guardian

SKELETON_VERSION=$(resolve_version "${OP_SKELETON_VERSION:-}" "${PLATFORM_VERSION:-}" "SKELETON")
install_artifact "@openpalm/skeleton" "$SKELETON_VERSION" /opt/openpalm/skeleton

# ── Range-versioned tools from tools.json guardian section ────────────────────
export BUN_INSTALL=/opt/openpalm/tools
export PATH="$BUN_INSTALL/bin:$PATH"

TOOL_PKGS=$(bun -e "
  const tools = require('/opt/openpalm/skeleton/node_modules/@openpalm/skeleton/tools.json').guardian || [];
  const pkgs = tools.map(t => t.package + '@' + (process.env[t.envKey] || t.default));
  console.log(pkgs.join(' '));
")
[ -n "$TOOL_PKGS" ] && bun add -g $TOOL_PKGS || echo "WARN: some tool installs failed; continuing"

# ── Paths resolved once (package is now installed) ────────────────────────────
GUARDIAN_PKG=/opt/openpalm/guardian/node_modules/@openpalm/guardian

# ── Start OpenCode moderator (when content validation is enabled) ─────────────
# opencode is a range-versioned tool installed above via tools.json. If it is
# unavailable for any reason, log a warning and continue — the heuristic screen
# still runs, and escalated messages fail-closed (blocked) rather than crashing.
enabled=0
case "${GUARDIAN_CONTENT_VALIDATION:-0}" in
  1 | true | TRUE | yes | on) enabled=1 ;;
esac

if [ "$enabled" = "1" ]; then
  if command -v opencode >/dev/null 2>&1; then
    port="${GUARDIAN_MODERATION_PORT:-4097}"
    echo "[guardian] starting OpenCode moderator on 127.0.0.1:${port}"
    OPENCODE_AUTH=false \
    OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-/etc/opencode}" \
      opencode serve --hostname 127.0.0.1 --port "${port}" \
      --print-logs --log-level INFO 2>&1 | sed -u 's/^/[moderator] /' >&2 &
  else
    echo "[guardian] WARN: GUARDIAN_CONTENT_VALIDATION=1 but opencode not found on PATH; moderator will not start. Messages escalated by the heuristic screen will be blocked (fail-closed)." >&2
  fi
fi

# ── Start the OpenAI-compatible API server ────────────────────────────────────
# Runs on GUARDIAN_OPENAI_PORT (default 8182) and proxies to the guardian
# server on localhost:${PORT:-8080}. Backgrounded so it doesn't block the main
# server; pipe to stderr so logs appear in `docker logs`.
guardian_server_port="${PORT:-8080}"
openai_port="${GUARDIAN_OPENAI_PORT:-8182}"
PORT="${openai_port}" GUARDIAN_URL="http://localhost:${guardian_server_port}" \
  bun run "${GUARDIAN_PKG}/src/openai-api-server.ts" 2>&1 | sed -u 's/^/[openai-api] /' >&2 &

# ── Start guardian ────────────────────────────────────────────────────────────
exec bun run "${GUARDIAN_PKG}/src/server.ts"
