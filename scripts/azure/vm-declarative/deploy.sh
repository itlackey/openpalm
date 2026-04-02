#!/usr/bin/env bash
set -euo pipefail

# deploy.sh — Deploy an OpenPalm VM to Azure.
#
# deploy.env  — all config: Azure settings + secrets (API keys, tokens)
# spec file   — instance config (no secrets — embedded in cloud-init)
#
# Secrets from deploy.env are extracted and stored in Key Vault.
# The VM fetches them at boot via managed identity.
#
# Usage:
#   cp deploy.env.example deploy.env
#   cp example.spec.yaml deploy.spec.yaml
#   # Edit both, then:
#   ./deploy.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Load config ───────────────────────────────────────────────────────

DEPLOY_ENV="${DEPLOY_ENV:-${SCRIPT_DIR}/deploy.env}"
[[ -f "$DEPLOY_ENV" ]] || { echo "Not found: $DEPLOY_ENV (copy deploy.env.example)" >&2; exit 1; }
# shellcheck source=/dev/null
set -a; source "$DEPLOY_ENV"; set +a

: "${AZURE_SUBSCRIPTION_ID:?Set AZURE_SUBSCRIPTION_ID in deploy.env}"
: "${SETUP_SPEC_FILE:?Set SETUP_SPEC_FILE in deploy.env}"
LOCATION="${LOCATION:-eastus}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-openpalm-vm}"
ADMIN_USERNAME="${ADMIN_USERNAME:-openpalm}"
OPENPALM_VERSION="${OPENPALM_VERSION:-v0.10.0-rc13}"
STORAGE_NAME="${STORAGE_NAME:-stopenpalm}"
BACKUP_SHARE="${BACKUP_SHARE:-openpalm-backups}"
SETUP_REF="${SETUP_REF:-main}"
KV_NAME="${KV_NAME:-kv-openpalm}"

[[ -f "$SETUP_SPEC_FILE" ]] || { echo "Not found: $SETUP_SPEC_FILE" >&2; exit 1; }
command -v az >/dev/null || { echo "az CLI required" >&2; exit 1; }

az account set --subscription "$AZURE_SUBSCRIPTION_ID"

# ── Extract secrets for Key Vault ─────────────────────────────────────
# Secret vars are any line in deploy.env that isn't Azure deployment config.

TMP="$(mktemp -d)" && trap 'rm -rf "$TMP"' EXIT

grep -E '^(OP_ADMIN_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|GROQ_API_KEY|MISTRAL_API_KEY|GOOGLE_API_KEY|DEEPSEEK_API_KEY|TOGETHER_API_KEY|XAI_API_KEY|HF_TOKEN|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|DISCORD_BOT_TOKEN|DISCORD_APPLICATION_ID)=' "$DEPLOY_ENV" \
  > "${TMP}/secrets.env" 2>/dev/null || true
[[ -s "${TMP}/secrets.env" ]] || { echo "No secrets found in $DEPLOY_ENV (need at least OP_ADMIN_TOKEN)" >&2; exit 1; }

# ── Build cloud-init ──────────────────────────────────────────────────

SPEC_B64="$(base64 -w0 "$SETUP_SPEC_FILE")"
FIRST_BOOT="$(cat "${SCRIPT_DIR}/vm/first-boot.sh")"
BACKUP="$(cat "${SCRIPT_DIR}/vm/backup.sh")"

cat > "${TMP}/cloud-init.yaml" <<CLOUD_INIT
#cloud-config
package_update: true
package_upgrade: true
packages: [ca-certificates, curl, git, jq, sudo, unzip, openssl, cron]

users:
  - default
  - name: ${ADMIN_USERNAME}
    groups: [sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL

write_files:
  - path: /etc/openpalm/config
    permissions: '0600'
    content: |
      ADMIN_USER=${ADMIN_USERNAME}
      OP_VERSION=${OPENPALM_VERSION}
      OP_INSTALL_DIR=/home/${ADMIN_USERNAME}/.local/bin
      OP_HOME=/home/${ADMIN_USERNAME}/.openpalm
      SETUP_REF=${SETUP_REF}
      STORAGE_NAME=${STORAGE_NAME}
      BACKUP_SHARE=${BACKUP_SHARE}
      VAULT_NAME=${KV_NAME}
      CADDY_GUARDIAN_FQDN=${CADDY_GUARDIAN_FQDN:-}
      CADDY_ADMIN_FQDN=${CADDY_ADMIN_FQDN:-}
      CADDY_ASSISTANT_FQDN=${CADDY_ASSISTANT_FQDN:-}
      CADDY_EMAIL=${CADDY_EMAIL:-}

  - path: /var/lib/openpalm/setup-spec.b64
    permissions: '0600'
    content: ${SPEC_B64}

  - path: /usr/local/bin/openpalm-first-boot.sh
    permissions: '0755'
    content: |
$(echo "$FIRST_BOOT" | sed 's/^/      /')

  - path: /usr/local/bin/openpalm-backup.sh
    permissions: '0755'
    content: |
$(echo "$BACKUP" | sed 's/^/      /')

runcmd:
  - [bash, -lc, /usr/local/bin/openpalm-first-boot.sh]
CLOUD_INIT

CUSTOM_DATA="$(base64 -w0 "${TMP}/cloud-init.yaml")"
ssh-keygen -t ed25519 -f "${TMP}/key" -N "" -q
SSH_KEY="${SCRIPT_DIR}/deploy.key"
cp "${TMP}/key" "$SSH_KEY"
chmod 600 "$SSH_KEY"

# ── Deploy ────────────────────────────────────────────────────────────

echo "Deploying to ${LOCATION}..."
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

# Purge soft-deleted KV if it exists (blocks reuse of the same name)
if az keyvault list-deleted --query "[?name=='${KV_NAME}'].name" -o tsv 2>/dev/null | grep -q "$KV_NAME"; then
  echo "Purging soft-deleted Key Vault: ${KV_NAME}..."
  az keyvault purge --name "$KV_NAME" 2>/dev/null || true
  # Wait for purge to complete
  for _ in $(seq 1 30); do
    az keyvault list-deleted --query "[?name=='${KV_NAME}'].name" -o tsv 2>/dev/null | grep -q "$KV_NAME" || break
    sleep 5
  done
fi

az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "${SCRIPT_DIR}/main.bicep" \
  --parameters \
    location="$LOCATION" \
    storageAccountName="$STORAGE_NAME" \
    adminUsername="$ADMIN_USERNAME" \
    sshPublicKey="$(cat "${TMP}/key.pub")" \
    customData="$CUSTOM_DATA" \
    keyVaultName="$KV_NAME" \
  --output none

# Grant deployer write access to KV, then upload secrets
echo "Uploading secrets to Key Vault..."
DEPLOYER_OID="$(az ad signed-in-user show --query id -o tsv)"
KV_ID="$(az keyvault show --name "$KV_NAME" -g "$RESOURCE_GROUP" --query id -o tsv)"
az role assignment create \
  --assignee "$DEPLOYER_OID" \
  --role "Key Vault Secrets Officer" \
  --scope "$KV_ID" \
  --output none
# RBAC propagation can take up to 30s
UPLOADED=false
for attempt in $(seq 1 8); do
  if az keyvault secret set --vault-name "$KV_NAME" -n "secrets" \
    --file "${TMP}/secrets.env" --output none 2>/dev/null; then
    UPLOADED=true; break
  fi
  echo "  waiting for KV RBAC propagation (attempt ${attempt}/8)..."
  sleep 5
done
$UPLOADED || { echo "FATAL: failed to upload secrets to Key Vault after 40s" >&2; exit 1; }

az extension add --name ssh --yes 2>/dev/null || true

# ── Done ──────────────────────────────────────────────────────────────

PRIVATE_IP="$(az deployment group show -g "$RESOURCE_GROUP" -n main \
  --query properties.outputs.privateIp.value -o tsv)"
PUBLIC_IP="$(az deployment group show -g "$RESOURCE_GROUP" -n main \
  --query properties.outputs.publicIp.value -o tsv)"
VM="$(az deployment group show -g "$RESOURCE_GROUP" -n main \
  --query properties.outputs.vmName.value -o tsv)"

cat <<DONE

Deployed.  Public IP: ${PUBLIC_IP}  Private IP: ${PRIVATE_IP}  Key Vault: ${KV_NAME}

  # Run commands on the VM (no VPN/Bastion needed):
  az vm run-command invoke -g ${RESOURCE_GROUP} -n ${VM} \\
    --command-id RunShellScript --scripts "COMMAND" \\
    --query value[0].message -o tsv

  # Check bootstrap progress:
  ... --scripts "tail -20 /var/log/openpalm-bootstrap.log"

  # Check stack health:
  ... --scripts "sudo -u ${ADMIN_USERNAME} docker ps"

  # SSH key saved to ${SSH_KEY} (for use with VPN/Bastion if added later)
DONE

# Print DNS reminder if any Caddy FQDNs are configured
FQDNS=""
[[ -n "${CADDY_GUARDIAN_FQDN:-}" ]] && FQDNS="${FQDNS}  ${CADDY_GUARDIAN_FQDN} → guardian\n"
[[ -n "${CADDY_ADMIN_FQDN:-}" ]] && FQDNS="${FQDNS}  ${CADDY_ADMIN_FQDN} → admin\n"
[[ -n "${CADDY_ASSISTANT_FQDN:-}" ]] && FQDNS="${FQDNS}  ${CADDY_ASSISTANT_FQDN} → assistant\n"
if [[ -n "$FQDNS" ]]; then
  cat <<DNS

  ┌─ DNS required for HTTPS ────────────────────────────────────────
  │ Create A records pointing to ${PUBLIC_IP}:
  │
$(printf '%s' "$FQDNS" | sed 's/^/  │ /')
  │
  │ Caddy will automatically obtain Let's Encrypt certificates
  │ once DNS resolves and ports 80/443 are reachable.
  └─────────────────────────────────────────────────────────────────
DNS
fi
