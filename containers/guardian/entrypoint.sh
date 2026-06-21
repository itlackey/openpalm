#!/bin/bash
set -euo pipefail

TARGET_UID="${OP_UID:-1000}"
TARGET_GID="${OP_GID:-1000}"
IS_ROOT=$([ "$(id -u)" = "0" ] && echo 1 || echo 0)

# ── Configurable guardian composition package ─────────────────────────────────
# This thin host installs and boots a guardian composition package. The package
# is overridable so downstream distributions built on the published library
# seams can run on the stock image without forking this entrypoint. Defaults to
# the public core so existing behavior is unchanged. Version resolution
# (OP_GUARDIAN_VERSION / PLATFORM_VERSION) is independent of which package is
# installed; the exact-version pin remains a security boundary (no ranges).
OP_GUARDIAN_PACKAGE="${OP_GUARDIAN_PACKAGE:-@openpalm/guardian}"
# Boot entry within the configured package, overridable for alternate packages.
OP_GUARDIAN_ENTRY="${OP_GUARDIAN_ENTRY:-src/server.ts}"

resolve_version() {
  local override="$1" platform="$2" name="$3"
  [ -n "$override" ] && echo "$override" && return
  [ -n "$platform" ] && echo "$platform" && return
  echo "ERROR: Cannot resolve version for $name. Set OP_${name}_VERSION or PLATFORM_VERSION." >&2
  exit 1
}

# ── Privilege setup: chown the artifact volume then drop to OP_UID:OP_GID ──────
# /opt/openpalm is the guardian-cache named volume, initialised root-owned on
# first boot. There is no `user:` in the compose service, so the container
# starts as root; we fix ownership of the container-private paths on that
# volume, then re-exec via gosu at the target uid for the server processes.
#
# Chown ONLY the named-volume paths. The nested bind mounts
# (/opt/openpalm/guardian -> OP_HOME/data/guardian, /opt/openpalm/logs ->
# OP_HOME/data/logs, and the read-only auth.json under guardian/) are
# host-owned; recursively chowning a bind mount rewrites host file ownership on
# every boot (a data-ownership hazard) and the :ro auth.json chown would fail.
# The host owner is OP_UID:OP_GID, so the gosu'd process reads/writes those
# bind mounts directly. Same reasoning as the assistant entrypoint.
ensure_volume_ownership() {
  if [ "$IS_ROOT" = "0" ]; then return 0; fi

  mkdir -p /opt/openpalm/tools /opt/openpalm/skeleton /opt/openpalm/guardian
  # Volume root + guardian/ bind-mount mountpoint: non-recursive (just the dir,
  # so the gosu'd user can traverse). tools/ (bun global install root) and
  # skeleton/ live on the named volume: recursive.
  chown "${TARGET_UID}:${TARGET_GID}" /opt/openpalm /opt/openpalm/guardian 2>/dev/null || true
  chown -R "${TARGET_UID}:${TARGET_GID}" /opt/openpalm/tools /opt/openpalm/skeleton 2>/dev/null || true
}

# ── Exact-pinned components ───────────────────────────────────────────────────
# install_artifact: skip if already at target version, retry on transient failures.
install_artifact() {
  local pkg="$1" version="$2" prefix="$3"
  # The image is FROM oven/bun:1.3-slim, which ships no node/npm. Use bun, the
  # runtime this entrypoint already relies on. bun installs into the cwd's
  # node_modules, so cd into the prefix; the exact-version pin (${version}) is a
  # security boundary and must not be loosened to a range.
  local manifest="${prefix}/node_modules/${pkg}/package.json"
  local installed_version=""

  if [ -f "$manifest" ]; then
    installed_version=$(bun -e "try { const p = require('$manifest'); console.log(p.version); } catch { console.log(''); }" 2>/dev/null || true)
  fi

  if [ "$installed_version" = "$version" ]; then
    echo "  ${pkg}@${version} already installed, skipping"
    return 0
  fi

  local attempt=0
  while [ $attempt -lt 3 ]; do
    attempt=$((attempt + 1))
    echo "Installing ${pkg}@${version} (attempt ${attempt})..."
    mkdir -p "$prefix"
    if ( cd "$prefix" && bun add "${pkg}@${version}" --production ); then
      return 0
    fi
    [ $attempt -lt 3 ] && echo "  Install failed, retrying in 5s..." && sleep 5
  done
  echo "ERROR: Failed to install ${pkg}@${version} after 3 attempts" >&2
  exit 1
}

ensure_volume_ownership

GUARDIAN_VERSION=$(resolve_version "${OP_GUARDIAN_VERSION:-}" "${PLATFORM_VERSION:-}" "GUARDIAN")
install_artifact "$OP_GUARDIAN_PACKAGE" "$GUARDIAN_VERSION" /opt/openpalm/guardian

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

# ── Fix M3: Hard-fail when content validation is enabled but opencode is missing
enabled=0
case "${GUARDIAN_CONTENT_VALIDATION:-0}" in
  1 | true | TRUE | yes | on) enabled=1 ;;
esac

if [ "$enabled" = "1" ] && ! command -v opencode >/dev/null 2>&1; then
  echo "ERROR: GUARDIAN_CONTENT_VALIDATION=1 but opencode is not on PATH after tool install. Cannot start." >&2
  exit 1
fi

# ── Paths resolved once (package is now installed) ────────────────────────────
# Boot path resolves from the configured composition package.
GUARDIAN_PKG="/opt/openpalm/guardian/node_modules/${OP_GUARDIAN_PACKAGE}"

# ── Drop privileges before starting servers ───────────────────────────────────
# All artifact installs ran as root (needed to write /opt/openpalm on a
# fresh named volume). Now drop to the target uid:gid for the server processes.
# Re-exec this script as the target user so the remaining sections run
# non-privileged. The GUARDIAN_ENTRYPOINT_DROPPED marker prevents infinite loops.
if [ "$IS_ROOT" = "1" ] && [ "${GUARDIAN_ENTRYPOINT_DROPPED:-0}" != "1" ]; then
  if ! command -v gosu >/dev/null 2>&1; then
    echo "ERROR: gosu not found — cannot drop privileges. Install gosu in the Dockerfile." >&2
    exit 1
  fi
  export GUARDIAN_ENTRYPOINT_DROPPED=1
  exec gosu "${TARGET_UID}:${TARGET_GID}" \
    env HOME=/opt/openpalm/guardian GUARDIAN_ENTRYPOINT_DROPPED=1 \
    "$0" "$@"
fi

# ── Start OpenCode moderator (when content validation is enabled) ─────────────
# opencode is a range-versioned tool installed above via tools.json. The
# hard-fail check above guarantees we only reach here if opencode is present
# when content validation is enabled.
if [ "$enabled" = "1" ]; then
  if command -v opencode >/dev/null 2>&1; then
    port="${GUARDIAN_MODERATION_PORT:-4097}"
    echo "[guardian] starting OpenCode moderator on 127.0.0.1:${port}"
    OPENCODE_AUTH=false \
    OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-/etc/opencode}" \
      opencode serve --hostname 127.0.0.1 --port "${port}" \
      --print-logs --log-level INFO 2>&1 | sed -u 's/^/[moderator] /' >&2 &
  fi
fi

# ── Start the OpenAI-compatible API server ────────────────────────────────────
# Runs on GUARDIAN_OPENAI_PORT (default 8182) and proxies to the guardian
# server on localhost:${PORT:-8080}. Backgrounded so it doesn't block the main
# server; pipe to stderr so logs appear in `docker logs`.
#
# The OpenAI-compatible API server lives in the public core @openpalm/guardian.
# When OP_GUARDIAN_PACKAGE is an alternate package, the core is still present as
# a (transitive) dependency, so resolve the core package dir robustly via
# require.resolve and run openai-api from there rather than from $GUARDIAN_PKG.
# In the default case GUARDIAN_CORE_PKG == GUARDIAN_PKG, so behavior is identical.
GUARDIAN_CORE_PKG=$(cd /opt/openpalm/guardian && bun -e "console.log(require('node:path').dirname(require.resolve('@openpalm/guardian/package.json')))" 2>/dev/null || echo "/opt/openpalm/guardian/node_modules/@openpalm/guardian")
guardian_server_port="${PORT:-8080}"
openai_port="${GUARDIAN_OPENAI_PORT:-8182}"
PORT="${openai_port}" GUARDIAN_URL="http://localhost:${guardian_server_port}" \
  bun run "${GUARDIAN_CORE_PKG}/src/openai-api-server.ts" 2>&1 | sed -u 's/^/[openai-api] /' >&2 &

# ── Start guardian ────────────────────────────────────────────────────────────
# Boot the configured composition package at its (overridable) entry point.
exec bun run "${GUARDIAN_PKG}/${OP_GUARDIAN_ENTRY}"
