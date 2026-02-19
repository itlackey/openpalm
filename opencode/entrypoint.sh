#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-/config}"
CRON_DIR="${CRON_DIR:-/cron}"
PORT="${OPENCODE_PORT:-4096}"
ENABLE_SSH="${OPENCODE_ENABLE_SSH:-0}"

mkdir -p "$CONFIG_DIR"
mkdir -p "$CRON_DIR"
mkdir -p "$CRON_DIR/cron-payloads"

# Default extensions are baked into the image at /opt/openpalm/opencode-defaults/.
# If a host config volume is mounted at /config, it takes priority.
# If /config is empty or missing opencode.jsonc, fall back to the baked-in defaults.
BAKED_IN_DIR="/opt/openpalm/opencode-defaults"

# Always merge baked-in extension directories into the active config dir.
# cp -rn copies without overwriting, so host overrides are preserved.
if [[ -d "$BAKED_IN_DIR" ]]; then
  for item in "$BAKED_IN_DIR"/*/; do
    [[ -d "$item" ]] && cp -rn "$item" "$CONFIG_DIR/" 2>/dev/null || true
  done
  # Copy non-config files (AGENTS.md, etc.)
  for file in "$BAKED_IN_DIR"/*.md; do
    [[ -f "$file" ]] && cp -n "$file" "$CONFIG_DIR/" 2>/dev/null || true
  done
fi

# Only copy opencode.jsonc when it's completely absent.
if [[ ! -f "$CONFIG_DIR/opencode.jsonc" ]]; then
  if [[ -f "$BAKED_IN_DIR/opencode.jsonc" ]]; then
    echo "No volume-mounted config found at $CONFIG_DIR; copying baked-in opencode.jsonc."
    cp "$BAKED_IN_DIR/opencode.jsonc" "$CONFIG_DIR/opencode.jsonc"
  else
    echo "ERROR: No opencode.jsonc found at $CONFIG_DIR or $BAKED_IN_DIR."
    exit 1
  fi
fi

# Tell OpenCode where the config file lives.
export OPENCODE_CONFIG="${OPENCODE_CONFIG:-$CONFIG_DIR/opencode.jsonc}"

# Tell OpenCode where to discover plugins, skills, agents, etc.
# OPENCODE_CONFIG_DIR is searched the same way as .opencode/ — it looks for
# plugins/, skills/, agents/, commands/, tools/, modes/, and themes/ subdirs.
export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$CONFIG_DIR}"

# Install crontab managed by admin (if present) and start cron daemon.
if [[ -f "$CRON_DIR/crontab" ]]; then
  crontab "$CRON_DIR/crontab"
  echo "crontab installed from $CRON_DIR/crontab"
else
  # Ensure empty crontab so cron starts cleanly
  echo "" | crontab -
fi
cron

if [[ "$ENABLE_SSH" == "1" ]]; then
  SSH_DIR="$CONFIG_DIR/ssh"
  mkdir -p "$SSH_DIR" /run/sshd /root/.ssh
  [[ -f "$SSH_DIR/authorized_keys" ]] || touch "$SSH_DIR/authorized_keys"
  cp "$SSH_DIR/authorized_keys" /root/.ssh/authorized_keys
  chmod 700 /root/.ssh
  chmod 600 /root/.ssh/authorized_keys
  cat > /etc/ssh/sshd_config.d/opencode.conf <<'EOF'
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
  /usr/sbin/sshd
fi

cd /work
export HOME=/work

exec opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs
