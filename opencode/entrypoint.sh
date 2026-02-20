#!/usr/bin/env bash
set -euo pipefail

# OpenPalm no longer copies/merges OpenCode config into a generated /config volume.
# User-global config/plugins/cache/auth are persisted via mounted HOME.
# Core OpenPalm-managed extensions are baked into /opt/opencode and loaded through
# OPENCODE_CONFIG_DIR=/opt/opencode from compose.
CRON_DIR="${CRON_DIR:-/cron}"
PORT="${OPENCODE_PORT:-4096}"
ENABLE_SSH="${OPENCODE_ENABLE_SSH:-0}"

mkdir -p "$CRON_DIR"
mkdir -p "$CRON_DIR/cron-payloads"

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
  SSH_DIR="${SSH_DIR:-/home/opencode/.config/opencode/ssh}"
  mkdir -p "$SSH_DIR" /run/sshd /root/.ssh
  [[ -f "$SSH_DIR/authorized_keys" ]] || touch "$SSH_DIR/authorized_keys"
  cp "$SSH_DIR/authorized_keys" /root/.ssh/authorized_keys
  chmod 700 /root/.ssh
  chmod 600 /root/.ssh/authorized_keys
  cat > /etc/ssh/sshd_config.d/opencode.conf <<'SSHEOF'
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
SSHEOF
  /usr/sbin/sshd
fi

cd /work

exec opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs
