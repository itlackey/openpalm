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

# Fetch setup spec from Key Vault via managed identity (retries until access policy propagates)
mkdir -p /var/lib/openpalm
echo "[openpalm] fetching setup spec from Key Vault: ${VAULT_NAME}"
for attempt in $(seq 1 30); do
  TOKEN="$(curl -sf \
    'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net' \
    -H 'Metadata: true' | jq -r '.access_token')" || true
  if [[ -n "${TOKEN:-}" && "$TOKEN" != "null" ]]; then
    SPEC="$(curl -sf \
      "https://${VAULT_NAME}.vault.azure.net/secrets/setup-spec?api-version=7.4" \
      -H "Authorization: Bearer ${TOKEN}" | jq -r '.value')" || true
    if [[ -n "${SPEC:-}" && "$SPEC" != "null" ]]; then
      printf '%s' "$SPEC" > /var/lib/openpalm/setup-spec.yaml
      echo "[openpalm] setup spec retrieved"
      break
    fi
  fi
  echo "[openpalm] waiting for Key Vault access (attempt ${attempt}/30)..."
  sleep 10
done
[[ -f /var/lib/openpalm/setup-spec.yaml ]] || { echo "[openpalm] FATAL: could not fetch setup spec from Key Vault" >&2; exit 1; }
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
