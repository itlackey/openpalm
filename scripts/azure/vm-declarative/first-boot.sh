#!/usr/bin/env bash
# first-boot.sh — Runs once via cloud-init.
# Installs Docker, decodes the setup spec, runs `openpalm install`.

set -euo pipefail
exec > >(tee -a /var/log/openpalm-bootstrap.log) 2>&1
echo "[openpalm] started at $(date -u)"

source /etc/openpalm/config

# Wait for apt locks
for _ in $(seq 1 60); do
  fuser /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break
  sleep 3
done

# Install Docker
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
usermod -aG docker "$ADMIN_USER"
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done

# Decode spec and install
base64 -d /var/lib/openpalm/setup-spec.b64 > /var/lib/openpalm/setup-spec.yaml
rm -f /var/lib/openpalm/setup-spec.b64
chown "$ADMIN_USER":"$ADMIN_USER" /var/lib/openpalm /var/lib/openpalm/setup-spec.yaml
chmod 600 /var/lib/openpalm/setup-spec.yaml

SETUP_URL="https://raw.githubusercontent.com/itlackey/openpalm/${SETUP_REF}/scripts/setup.sh"
mkdir -p "$OP_INSTALL_DIR"
chown -R "$ADMIN_USER":"$ADMIN_USER" "$(dirname "$OP_INSTALL_DIR")"

sudo -u "$ADMIN_USER" -H env OP_INSTALL_DIR="$OP_INSTALL_DIR" OP_HOME="$OP_HOME" \
  bash -c "curl -fsSL ${SETUP_URL} | bash -s -- --version ${OP_VERSION} --force --no-open --file /var/lib/openpalm/setup-spec.yaml"

# Install Azure CLI (for backup cron, not critical path)
curl -sL https://aka.ms/InstallAzureCLIDeb | bash

echo "0 3 * * * root /usr/local/bin/openpalm-backup.sh" > /etc/cron.d/openpalm-backup
chmod 644 /etc/cron.d/openpalm-backup

echo "[openpalm] done at $(date -u)"
