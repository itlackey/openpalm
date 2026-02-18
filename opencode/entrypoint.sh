#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${OPENCODE_CONFIGURATION_DIRECTORY:-/config}"
PORT="${OPENCODE_PORT:-4096}"

mkdir -p "$CONFIG_DIR"

# Seed core defaults once into the user-managed configuration directory.
[[ -f "$CONFIG_DIR/opencode.jsonc" ]] || cp /opt/opencode-defaults/opencode.jsonc "$CONFIG_DIR/opencode.jsonc"
DEFAULT_CONFIG="$CONFIG_DIR/opencode.jsonc"

[[ -f "$CONFIG_DIR/AGENTS.md" ]] || cp /opt/opencode-defaults/AGENTS.md "$CONFIG_DIR/AGENTS.md"
[[ -d "$CONFIG_DIR/skills" ]] || cp -r /opt/opencode-defaults/skills "$CONFIG_DIR/skills"
[[ -d "$CONFIG_DIR/.opencode" ]] || cp -r /opt/opencode-defaults/.opencode "$CONFIG_DIR/.opencode"

export OPENCODE_CONFIG="${OPENCODE_CONFIG:-$DEFAULT_CONFIG}"

# Install crontab managed by admin-app (if present) and start cron daemon.
if [[ -f "$CONFIG_DIR/crontab" ]]; then
  crontab "$CONFIG_DIR/crontab"
  echo "crontab installed from $CONFIG_DIR/crontab"
else
  # Ensure empty crontab so cron starts cleanly
  echo "" | crontab -
fi
cron

exec opencode serve --hostname 0.0.0.0 --port "$PORT"
