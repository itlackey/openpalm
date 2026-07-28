#!/bin/bash
set -euo pipefail

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

mkdir -p /opt/openpalm/skeleton /opt/openpalm/guardian /opt/openpalm/guardian-pkg \
         /opt/openpalm/guardian/.local/share/opencode /opt/openpalm/guardian/.local/state/opencode \
         /opt/openpalm/guardian/.cache/bun/install 2>/dev/null || true

export PATH="/opt/openpalm/tools/node_modules/.bin:$PATH"

# ── Shared OpenCode provider credentials (G1) ─────────────────────────────────
# Delivered as a Compose secret (GUARDIAN_AUTH_JSON_FILE, always
# /run/secrets/guardian_auth_json in the shipped compose) rather than a
# knowledge/ bind mount, so the guardian mounts NOTHING from knowledge/ (see
# docs/public-seams-review.md §G1). Compose secrets always land at a fixed
# /run/secrets/<name> path, never at the arbitrary path OpenCode actually
# reads (HOME/.local/share/opencode/auth.json) — copy it into place before
# anything that starts OpenCode (the moderator below, or opencode-based tools)
# runs. Re-copied on every boot so a rotated auth.json takes effect on restart;
# non-fatal (`|| true`) so a boot with no credentials configured yet still
# starts (the guardian degrades to "no provider auth" rather than crash-looping).
if [ -n "${GUARDIAN_AUTH_JSON_FILE:-}" ] && [ -f "${GUARDIAN_AUTH_JSON_FILE}" ]; then
  install -m 600 "${GUARDIAN_AUTH_JSON_FILE}" "${HOME:-/opt/openpalm/guardian}/.local/share/opencode/auth.json" \
    || echo "warning: failed to install guardian auth.json from \$GUARDIAN_AUTH_JSON_FILE; continuing" >&2
fi

# ── Optional private-registry auth ────────────────────────────────────────────
# To install OP_GUARDIAN_PACKAGE from a private registry, supply an .npmrc. Bun
# reads $HOME/.npmrc for registry + auth. Prefer a mounted secret file
# (OP_GUARDIAN_NPMRC_FILE); OP_GUARDIAN_NPMRC is an inline convenience. The
# token is never logged.
NPMRC_DEST="${HOME:-/opt/openpalm/guardian}/.npmrc"
if [ -n "${OP_GUARDIAN_NPMRC_FILE:-}" ]; then
  if [ ! -f "${OP_GUARDIAN_NPMRC_FILE}" ]; then
    echo "ERROR: OP_GUARDIAN_NPMRC_FILE is set but not found: ${OP_GUARDIAN_NPMRC_FILE}" >&2
    exit 1
  fi
  install -m 600 "${OP_GUARDIAN_NPMRC_FILE}" "$NPMRC_DEST"
  echo "[guardian] using private-registry .npmrc from \$OP_GUARDIAN_NPMRC_FILE"
elif [ -n "${OP_GUARDIAN_NPMRC:-}" ]; then
  install -m 600 /dev/null "$NPMRC_DEST"
  printf '%s\n' "${OP_GUARDIAN_NPMRC}" > "$NPMRC_DEST"
  echo "[guardian] using private-registry .npmrc from \$OP_GUARDIAN_NPMRC"
fi

# ── Exact-pinned install: skip if already at version, retry transient failures ─
# FROM oven/bun:1.3-slim ships no node/npm — use bun. bun installs into the
# cwd's node_modules, so cd into the prefix.
install_artifact() {
  local pkg="$1" version="$2" prefix="$3"
  local manifest="${prefix}/node_modules/${pkg}/package.json"

  # `version` may be an exact pin (the common case) OR a semver RANGE — e.g.
  # OP_GUARDIAN_NPM_VERSION documents "semver ranges are supported here" for
  # downstream distributions overriding OP_GUARDIAN_PACKAGE. The skip check
  # used to compare the installed concrete version to `version` with plain
  # string equality, which can never match a range (`0.8.14` !== `^0.8.0`),
  # so a range-pinned override silently re-installed on every single boot
  # (docs/public-seams-review.md §E2 finding #4). Use Bun's built-in semver
  # matcher so an exact pin still matches itself and a range is checked for
  # satisfaction instead of literal equality.
  local installed_version
  installed_version="$(bun -e "try{console.log(require('$manifest').version)}catch{console.log('')}" 2>/dev/null)"
  if [ -n "$installed_version" ] && \
     bun -e "process.exit(Bun.semver.satisfies('$installed_version', '$version') ? 0 : 1)" 2>/dev/null; then
    echo "  ${pkg}@${version} already installed (${installed_version} satisfies ${version}), skipping"
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
#
# The guardian PACKAGE installs into /opt/openpalm/guardian-pkg, NOT
# /opt/openpalm/guardian. The latter is $HOME, bind-mounted from
# OP_HOME/data/guardian in compose for runtime state (nonce/rate-limit,
# OpenCode auth.json/config) — an empty host dir bind-mounted there would
# shadow a baked node_modules and force a network re-fetch every boot.
# guardian-pkg has no bind-mount in the shipped compose, so the image-baked
# install serves every boot with nothing to shadow it. #585 deleted the
# guardian-cache named volume that USED to make an override install (a
# non-default OP_GUARDIAN_NPM_VERSION/OP_GUARDIAN_PACKAGE) persist across
# container recreation — an override now lives only in the container's
# writable layer, so it re-installs (not re-downloads: the bun tarball cache
# is on the host bind, portals.compose.yml) on every recreation, not just
# restart/reboot. Accepted regression, documented in the #585 plan.
install_artifact "$OP_GUARDIAN_PACKAGE" "$VERSION" /opt/openpalm/guardian-pkg
install_artifact "@openpalm/skeleton" "${OP_SKELETON_VERSION:-$VERSION}" /opt/openpalm/skeleton

# ── E2/S2: no boot-time tools install ──────────────────────────────────────
# /opt/openpalm/tools/package.json declares exact tool versions (opencode-ai —
# the guardian's moderator has no use for any agent CLI, so akm-cli was
# dropped from this manifest) and is baked directly into the image's own layer
# by the Dockerfile at build time (#585: no named volume over /opt/openpalm
# anymore). No mount overlays it (image-baked-only model), so there is nothing
# to install or update here —
# the content-validation check below already verifies `opencode` resolved
# from the baked tree before anything that needs it starts. See
# docs/public-seams-review.md §E2/§S2.

# ── Hard-fail when content validation is enabled but opencode is missing ───────
enabled=0
case "${GUARDIAN_CONTENT_VALIDATION:-0}" in
  1 | true | TRUE | yes | on) enabled=1 ;;
esac
if [ "$enabled" = "1" ] && ! command -v opencode >/dev/null 2>&1; then
  echo "ERROR: GUARDIAN_CONTENT_VALIDATION=1 but opencode is not on PATH from the image-baked tools tree. Cannot start." >&2
  exit 1
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
GUARDIAN_CORE_PKG=$(cd /opt/openpalm/guardian-pkg && bun -e "console.log(require('node:path').dirname(require.resolve('@openpalm/guardian/package.json')))" 2>/dev/null || echo "/opt/openpalm/guardian-pkg/node_modules/@openpalm/guardian")
guardian_server_port="${PORT:-8080}"
openai_port="${GUARDIAN_OPENAI_PORT:-8182}"
PORT="${openai_port}" GUARDIAN_URL="http://localhost:${guardian_server_port}" \
  bun run "${GUARDIAN_CORE_PKG}/src/openai-api-server.ts" 2>&1 | sed -u 's/^/[openai-api] /' >&2 &

# ── Start guardian ────────────────────────────────────────────────────────────
exec bun run "/opt/openpalm/guardian-pkg/node_modules/${OP_GUARDIAN_PACKAGE}/${OP_GUARDIAN_ENTRY}"
