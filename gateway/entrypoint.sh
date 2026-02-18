#!/usr/bin/env bash
set -euo pipefail

CHANNEL_CONFIG_DIR="${OPENCODE_CHANNEL_CONFIGURATION_DIRECTORY:-/app/opencode-channel-config}"
CHANNEL_STATE_DIR="${OPENCODE_CHANNEL_STATE_DIRECTORY:-/app/opencode-channel-state}"
CHANNEL_PORT="${OPENCODE_CHANNEL_PORT:-4097}"

mkdir -p "$CHANNEL_CONFIG_DIR" "$CHANNEL_STATE_DIR"

[[ -f "$CHANNEL_CONFIG_DIR/opencode.channel.jsonc" ]] || cp /opt/opencode-channel-defaults/opencode.channel.jsonc "$CHANNEL_CONFIG_DIR/opencode.channel.jsonc"
[[ -f "$CHANNEL_CONFIG_DIR/AGENTS.md" ]] || cp /opt/opencode-channel-defaults/AGENTS.md "$CHANNEL_CONFIG_DIR/AGENTS.md"
[[ -d "$CHANNEL_CONFIG_DIR/skills" ]] || cp -r /opt/opencode-channel-defaults/skills "$CHANNEL_CONFIG_DIR/skills"
[[ -d "$CHANNEL_CONFIG_DIR/.opencode" ]] || cp -r /opt/opencode-channel-defaults/.opencode "$CHANNEL_CONFIG_DIR/.opencode"

OPENCODE_CONFIGURATION_DIRECTORY="$CHANNEL_CONFIG_DIR" \
OPENCODE_CONFIG="${OPENCODE_CHANNEL_CONFIG:-$CHANNEL_CONFIG_DIR/opencode.channel.jsonc}" \
OPENCODE_STATE_DIRECTORY="$CHANNEL_STATE_DIR" \
opencode serve --hostname 127.0.0.1 --port "$CHANNEL_PORT" >/tmp/opencode-channel.log 2>&1 &
channel_pid=$!

cleanup() {
  kill "$channel_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

exec bun run src/server.ts
