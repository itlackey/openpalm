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

# Decode setup spec template from cloud-init
mkdir -p /var/lib/openpalm
base64 -d /var/lib/openpalm/setup-spec.b64 > /var/lib/openpalm/setup-spec.tpl
rm -f /var/lib/openpalm/setup-spec.b64
echo "[openpalm] setup spec decoded"

# Fetch secrets from Key Vault via managed identity
echo "[openpalm] fetching secrets from Key Vault: ${VAULT_NAME}"
SECRETS_FILE=/var/lib/openpalm/secrets.env
for attempt in $(seq 1 30); do
  TOKEN="$(curl -sf \
    'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net' \
    -H 'Metadata: true' | jq -r '.access_token')" || true
  if [[ -n "${TOKEN:-}" && "$TOKEN" != "null" ]]; then
    SECRETS="$(curl -sf \
      "https://${VAULT_NAME}.vault.azure.net/secrets/secrets?api-version=7.4" \
      -H "Authorization: Bearer ${TOKEN}" | jq -r '.value')" || true
    if [[ -n "${SECRETS:-}" && "$SECRETS" != "null" ]]; then
      printf '%s\n' "$SECRETS" > "$SECRETS_FILE"
      chmod 600 "$SECRETS_FILE"
      echo "[openpalm] secrets fetched"
      break
    fi
  fi
  echo "[openpalm] waiting for Key Vault access (attempt ${attempt}/30)..."
  sleep 10
done
[[ -f "$SECRETS_FILE" ]] || { echo "[openpalm] FATAL: could not fetch secrets from Key Vault" >&2; exit 1; }

# Resolve secrets into spec and source into env for the install
set -a; source "$SECRETS_FILE"; set +a
envsubst < /var/lib/openpalm/setup-spec.tpl > /var/lib/openpalm/setup-spec.yaml
rm -f /var/lib/openpalm/setup-spec.tpl
chown "$ADMIN_USER":"$ADMIN_USER" /var/lib/openpalm /var/lib/openpalm/setup-spec.yaml "$SECRETS_FILE"

SETUP_URL="https://raw.githubusercontent.com/itlackey/openpalm/${SETUP_REF}/scripts/setup.sh"
mkdir -p "$OP_INSTALL_DIR"
chown -R "$ADMIN_USER":"$ADMIN_USER" "$(dirname "$OP_INSTALL_DIR")"

# Pre-create OP_HOME owned by admin user. Docker creates missing
# mount targets as root, causing EACCES inside non-root containers.
mkdir -p "${OP_HOME}"
for d in data/assistant/.cache data/assistant/.config data/assistant/.local data/assistant/.bun data/assistant/.akm; do
  mkdir -p "${OP_HOME}/${d}"
done
chown -R "$ADMIN_USER":"$ADMIN_USER" "${OP_HOME}"

sudo -u "$ADMIN_USER" -H bash -c "
  set -a; source ${SECRETS_FILE}; set +a
  export OP_INSTALL_DIR='${OP_INSTALL_DIR}' OP_HOME='${OP_HOME}'
  curl -fsSL ${SETUP_URL} | bash -s -- --version ${OP_VERSION} --force --no-open --file /var/lib/openpalm/setup-spec.yaml
"
rm -f "$SECRETS_FILE"

# Fix: released CLI writes API key placeholders to user.env which override
# real values in stack.env. Remove them so compose picks up stack.env values.
USER_ENV="${OP_HOME}/vault/user/user.env"
if [[ -f "$USER_ENV" ]] && grep -q '^export OPENAI_API_KEY=$' "$USER_ENV"; then
  echo "[openpalm] cleaning user.env API key placeholders"
  sed -i '/^export [A-Z_]*_API_KEY=$/d; /^export OPENAI_BASE_URL=$/d; /^export MEMORY_USER_ID=/d' "$USER_ENV"
  chown "$ADMIN_USER":"$ADMIN_USER" "$USER_ENV"
fi

# Install Azure CLI (for backup cron, not critical path)
curl -sL https://aka.ms/InstallAzureCLIDeb | bash

echo "0 3 * * * root /usr/local/bin/openpalm-backup.sh" > /etc/cron.d/openpalm-backup
chmod 644 /etc/cron.d/openpalm-backup

echo "[openpalm] done at $(date -u)"
