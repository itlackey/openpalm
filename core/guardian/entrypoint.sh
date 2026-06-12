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

if [[ "$enabled" == "1" && "${GUARDIAN_SERVICE_MODE:-gateway}" == "gateway" ]]; then
  port="${GUARDIAN_MODERATION_PORT:-4097}"
  log_dir="${HOME:-/opt/openpalm/guardian}"
  echo "[guardian] starting OpenCode moderator on 127.0.0.1:${port}"
  # Loopback only, auth disabled (reachable only from inside this container),
  # config from /etc/opencode (bind-mounted config/guardian). Backgrounded so
  # the guardian server starts regardless; if the moderator is down, escalated
  # messages fail closed.
  # --print-logs so the moderator's OpenCode logs go to this container's stderr
  # (docker logs) for observability, prefixed so they're distinguishable from the
  # guardian server's own structured logs. (Default is a log FILE, invisible to
  # `docker logs`.)
  OPENCODE_AUTH=false \
  OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-/etc/opencode}" \
    opencode serve --hostname 127.0.0.1 --port "${port}" \
    --print-logs --log-level INFO 2>&1 | sed -u 's/^/[moderator] /' >&2 &
fi

if [[ "${GUARDIAN_SERVICE_MODE:-gateway}" == "openai-api" ]]; then
  exec bun run src/openai-api-server.ts
fi

exec bun run src/server.ts
