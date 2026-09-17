#!/bin/bash
set -euo pipefail

guardian_package=/opt/openpalm/guardian-app
guardian_home=${HOME:-/opt/openpalm/guardian}
export PATH="/opt/openpalm/tools/node_modules/.bin:$PATH"

mkdir -p "$guardian_home/.local/share/opencode" /opt/openpalm/logs

require_strong_secret() {
  local name=$1
  local path=${!name:-}
  if [ -z "$path" ] || [ ! -r "$path" ]; then
    echo "ERROR: $name must name a readable secret file" >&2
    exit 1
  fi
  local value
  value=$(tr -d '\r\n' < "$path")
  if [ "${#value}" -lt 32 ]; then
    echo "ERROR: $name must contain at least 32 characters" >&2
    exit 1
  fi
}

guardian_auth_dir=${GUARDIAN_AUTH_DIR:-}
if [ -z "$guardian_auth_dir" ] || [ ! -d "$guardian_auth_dir" ] || [ ! -r "$guardian_auth_dir/registry.json" ]; then
  echo "ERROR: GUARDIAN_AUTH_DIR must contain a readable credential registry" >&2
  exit 1
fi
require_strong_secret GUARDIAN_HANDLE_KEY_FILE
require_strong_secret OPENCODE_SERVER_PASSWORD_FILE

if ! command -v opencode >/dev/null 2>&1; then
  echo "ERROR: content validation requires the image-baked opencode binary" >&2
  exit 1
fi
managed_config=/opt/openpalm/moderator-config
if [ ! -r "$managed_config/opencode.jsonc" ]; then
  echo "ERROR: content validation requires managed guardian configuration" >&2
  exit 1
fi
moderator_port=${GUARDIAN_MODERATION_PORT:-4097}
OPENCODE_CONFIG_DIR="$managed_config" \
  opencode serve --hostname 127.0.0.1 --port "$moderator_port" \
  --print-logs --log-level INFO 2>&1 | sed -u 's/^/[moderator] /' >&2 &
moderator_pid=$!

moderator_ready=0
moderator_deadline=$((SECONDS + 60))
while ((SECONDS < moderator_deadline)); do
  # OpenCode initializes config lazily. Its first request can stall while that
  # instance is created, so bound each probe and retry instead of hanging the
  # Guardian entrypoint forever.
  if curl -sf --connect-timeout 1 --max-time 5 \
    "http://127.0.0.1:$moderator_port/config" >/dev/null; then
    moderator_ready=1
    break
  fi
  if ! kill -0 "$moderator_pid" 2>/dev/null; then break; fi
  sleep 0.25
done
if [ "$moderator_ready" -ne 1 ]; then
  echo 'ERROR: content moderator did not become healthy' >&2
  kill "$moderator_pid" 2>/dev/null || true
  wait "$moderator_pid" 2>/dev/null || true
  exit 1
fi

bun run "$guardian_package/src/lean-server.ts" &
guardian_pid=$!

shutdown() {
  kill "$guardian_pid" "$moderator_pid" 2>/dev/null || true
  wait "$guardian_pid" "$moderator_pid" 2>/dev/null || true
}
trap shutdown INT TERM EXIT

if wait -n "$guardian_pid" "$moderator_pid"; then
  status=0
else
  status=$?
fi
trap - EXIT
shutdown
exit "$status"
