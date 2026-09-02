#!/bin/bash
set -euo pipefail

# ── The guardian package ──────────────────────────────────────────────────────
# The image bakes exactly one guardian, built from the candidate source, and
# that is what runs. There is deliberately NO env override of the package, its
# version, or its entry point.
#
# There used to be one (OP_GUARDIAN_NPM_VERSION / OP_GUARDIAN_PACKAGE /
# OP_GUARDIAN_ENTRY, installed at boot by install_artifact). It cost a real
# outage: the pre-0.13 release model WROTE OP_GUARDIAN_NPM_VERSION into
# state/stack.env, 554b79bc removed that writer without sweeping the key, and
# every upgraded home kept a stale value. Guardian then discarded its correct
# baked package on every boot and installed that old version from npm — which
# predated 0.13.0's always-on OpenCode auth, so it 401'd, disabled its own
# proxy, answered /health/ready with 503, failed its healthcheck, and took
# every stack update down with it for months. An image that cannot be silently
# replaced at boot is worth more than an override nobody was using.
#
# OP_GUARDIAN_VERSION remains ONLY the Docker image tag, consumed by Compose on
# the `image:` line. It is not read here.
GUARDIAN_PKG_DIR=/opt/openpalm/guardian-pkg/node_modules/@openpalm/guardian

mkdir -p /opt/openpalm/guardian /opt/openpalm/guardian-pkg \
         /opt/openpalm/guardian/.local/share/opencode /opt/openpalm/guardian/.local/state/opencode \
         /opt/openpalm/guardian/.cache/bun/install 2>/dev/null || true

export PATH="/opt/openpalm/tools/node_modules/.bin:$PATH"

# ── Shared OpenCode provider credentials (G1) ─────────────────────────────────
# Delivered as a Compose secret (GUARDIAN_AUTH_JSON_FILE, always
# /run/secrets/guardian_auth_json in the shipped compose) rather than a
# knowledge/ bind mount, so the guardian mounts nothing from knowledge/.
# Compose secrets always land at a fixed
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

# ── E2/S2: no boot-time tools install ──────────────────────────────────────
# /opt/openpalm/tools/package.json declares exact tool versions (opencode-ai —
# the guardian's moderator has no use for any agent CLI, so akm-cli was
# dropped from this manifest) and is baked directly into the image's own layer
# by the Dockerfile at build time (#585: no named volume over /opt/openpalm
# anymore). No mount overlays it (image-baked-only model), so there is nothing
# to install or update here —
# the content-validation check below already verifies `opencode` resolved
# from the baked tree before anything that needs it starts.

# ── Hard-fail when content validation is enabled but opencode is missing ───────
enabled=1
case "${GUARDIAN_CONTENT_VALIDATION:-1}" in
  0 | false | FALSE | False | no | NO | No | off | OFF | Off) enabled=0 ;;
esac
if [ "$enabled" = "1" ] && ! command -v opencode >/dev/null 2>&1; then
  echo "ERROR: GUARDIAN_CONTENT_VALIDATION=1 but opencode is not on PATH from the image-baked tools tree. Cannot start." >&2
  exit 1
fi

# ── Start OpenCode moderator (when content validation is enabled) ─────────────
if [ "$enabled" = "1" ]; then
  # Managed moderator config → disposable runtime copy, the same split
  # Paperclip's launcher uses. OpenCode WRITES into every config dir it loads
  # (ensureGitignore, `@opencode-ai/plugin` install), so OPENCODE_CONFIG_DIR
  # cannot be the lifecycle-owned system/guardian tree itself — that would let
  # the policed process rewrite its own moderation policy. system/guardian
  # arrives :ro at $managed_config; the runtime copy is a regenerable cache
  # bind (cache/guardian-opencode/runtime).
  managed_config=/opt/openpalm/guardian-config
  runtime_config="${OPENCODE_CONFIG_DIR:-/etc/opencode}"
  if [ ! -r "$managed_config/opencode.jsonc" ]; then
    echo "ERROR: GUARDIAN_CONTENT_VALIDATION=1 but the managed moderator config is unreadable at ${managed_config} (expected the system/guardian read-only mount). Cannot start." >&2
    exit 1
  fi
  mkdir -p "$runtime_config"
  # Retired managed files must not survive a release update — OpenCode
  # auto-discovers whatever is in the config dir. Only OpenCode's own runtime
  # artifacts are kept; everything else is republished from $managed_config
  # below. Safe as a blanket sweep here (unlike Paperclip's per-file publish):
  # this runs once at boot, before anything reads the directory.
  for entry in "$runtime_config"/* "$runtime_config"/.[!.]* "$runtime_config"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    case ${entry##*/} in
      .gitignore | node_modules | package.json | bun.lock | bun.lockb) ;;
      *) rm -rf -- "$entry" ;;
    esac
  done
  cp -R "$managed_config/." "$runtime_config/"

  port="${GUARDIAN_MODERATION_PORT:-4097}"
  echo "[guardian] starting OpenCode moderator on 127.0.0.1:${port}"
  OPENCODE_CONFIG_DIR="$runtime_config" \
    opencode serve --hostname 127.0.0.1 --port "${port}" \
    --print-logs --log-level INFO 2>&1 | sed -u 's/^/[moderator] /' >&2 &
fi

# ── Start the OpenAI-compatible API server ────────────────────────────────────
# Runs on GUARDIAN_OPENAI_PORT (default 8182), proxies to the guardian server on
# localhost:${PORT:-8080}. One baked package, one path.
GUARDIAN_CORE_PKG="$GUARDIAN_PKG_DIR"
guardian_server_port="${PORT:-8080}"
openai_port="${GUARDIAN_OPENAI_PORT:-8182}"
PORT="${openai_port}" GUARDIAN_URL="http://localhost:${guardian_server_port}" \
  bun run "${GUARDIAN_CORE_PKG}/src/openai-api-server.ts" 2>&1 | sed -u 's/^/[openai-api] /' >&2 &

# ── Start guardian ────────────────────────────────────────────────────────────
exec bun run "${GUARDIAN_PKG_DIR}/src/server.ts"
