#!/usr/bin/env bash
set -euo pipefail
runtime="${OPENPALM_RUNTIME_DIR:-/tmp/openpalm-runtime}"
for child in assistant scheduler reconciliation; do
  test -s "$runtime/$child.pid"
  kill -0 "$(cat "$runtime/$child.pid")" 2>/dev/null
done
test -s "$runtime/tasks-synced"
now=$(date +%s)
synced=$(cat "$runtime/tasks-synced")
test "$((now - synced))" -lt 180
password_file="${OPENCODE_SERVER_PASSWORD_FILE:-/run/secrets/opencode_server_password}"
test -s "$password_file"
curl -sf -u "opencode:$(tr -d '\r\n' <"$password_file")" \
  "http://127.0.0.1:${OPENCODE_PORT:-4096}/config" >/dev/null
