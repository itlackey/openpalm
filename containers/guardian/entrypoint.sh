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
  npm install --prefix "$prefix" "${pkg}@${version}" --omit=dev --prefer-offline
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

# ── Start guardian ────────────────────────────────────────────────────────────
exec bun run /opt/openpalm/guardian/node_modules/@openpalm/guardian/src/server.ts
