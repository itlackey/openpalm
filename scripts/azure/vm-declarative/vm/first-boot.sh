#!/usr/bin/env bash
# first-boot.sh — Runs once via cloud-init.
# Installs Docker, fetches secrets from Key Vault, runs `openpalm install`.

set -euo pipefail
exec > >(tee -a /var/log/openpalm-bootstrap.log) 2>&1
echo "[openpalm] started at $(date -u)"

source /etc/openpalm/config

# ── Helpers ──────────────────────────────────────────────────────────

# Fetch a secret from Key Vault using the VM's managed identity.
# Usage: fetch_kv_secret <secret-name> [max-attempts]
# Prints the secret value to stdout. Returns 1 on failure.
fetch_kv_secret() {
  local secret_name=$1 max=${2:-30} token="" value=""
  for attempt in $(seq 1 "$max"); do
    token="$(curl -sf \
      'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net' \
      -H 'Metadata: true' | jq -r '.access_token')" || true
    if [[ -n "${token:-}" && "$token" != "null" ]]; then
      value="$(curl -sf \
        "https://${VAULT_NAME}.vault.azure.net/secrets/${secret_name}?api-version=7.4" \
        -H "Authorization: Bearer ${token}" | jq -r '.value')" || true
      if [[ -n "${value:-}" && "$value" != "null" ]]; then
        printf '%s' "$value"
        return 0
      fi
    fi
    echo "[openpalm] waiting for KV secret '${secret_name}' (attempt ${attempt}/${max})..." >&2
    sleep 10
  done
  return 1
}

# Append a Caddy reverse_proxy block to the Caddyfile.
# Usage: add_caddy_site <fqdn> <port> <service-name>
add_caddy_site() {
  local fqdn=$1 port=$2 name=$3
  [[ -n "$fqdn" ]] || return 0
  cat >> "$CADDYFILE" <<CADDY_SITE

${fqdn} {
  reverse_proxy 127.0.0.1:${port}
}
CADDY_SITE
  echo "[openpalm] Caddy: ${fqdn} → ${name} (127.0.0.1:${port})"
}

# ── Install Docker ───────────────────────────────────────────────────

for _ in $(seq 1 60); do
  fuser /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break
  sleep 3
done

curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
usermod -aG docker "$ADMIN_USER"
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done

# ── Decode spec, fetch secrets ───────────────────────────────────────

mkdir -p /var/lib/openpalm
base64 -d /var/lib/openpalm/setup-spec.b64 > /var/lib/openpalm/setup-spec.yaml
rm -f /var/lib/openpalm/setup-spec.b64
echo "[openpalm] setup spec decoded"

echo "[openpalm] fetching secrets from Key Vault: ${VAULT_NAME}"
SECRETS_FILE=/var/lib/openpalm/secrets.env
fetch_kv_secret "secrets" 30 > "$SECRETS_FILE" || {
  echo "[openpalm] FATAL: could not fetch secrets from Key Vault" >&2; exit 1
}
chmod 600 "$SECRETS_FILE"
echo "[openpalm] secrets fetched"

chown "$ADMIN_USER":"$ADMIN_USER" /var/lib/openpalm /var/lib/openpalm/setup-spec.yaml "$SECRETS_FILE"

# ── Install OpenPalm (--no-start) ───────────────────────────────────

SETUP_URL="https://raw.githubusercontent.com/itlackey/openpalm/${SETUP_REF}/scripts/setup.sh"
mkdir -p "$OP_INSTALL_DIR"
chown -R "$ADMIN_USER":"$ADMIN_USER" "$(dirname "$OP_INSTALL_DIR")"

# Pre-create OP_HOME so Docker doesn't create mount targets as root.
mkdir -p "${OP_HOME}"
for d in data/assistant/.cache data/assistant/.config data/assistant/.local data/assistant/.bun data/assistant/.akm; do
  mkdir -p "${OP_HOME}/${d}"
done
chown -R "$ADMIN_USER":"$ADMIN_USER" "${OP_HOME}"

sudo -u "$ADMIN_USER" -H bash -c "
  set -a; source ${SECRETS_FILE}; set +a
  export OP_INSTALL_DIR='${OP_INSTALL_DIR}' OP_HOME='${OP_HOME}'
  curl -fsSL ${SETUP_URL} | bash -s -- --version ${OP_VERSION} --force --no-open --no-start --file /var/lib/openpalm/setup-spec.yaml
"
rm -f "$SECRETS_FILE"

# ── Foundry: patch stack.env BEFORE starting compose ─────────────────
# Re-source config — deploy.sh may have patched FOUNDRY_ENDPOINT after
# cloud-init wrote the file.
source /etc/openpalm/config

if [[ -n "${FOUNDRY_ENDPOINT:-}" ]]; then
  echo "[openpalm] configuring AI Foundry: ${FOUNDRY_ENDPOINT}"

  FOUNDRY_API_KEY="$(fetch_kv_secret "azure-ai-foundry-api-key" 15)" || true
  if [[ -z "${FOUNDRY_API_KEY:-}" ]]; then
    echo "[openpalm] WARNING: could not fetch Foundry API key — skipping" >&2
  else
    STACK_ENV="${OP_HOME}/vault/stack/stack.env"
    cat >> "$STACK_ENV" <<FOUNDRY_ENV

# Azure AI Foundry (auto-configured by first-boot.sh)
OP_CAP_LLM_PROVIDER=azure_openai
OP_CAP_LLM_MODEL=${FOUNDRY_LLM_DEPLOYMENT}
OP_CAP_LLM_BASE_URL=${FOUNDRY_ENDPOINT}
OP_CAP_LLM_API_KEY=${FOUNDRY_API_KEY}
OP_CAP_EMBEDDINGS_PROVIDER=azure_openai
OP_CAP_EMBEDDINGS_MODEL=${FOUNDRY_EMBEDDING_DEPLOYMENT}
OP_CAP_EMBEDDINGS_BASE_URL=${FOUNDRY_ENDPOINT}
OP_CAP_EMBEDDINGS_API_KEY=${FOUNDRY_API_KEY}
OP_CAP_EMBEDDINGS_DIMS=${FOUNDRY_EMBEDDING_DIMS}
FOUNDRY_ENV
    echo "[openpalm] stack.env patched with Foundry capabilities"

    OPENCODE_CONFIG="${OP_HOME}/config/assistant/opencode.json"
    OPENCODE_TMP="$(mktemp)"
    jq --arg endpoint "$FOUNDRY_ENDPOINT" \
       --arg apiKey "$FOUNDRY_API_KEY" \
       --arg llm "$FOUNDRY_LLM_DEPLOYMENT" \
       --arg slm "$FOUNDRY_SLM_DEPLOYMENT" \
    '. + {
      "provider": (.provider // {} | . + {
        "azure-foundry": {
          "name": "Azure AI Foundry",
          "options": {
            "apiKey": $apiKey,
            "baseURL": ($endpoint + "openai"),
            "headers": { "api-key": $apiKey }
          },
          "models": {
            ($llm): { "name": ("GPT " + ($llm | gsub("-"; " "))) },
            ($slm): { "name": ("GPT " + ($slm | gsub("-"; " "))) }
          }
        }
      })
    }' "$OPENCODE_CONFIG" > "$OPENCODE_TMP"
    mv "$OPENCODE_TMP" "$OPENCODE_CONFIG"
    chown "$ADMIN_USER":"$ADMIN_USER" "$OPENCODE_CONFIG"
    echo "[openpalm] opencode.json patched with azure-foundry provider"
  fi
fi

# ── Guardian compose override (expose on loopback) ───────────────────
# Guardian has no host port in core.compose.yml; Caddy needs access.
GUARDIAN_OVERRIDE="${OP_HOME}/stack/guardian-port.compose.yml"
cat > "$GUARDIAN_OVERRIDE" <<'GOVR'
services:
  guardian:
    ports:
      - "127.0.0.1:3899:8080"
GOVR
chown "$ADMIN_USER":"$ADMIN_USER" "$GUARDIAN_OVERRIDE"

# ── Start the stack (single start, includes guardian override) ───────
COMPOSE_ARGS="-f ${OP_HOME}/stack/core.compose.yml -f ${GUARDIAN_OVERRIDE} --project-name openpalm"
ENV_ARGS="--env-file ${OP_HOME}/vault/stack/stack.env --env-file ${OP_HOME}/vault/user/user.env --env-file ${OP_HOME}/vault/stack/guardian.env"

sudo -u "$ADMIN_USER" docker compose $COMPOSE_ARGS $ENV_ARGS pull
sudo -u "$ADMIN_USER" docker compose $COMPOSE_ARGS $ENV_ARGS up -d || true

# First run may fail because init creates dirs as root. Fix and retry.
chown -R "$ADMIN_USER":"$ADMIN_USER" "${OP_HOME}/data"
sudo -u "$ADMIN_USER" docker compose $COMPOSE_ARGS $ENV_ARGS up -d

# ── Caddy reverse proxy (optional) ──────────────────────────────────

if [[ -n "${CADDY_GUARDIAN_FQDN:-}" || -n "${CADDY_ADMIN_FQDN:-}" || -n "${CADDY_ASSISTANT_FQDN:-}" ]]; then
  echo "[openpalm] installing Caddy..."
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy

  CADDYFILE=/etc/caddy/Caddyfile
  : > "$CADDYFILE"

  if [[ -n "${CADDY_EMAIL:-}" ]]; then
    cat >> "$CADDYFILE" <<CADDY_GLOBAL
{
  email ${CADDY_EMAIL}
}
CADDY_GLOBAL
  fi

  add_caddy_site "${CADDY_GUARDIAN_FQDN:-}" 3899 guardian
  add_caddy_site "${CADDY_ADMIN_FQDN:-}" 3880 admin
  add_caddy_site "${CADDY_ASSISTANT_FQDN:-}" 3800 assistant

  systemctl enable --now caddy
  echo "[openpalm] Caddy started"
fi

# ── Backup cron + Azure CLI ──────────────────────────────────────────

curl -sL https://aka.ms/InstallAzureCLIDeb | bash
echo "0 3 * * * root /usr/local/bin/openpalm-backup.sh" > /etc/cron.d/openpalm-backup
chmod 644 /etc/cron.d/openpalm-backup

echo "[openpalm] done at $(date -u)"
