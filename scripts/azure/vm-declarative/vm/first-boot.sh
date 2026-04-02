#!/usr/bin/env bash
# first-boot.sh — Runs once via cloud-init.
# Installs Docker, fetches secrets from Key Vault, runs `openpalm install`.

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

# Decode setup spec from cloud-init (no secrets in spec)
mkdir -p /var/lib/openpalm
base64 -d /var/lib/openpalm/setup-spec.b64 > /var/lib/openpalm/setup-spec.yaml
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

# Install with --no-start: sets up config, pulls images, but doesn't start containers.
# We need to fix volume mount ownership before starting.
sudo -u "$ADMIN_USER" -H bash -c "
  set -a; source ${SECRETS_FILE}; set +a
  export OP_INSTALL_DIR='${OP_INSTALL_DIR}' OP_HOME='${OP_HOME}'
  curl -fsSL ${SETUP_URL} | bash -s -- --version ${OP_VERSION} --force --no-open --no-start --file /var/lib/openpalm/setup-spec.yaml
"
rm -f "$SECRETS_FILE"

# Start the stack via compose. First run may fail because the init container
# creates volume mount subdirs as root, and the assistant (UID 1000) can't write.
# Fix ownership and retry.
COMPOSE_ARGS="-f ${OP_HOME}/stack/core.compose.yml --project-name openpalm"
ENV_ARGS="--env-file ${OP_HOME}/vault/stack/stack.env --env-file ${OP_HOME}/vault/user/user.env --env-file ${OP_HOME}/vault/stack/guardian.env"

sudo -u "$ADMIN_USER" docker compose $COMPOSE_ARGS $ENV_ARGS pull
sudo -u "$ADMIN_USER" docker compose $COMPOSE_ARGS $ENV_ARGS up -d || true

chown -R "$ADMIN_USER":"$ADMIN_USER" "${OP_HOME}/data"

sudo -u "$ADMIN_USER" docker compose $COMPOSE_ARGS $ENV_ARGS up -d

# ── Guardian compose override (expose on loopback for Caddy) ─────────
# Guardian has no host port in core.compose.yml. Create an override so
# Caddy (running on the host) can reach it at 127.0.0.1:3899.
GUARDIAN_OVERRIDE="${OP_HOME}/stack/guardian-port.compose.yml"
cat > "$GUARDIAN_OVERRIDE" <<'GOVR'
services:
  guardian:
    ports:
      - "127.0.0.1:3899:8080"
GOVR
chown "$ADMIN_USER":"$ADMIN_USER" "$GUARDIAN_OVERRIDE"

# Restart compose with the guardian override included
COMPOSE_ARGS="-f ${OP_HOME}/stack/core.compose.yml -f ${GUARDIAN_OVERRIDE} --project-name openpalm"
sudo -u "$ADMIN_USER" docker compose $COMPOSE_ARGS $ENV_ARGS up -d
echo "[openpalm] guardian exposed on 127.0.0.1:3899"

# ── Caddy reverse proxy (optional — only if FQDNs are configured) ────
CADDY_NEEDED=false
[[ -n "${CADDY_GUARDIAN_FQDN:-}" || -n "${CADDY_ADMIN_FQDN:-}" || -n "${CADDY_ASSISTANT_FQDN:-}" ]] && CADDY_NEEDED=true

if $CADDY_NEEDED; then
  echo "[openpalm] installing Caddy..."
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy

  # Build Caddyfile from configured FQDNs
  CADDYFILE=/etc/caddy/Caddyfile
  cat > "$CADDYFILE" <<CADDYHEAD
# Auto-generated by openpalm first-boot.sh
# Caddy obtains Let's Encrypt certs automatically for each FQDN.
CADDYHEAD

  # Global email for Let's Encrypt notifications
  if [[ -n "${CADDY_EMAIL:-}" ]]; then
    cat >> "$CADDYFILE" <<CADDY_GLOBAL
{
  email ${CADDY_EMAIL}
}

CADDY_GLOBAL
  fi

  if [[ -n "${CADDY_GUARDIAN_FQDN:-}" ]]; then
    cat >> "$CADDYFILE" <<CADDY_GUARDIAN

${CADDY_GUARDIAN_FQDN} {
  reverse_proxy 127.0.0.1:3899
}
CADDY_GUARDIAN
    echo "[openpalm] Caddy: ${CADDY_GUARDIAN_FQDN} → guardian (127.0.0.1:3899)"
  fi

  if [[ -n "${CADDY_ADMIN_FQDN:-}" ]]; then
    cat >> "$CADDYFILE" <<CADDY_ADMIN

${CADDY_ADMIN_FQDN} {
  reverse_proxy 127.0.0.1:3880
}
CADDY_ADMIN
    echo "[openpalm] Caddy: ${CADDY_ADMIN_FQDN} → admin (127.0.0.1:3880)"
  fi

  if [[ -n "${CADDY_ASSISTANT_FQDN:-}" ]]; then
    cat >> "$CADDYFILE" <<CADDY_ASSISTANT

${CADDY_ASSISTANT_FQDN} {
  reverse_proxy 127.0.0.1:3800
}
CADDY_ASSISTANT
    echo "[openpalm] Caddy: ${CADDY_ASSISTANT_FQDN} → assistant (127.0.0.1:3800)"
  fi

  systemctl enable --now caddy
  echo "[openpalm] Caddy enabled and started"
else
  echo "[openpalm] no CADDY_*_FQDN set — skipping Caddy install"
fi

# Install Azure CLI (for backup cron, not critical path)
curl -sL https://aka.ms/InstallAzureCLIDeb | bash

echo "0 3 * * * root /usr/local/bin/openpalm-backup.sh" > /etc/cron.d/openpalm-backup
chmod 644 /etc/cron.d/openpalm-backup

echo "[openpalm] done at $(date -u)"
