#!/usr/bin/env bash
# first-boot.sh — Runs once via cloud-init.
# Installs Docker, fetches secrets from Key Vault, runs `openpalm install`.
# Mounts Azure file share, creates Azure AI Foundry proxy for assistant.

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

# Install cifs-utils for Azure file share mount
apt-get install -y -qq cifs-utils >/dev/null 2>&1

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

# Extract Azure AI Foundry key from secrets for file share mount and proxy
AZURE_OPENAI_KEY="$(grep '^AZURE_OPENAI_API_KEY=' "$SECRETS_FILE" | cut -d= -f2- || true)"

chown "$ADMIN_USER":"$ADMIN_USER" /var/lib/openpalm /var/lib/openpalm/setup-spec.yaml "$SECRETS_FILE"

# ── Mount Azure file share ──────────────────────────────────────────────
# The data share is mounted on the host and bind-mounted into containers
# via fileshare.compose.yml. Used for shared data between host and containers.

if [[ -n "${DATA_SHARE:-}" && -n "${STORAGE_NAME:-}" ]]; then
  echo "[openpalm] mounting Azure file share: ${DATA_SHARE}"
  MOUNT_POINT="/mnt/openpalm"
  CRED_FILE="/etc/smbcredentials/${STORAGE_NAME}.cred"

  # Get storage account key via managed identity
  STORAGE_TOKEN="$(curl -sf \
    'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fmanagement.azure.com' \
    -H 'Metadata: true' | jq -r '.access_token')" || true

  SUB_ID="$(curl -sf 'http://169.254.169.254/metadata/instance?api-version=2021-02-01' \
    -H 'Metadata: true' | jq -r '.compute.subscriptionId')" || true
  RG="$(curl -sf 'http://169.254.169.254/metadata/instance?api-version=2021-02-01' \
    -H 'Metadata: true' | jq -r '.compute.resourceGroupName')" || true

  STORAGE_KEY="$(curl -sf -X POST \
    "https://management.azure.com/subscriptions/${SUB_ID}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/${STORAGE_NAME}/listKeys?api-version=2023-05-01" \
    -H "Authorization: Bearer ${STORAGE_TOKEN}" \
    -H 'Content-Length: 0' | jq -r '.keys[0].value')" || true

  if [[ -n "${STORAGE_KEY:-}" && "$STORAGE_KEY" != "null" ]]; then
    mkdir -p "$MOUNT_POINT" /etc/smbcredentials
    printf 'username=%s\npassword=%s\n' "$STORAGE_NAME" "$STORAGE_KEY" > "$CRED_FILE"
    chmod 600 "$CRED_FILE"

    FSTAB_ENTRY="//${STORAGE_NAME}.file.core.windows.net/${DATA_SHARE} ${MOUNT_POINT} cifs nofail,credentials=${CRED_FILE},dir_mode=0777,file_mode=0777,serverino,nosharesock,actimeo=30"
    grep -qF "${STORAGE_NAME}.file.core.windows.net/${DATA_SHARE}" /etc/fstab || echo "$FSTAB_ENTRY" >> /etc/fstab
    mount -a
    echo "[openpalm] file share mounted at ${MOUNT_POINT}"
  else
    echo "[openpalm] WARNING: could not get storage key, skipping file share mount"
  fi
fi

# ── Install OpenPalm ────────────────────────────────────────────────────

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

# ── Azure AI Foundry proxy ──────────────────────────────────────────────
# OpenCode's built-in Azure provider doesn't support the Responses API,
# and @ai-sdk/openai-compatible can't add ?api-version= to requests.
# This lightweight Bun proxy runs inside the assistant container, adds
# the required api-version query param, rewrites max_tokens to
# max_completion_tokens, and strips unsupported params.

if [[ -n "${AZURE_RESOURCE:-}" && -n "${AZURE_OPENAI_KEY:-}" ]]; then
  AZURE_BASE="https://${AZURE_RESOURCE}.openai.azure.com"
  echo "[openpalm] creating Azure AI Foundry proxy and OpenCode config"

  # Write proxy script to workspace (mounted at /work in assistant)
  cat > "${OP_HOME}/data/workspace/azure-proxy.ts" <<'PROXY_EOF'
const AZURE_BASE = Bun.env.AZURE_PROXY_BASE || "";
const API_VERSION = "2024-10-21";
const API_KEY = Bun.env.AZURE_PROXY_KEY || "";
const STRIP_PARAMS = ["reasoningSummary", "reasoning_summary"];

Bun.serve({
  port: 7200,
  hostname: "127.0.0.1",
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const target = AZURE_BASE + url.pathname + "?api-version=" + API_VERSION;
    const headers = new Headers(req.headers);
    headers.set("api-key", API_KEY);
    headers.delete("host");
    headers.delete("authorization");

    let body: BodyInit | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      try {
        const json = await req.json() as Record<string, unknown>;
        for (const param of STRIP_PARAMS) delete json[param];
        if ("max_tokens" in json) {
          json["max_completion_tokens"] = json["max_tokens"];
          delete json["max_tokens"];
        }
        body = JSON.stringify(json);
      } catch {
        body = req.body ?? undefined;
      }
    }

    try {
      const resp = await fetch(target, { method: req.method, headers, body });
      return new Response(resp.body, { status: resp.status, headers: resp.headers });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502 });
    }
  },
});
console.log("Azure proxy listening on http://127.0.0.1:7200");
PROXY_EOF
  chown "$ADMIN_USER":"$ADMIN_USER" "${OP_HOME}/data/workspace/azure-proxy.ts"

  # Write OpenCode user config pointing at the proxy
  cat > "${OP_HOME}/config/assistant/opencode.json" <<OCEOF
{
  "\$schema": "https://opencode.ai/config.json",
  "snapshot": false,
  "model": "azure-foundry/gpt-5.3-chat",
  "provider": {
    "azure-foundry": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Azure AI Foundry",
      "options": {
        "baseURL": "http://127.0.0.1:7200/openai/deployments/gpt-5.3-chat"
      },
      "models": {
        "gpt-5.3-chat": {
          "name": "GPT 5.3 Chat (Azure AI Foundry)",
          "limit": { "context": 131072, "output": 16384 },
          "capabilities": { "tool": true }
        },
        "gpt-5.4-mini": {
          "name": "GPT 5.4 Mini (Azure AI Foundry)",
          "limit": { "context": 131072, "output": 16384 },
          "capabilities": { "tool": true }
        },
        "gpt-41-mini": {
          "name": "GPT 4.1 Mini (Azure AI Foundry)",
          "limit": { "context": 131072, "output": 16384 },
          "capabilities": { "tool": true }
        }
      }
    },
    "azure": {
      "options": {
        "baseURL": "${AZURE_BASE}/openai",
        "resourceName": "${AZURE_RESOURCE}"
      }
    }
  }
}
OCEOF
  chown "$ADMIN_USER":"$ADMIN_USER" "${OP_HOME}/config/assistant/opencode.json"

  # Write OpenCode auth.json with Azure key for all providers
  mkdir -p "${OP_HOME}/vault/stack"
  cat > "${OP_HOME}/vault/stack/auth.json" <<AUTHEOF
{
  "azure": { "type": "api", "key": "${AZURE_OPENAI_KEY}" },
  "azure-foundry": { "type": "api", "key": "${AZURE_OPENAI_KEY}" },
  "azure-cognitive-services": { "type": "api", "key": "${AZURE_OPENAI_KEY}" },
  "openai": { "type": "api", "key": "${AZURE_OPENAI_KEY}" }
}
AUTHEOF
  chmod 600 "${OP_HOME}/vault/stack/auth.json"
  chown "$ADMIN_USER":"$ADMIN_USER" "${OP_HOME}/vault/stack/auth.json"

  # Write fileshare.compose.yml — mounts file share + starts Azure proxy
  cat > "${OP_HOME}/stack/fileshare.compose.yml" <<'COMPOSE_EOF'
services:
  assistant:
    volumes:
      - /mnt/openpalm:/mnt/openpalm
    environment:
      AZURE_PROXY_KEY: ${AZURE_OPENAI_API_KEY:-}
      AZURE_PROXY_BASE: ${AZURE_PROXY_BASE:-}
    entrypoint:
      - /bin/bash
      - -c
      - |
        if [ -f /work/azure-proxy.ts ] && [ -n "$$AZURE_PROXY_KEY" ]; then
          nohup bun run /work/azure-proxy.ts > /tmp/azure-proxy.log 2>&1 &
          sleep 1
        fi
        exec /usr/bin/tini -- /usr/local/bin/opencode-entrypoint.sh

  admin:
    volumes:
      - /mnt/openpalm:/mnt/openpalm
COMPOSE_EOF
  chown "$ADMIN_USER":"$ADMIN_USER" "${OP_HOME}/stack/fileshare.compose.yml"

  # Add Azure proxy env vars to stack.env
  {
    echo ""
    echo "# Azure AI Foundry proxy"
    echo "AZURE_OPENAI_API_KEY=${AZURE_OPENAI_KEY}"
    echo "AZURE_PROXY_BASE=${AZURE_BASE}"
  } >> "${OP_HOME}/vault/stack/stack.env"

  echo "[openpalm] Azure AI Foundry config created"
fi

# ── Start the stack ─────────────────────────────────────────────────────
# First run may fail because the init container creates volume mount subdirs
# as root. Fix ownership and retry.

COMPOSE_ARGS="-f ${OP_HOME}/stack/core.compose.yml --project-name openpalm"

# Include addon overlays if they exist
for addon_dir in "${OP_HOME}/stack/addons"/*/; do
  [[ -f "${addon_dir}compose.yml" ]] && COMPOSE_ARGS="$COMPOSE_ARGS -f ${addon_dir}compose.yml"
done

# Include fileshare overlay if created
[[ -f "${OP_HOME}/stack/fileshare.compose.yml" ]] && \
  COMPOSE_ARGS="$COMPOSE_ARGS -f ${OP_HOME}/stack/fileshare.compose.yml"

ENV_ARGS="--env-file ${OP_HOME}/vault/stack/stack.env --env-file ${OP_HOME}/vault/user/user.env --env-file ${OP_HOME}/vault/stack/guardian.env"

sudo -u "$ADMIN_USER" docker compose $COMPOSE_ARGS $ENV_ARGS pull
sudo -u "$ADMIN_USER" docker compose $COMPOSE_ARGS $ENV_ARGS up -d || true

chown -R "$ADMIN_USER":"$ADMIN_USER" "${OP_HOME}/data"

sudo -u "$ADMIN_USER" docker compose $COMPOSE_ARGS $ENV_ARGS up -d

# Install Azure CLI (for backup cron, not critical path)
curl -sL https://aka.ms/InstallAzureCLIDeb | bash

echo "0 3 * * * root /usr/local/bin/openpalm-backup.sh" > /etc/cron.d/openpalm-backup
chmod 644 /etc/cron.d/openpalm-backup

echo "[openpalm] done at $(date -u)"
