#!/usr/bin/env bash
#
# Guardian entrypoint.
#
# When content validation is enabled, start the local OpenCode moderator on
# loopback before launching the guardian server. The moderator classifies
# suspicious inbound messages; the guardian server (src/server.ts) calls it at
# GUARDIAN_MODERATION_URL (default http://127.0.0.1:4097).
#
# When validation is disabled (default), the moderator is not started and the
# guardian behaves exactly as before — structural + HMAC validation only.

set -euo pipefail

enabled=0
case "${GUARDIAN_CONTENT_VALIDATION:-0}" in
  1 | true | TRUE | yes | on) enabled=1 ;;
esac

if [[ "$enabled" == "1" ]]; then
  port="${GUARDIAN_MODERATION_PORT:-4097}"
  log_dir="${HOME:-/opt/openpalm/guardian}"
  echo "[guardian] starting OpenCode moderator on 127.0.0.1:${port}"
  # Loopback only, auth disabled (reachable only from inside this container),
  # config from /etc/opencode (bind-mounted config/guardian). Backgrounded so
  # the guardian server starts regardless; if the moderator is down, escalated
  # messages fail closed.
  OPENCODE_AUTH=false \
  OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-/etc/opencode}" \
    opencode serve --hostname 127.0.0.1 --port "${port}" \
    >"${log_dir}/moderator.log" 2>&1 &
fi

exec bun run src/server.ts
