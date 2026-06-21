#!/bin/bash
set -euo pipefail

TARGET_UID="${OP_UID:-1000}"
TARGET_GID="${OP_GID:-1000}"
IS_ROOT=$([ "$(id -u)" = "0" ] && echo 1 || echo 0)

# ── Version resolution ────────────────────────────────────────────────────────
# GUARDIAN_VERSION is baked into the image at build time (Dockerfile ARG → ENV),
# so the thin host boots with no operator configuration. Operators may override
# the installed npm package version with OP_GUARDIAN_NPM_VERSION (e.g. to pin a
# private package at a different version; semver ranges are supported here).
# OP_GUARDIAN_VERSION is now ONLY the Docker image tag (consumed by Compose on
# the `image:` line) and is NOT used for the npm install.
VERSION="${OP_GUARDIAN_NPM_VERSION:-${GUARDIAN_VERSION:-}}"
if [ -z "$VERSION" ]; then
  echo "ERROR: No guardian version. Set OP_GUARDIAN_NPM_VERSION, or rebuild the image with the GUARDIAN_VERSION build arg." >&2
  exit 1
fi

# Composition package + boot entry, overridable for downstream distributions
# built on the published library seams (defaults to the public core).
OP_GUARDIAN_PACKAGE="${OP_GUARDIAN_PACKAGE:-@openpalm/guardian}"
OP_GUARDIAN_ENTRY="${OP_GUARDIAN_ENTRY:-src/server.ts}"

# ── Privilege setup: chown the artifact volume then drop to OP_UID:OP_GID ──────
# The container starts as root (no `user:` in compose). /opt/openpalm is the
# guardian-cache named volume, root-owned on first boot. Chown ONLY the
# named-volume paths — the nested bind mounts (guardian/ -> data/guardian,
# logs/ -> data/logs, and the :ro auth.json) are host-owned, so recursively
# chowning them would rewrite host ownership every boot (and the :ro chown
# would fail). The host owner is OP_UID:OP_GID, so the gosu'd process can
# read/write the bind mounts directly.
if [ "$IS_ROOT" = "1" ]; then
  mkdir -p /opt/openpalm/tools /opt/openpalm/skeleton /opt/openpalm/guardian
  chown "${TARGET_UID}:${TARGET_GID}" /opt/openpalm /opt/openpalm/guardian 2>/dev/null || true
  chown -R "${TARGET_UID}:${TARGET_GID}" /opt/openpalm/tools /opt/openpalm/skeleton 2>/dev/null || true
fi

# ── Optional private-registry auth ────────────────────────────────────────────
# To install OP_GUARDIAN_PACKAGE from a private registry, supply an .npmrc. Bun
# reads $HOME/.npmrc for registry + auth. Prefer a mounted secret file
# (OP_GUARDIAN_NPMRC_FILE); OP_GUARDIAN_NPMRC is an inline convenience. Runs on
# the root pass and again after the gosu drop, so on the root pass hand the file
# to the target uid:gid for the second (non-privileged) pass. The token is
# never logged.
NPMRC_DEST="${HOME:-/opt/openpalm/guardian}/.npmrc"
if [ -n "${OP_GUARDIAN_NPMRC_FILE:-}" ]; then
  if [ ! -f "${OP_GUARDIAN_NPMRC_FILE}" ]; then
    echo "ERROR: OP_GUARDIAN_NPMRC_FILE is set but not found: ${OP_GUARDIAN_NPMRC_FILE}" >&2
    exit 1
  fi
  install -m 600 "${OP_GUARDIAN_NPMRC_FILE}" "$NPMRC_DEST"
  [ "$IS_ROOT" = "1" ] && chown "${TARGET_UID}:${TARGET_GID}" "$NPMRC_DEST" 2>/dev/null || true
  echo "[guardian] using private-registry .npmrc from \$OP_GUARDIAN_NPMRC_FILE"
elif [ -n "${OP_GUARDIAN_NPMRC:-}" ]; then
  printf '%s\n' "${OP_GUARDIAN_NPMRC}" > "$NPMRC_DEST"
  chmod 600 "$NPMRC_DEST"
  [ "$IS_ROOT" = "1" ] && chown "${TARGET_UID}:${TARGET_GID}" "$NPMRC_DEST" 2>/dev/null || true
  echo "[guardian] using private-registry .npmrc from \$OP_GUARDIAN_NPMRC"
fi

# ── Exact-pinned install: skip if already at version, retry transient failures ─
# FROM oven/bun:1.3-slim ships no node/npm — use bun. bun installs into the
# cwd's node_modules, so cd into the prefix.
install_artifact() {
  local pkg="$1" version="$2" prefix="$3"
  local manifest="${prefix}/node_modules/${pkg}/package.json"

  if [ -f "$manifest" ] && \
     [ "$(bun -e "try{console.log(require('$manifest').version)}catch{console.log('')}" 2>/dev/null)" = "$version" ]; then
    echo "  ${pkg}@${version} already installed, skipping"
    return 0
  fi

  local attempt
  for attempt in 1 2 3; do
    echo "Installing ${pkg}@${version} (attempt ${attempt})..."
    mkdir -p "$prefix"
    ( cd "$prefix" && bun add "${pkg}@${version}" --production ) && return 0
    [ "$attempt" -lt 3 ] && echo "  Install failed, retrying in 5s..." && sleep 5
  done
  echo "ERROR: Failed to install ${pkg}@${version} after 3 attempts" >&2
  exit 1
}

# Guardian and skeleton are co-released, so the skeleton follows the same
# version by default; OP_SKELETON_VERSION overrides if they ever diverge.
install_artifact "$OP_GUARDIAN_PACKAGE" "$VERSION" /opt/openpalm/guardian
install_artifact "@openpalm/skeleton" "${OP_SKELETON_VERSION:-$VERSION}" /opt/openpalm/skeleton

# ── Range-versioned tools from the skeleton's tools.json guardian section ──────
export BUN_INSTALL=/opt/openpalm/tools
export PATH="$BUN_INSTALL/bin:$PATH"

TOOL_PKGS=$(bun -e "
  const tools = require('/opt/openpalm/skeleton/node_modules/@openpalm/skeleton/tools.json').guardian || [];
  console.log(tools.map(t => t.package + '@' + (process.env[t.envKey] || t.default)).join(' '));
")
[ -n "$TOOL_PKGS" ] && bun add -g $TOOL_PKGS || echo "WARN: some tool installs failed; continuing"

# ── Hard-fail when content validation is enabled but opencode is missing ───────
enabled=0
case "${GUARDIAN_CONTENT_VALIDATION:-0}" in
  1 | true | TRUE | yes | on) enabled=1 ;;
esac
if [ "$enabled" = "1" ] && ! command -v opencode >/dev/null 2>&1; then
  echo "ERROR: GUARDIAN_CONTENT_VALIDATION=1 but opencode is not on PATH after tool install. Cannot start." >&2
  exit 1
fi

# ── Drop privileges before starting servers ───────────────────────────────────
# Installs ran as root (to write /opt/openpalm on a fresh named volume). Re-exec
# as the target uid:gid for the server processes; the marker prevents a loop.
if [ "$IS_ROOT" = "1" ] && [ "${GUARDIAN_ENTRYPOINT_DROPPED:-0}" != "1" ]; then
  if ! command -v gosu >/dev/null 2>&1; then
    echo "ERROR: gosu not found — cannot drop privileges. Install gosu in the Dockerfile." >&2
    exit 1
  fi
  exec gosu "${TARGET_UID}:${TARGET_GID}" \
    env HOME=/opt/openpalm/guardian GUARDIAN_ENTRYPOINT_DROPPED=1 \
    "$0" "$@"
fi

# ── Start OpenCode moderator (when content validation is enabled) ─────────────
if [ "$enabled" = "1" ]; then
  port="${GUARDIAN_MODERATION_PORT:-4097}"
  echo "[guardian] starting OpenCode moderator on 127.0.0.1:${port}"
  OPENCODE_AUTH=false \
  OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-/etc/opencode}" \
    opencode serve --hostname 127.0.0.1 --port "${port}" \
    --print-logs --log-level INFO 2>&1 | sed -u 's/^/[moderator] /' >&2 &
fi

# ── Start the OpenAI-compatible API server ────────────────────────────────────
# Runs on GUARDIAN_OPENAI_PORT (default 8182), proxies to the guardian server on
# localhost:${PORT:-8080}. The openai-api server lives in the public core
# @openpalm/guardian; when OP_GUARDIAN_PACKAGE is an alternate package the core
# is still present (transitive dep), so resolve it via require.resolve. In the
# default case this equals the guardian package dir.
GUARDIAN_CORE_PKG=$(cd /opt/openpalm/guardian && bun -e "console.log(require('node:path').dirname(require.resolve('@openpalm/guardian/package.json')))" 2>/dev/null || echo "/opt/openpalm/guardian/node_modules/@openpalm/guardian")
guardian_server_port="${PORT:-8080}"
openai_port="${GUARDIAN_OPENAI_PORT:-8182}"
PORT="${openai_port}" GUARDIAN_URL="http://localhost:${guardian_server_port}" \
  bun run "${GUARDIAN_CORE_PKG}/src/openai-api-server.ts" 2>&1 | sed -u 's/^/[openai-api] /' >&2 &

# ── Start guardian ────────────────────────────────────────────────────────────
exec bun run "/opt/openpalm/guardian/node_modules/${OP_GUARDIAN_PACKAGE}/${OP_GUARDIAN_ENTRY}"
