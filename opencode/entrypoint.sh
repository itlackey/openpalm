#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${OPENCODE_CONFIGURATION_DIRECTORY:-/config}"
CRON_DIR="${CRON_DIR:-/cron}"
PORT="${OPENCODE_PORT:-4096}"
ENABLE_SSH="${OPENCODE_ENABLE_SSH:-0}"

mkdir -p "$CONFIG_DIR"
mkdir -p "$CRON_DIR"

# Extensions (plugins, skills, lib, AGENTS.md) are mounted from the host
# config directory — they are NOT baked into the image.  The installer seeds
# default extensions from assets/config/opencode/ into the host config
# home at install time, and docker-compose mounts that directory here.
if [[ ! -f "$CONFIG_DIR/opencode.jsonc" ]]; then
  echo "ERROR: $CONFIG_DIR/opencode.jsonc not found."
  echo "The opencode config directory must be volume-mounted from the host."
  echo "Run the installer or seed assets/config/opencode/ into the host config home."
  exit 1
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

exec opencode web --hostname 0.0.0.0 --port "$PORT"
