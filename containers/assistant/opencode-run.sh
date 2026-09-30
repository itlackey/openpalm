#!/usr/bin/env bash
set -euo pipefail
# AKM intentionally strips non-allowlisted environment variables before
# launching agent engines. Load only the local native-API password here;
# provider credentials remain entirely owned by the running OpenCode server.
file=/run/secrets/opencode_server_password
if [ ! -s "$file" ]; then
  echo 'assistant: scheduled OpenCode invocation requires its native API password' >&2
  exit 1
fi
OPENCODE_SERVER_PASSWORD="$(tr -d '\r\n' <"$file")"
export OPENCODE_SERVER_PASSWORD
export OPENCODE_SERVER_USERNAME=opencode
exec opencode "$@"
