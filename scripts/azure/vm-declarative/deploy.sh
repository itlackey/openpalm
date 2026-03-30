#!/usr/bin/env bash
set -euo pipefail

# deploy.sh — Thin orchestrator for the Bicep-based VM deployment.
#
# This script handles the three things Bicep cannot:
#   1. Writing secrets to Key Vault (values come from env vars / generation)
#   2. Rendering the cloud-init YAML from files/
#   3. Passing the rendered cloud-init + SSH key into the Bicep deployment
#
# All Azure resource definitions live in main.bicep.
#
# Usage:
#   export AZURE_SUBSCRIPTION_ID=...
#   export SETUP_SPEC_FILE=./my-setup.yaml
#   # optional: export SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-...
#   ./deploy.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Helpers ──────────────────────────────────────────────────────────────

info()  { printf '  → %s\n' "$*"; }
error() { printf '  ✗ %s\n' "$*" >&2; }

require() {
  command -v "$1" >/dev/null 2>&1 || { error "Missing required command: $1"; exit 1; }
}

generate_secret() { openssl rand -base64 32 | tr -d '/+=' | head -c 44; }

resolve_setup_ref() {
  local ver="$1" bare="${ver#v}"
  local tag_url="https://github.com/itlackey/openpalm/releases/tag/${ver}"
  if curl -fsSL --head "$tag_url" >/dev/null 2>&1; then
    printf '%s\n' "$ver"
  else
    printf 'release/%s\n' "$bare"
  fi
}

require az
require python3
require base64
require openssl

# ── Configuration ────────────────────────────────────────────────────────
# All infra tunables live in main.bicepparam.  This script only needs the
# values that feed into secrets and cloud-init rendering.

: "${AZURE_SUBSCRIPTION_ID:?Set AZURE_SUBSCRIPTION_ID}"
: "${SETUP_SPEC_FILE:?Set SETUP_SPEC_FILE to a local OpenPalm setup YAML/JSON file}"

LOCATION="${LOCATION:-eastus}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-openpalm-vm}"
ADMIN_USERNAME="${ADMIN_USERNAME:-openpalm}"
OPENPALM_VERSION="${OPENPALM_VERSION:-v0.10.0}"
KV_NAME="${KV_NAME:-kv-openpalm-vm}"
STORAGE_NAME="${STORAGE_NAME:-stopenpalm}"
BACKUP_SHARE="${BACKUP_SHARE:-openpalm-backups}"
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
SLACK_APP_TOKEN="${SLACK_APP_TOKEN:-}"

OPENPALM_INSTALL_DIR="/home/${ADMIN_USERNAME}/.local/bin"
OPENPALM_HOME="/home/${ADMIN_USERNAME}/.openpalm"

[[ -f "$SETUP_SPEC_FILE" ]] || { error "SETUP_SPEC_FILE not found: $SETUP_SPEC_FILE"; exit 1; }

az account set --subscription "$AZURE_SUBSCRIPTION_ID"

SETUP_REF="$(resolve_setup_ref "$OPENPALM_VERSION")"
echo "Version:    $OPENPALM_VERSION (ref: $SETUP_REF)"

# ── Secrets ──────────────────────────────────────────────────────────────

ADMIN_TOKEN="${ADMIN_TOKEN:-$(generate_secret)}"
ASSISTANT_TOKEN="${ASSISTANT_TOKEN:-$(generate_secret)}"
CHANNEL_SLACK_SECRET="$(generate_secret)"

SLACK_ENABLED="false"
[[ -n "$SLACK_BOT_TOKEN" && -n "$SLACK_APP_TOKEN" ]] && SLACK_ENABLED="true"

# ── Render cloud-init ────────────────────────────────────────────────────

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

SETUP_SPEC_B64="$(base64 -w0 "$SETUP_SPEC_FILE")"

python3 "${SCRIPT_DIR}/render-cloud-init.py" <<EOF > "${TMP_DIR}/cloud-init.yaml"
{
  "admin_username":      "${ADMIN_USERNAME}",
  "openpalm_version":    "${OPENPALM_VERSION}",
  "openpalm_install_dir":"${OPENPALM_INSTALL_DIR}",
  "openpalm_home":       "${OPENPALM_HOME}",
  "setup_spec_b64":      "${SETUP_SPEC_B64}",
  "kv_name":             "${KV_NAME}",
  "storage_name":        "${STORAGE_NAME}",
  "backup_share":        "${BACKUP_SHARE}",
  "setup_ref":           "${SETUP_REF}"
}
EOF

CUSTOM_DATA_B64="$(base64 -w0 "${TMP_DIR}/cloud-init.yaml")"

# Generate a throwaway SSH key for the Bicep deployment requirement.
# The NSG blocks inbound SSH; access is exclusively via `az ssh vm`.
ssh-keygen -t ed25519 -f "${TMP_DIR}/deploy_key" -N "" -q
SSH_PUB="$(cat "${TMP_DIR}/deploy_key.pub")"

# ═════════════════════════════════════════════════════════════════════════
# Phase 1 — Resource Group
# ═════════════════════════════════════════════════════════════════════════

echo "Creating resource group..."
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

# ═════════════════════════════════════════════════════════════════════════
# Phase 2 — Bicep deployment (all infrastructure)
# ═════════════════════════════════════════════════════════════════════════

echo "Deploying infrastructure via Bicep..."
az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "${SCRIPT_DIR}/main.bicep" \
  --parameters "${SCRIPT_DIR}/main.bicepparam" \
  --parameters \
    location="$LOCATION" \
    keyVaultName="$KV_NAME" \
    storageAccountName="$STORAGE_NAME" \
    adminUsername="$ADMIN_USERNAME" \
    sshPublicKey="$SSH_PUB" \
    customData="$CUSTOM_DATA_B64" \
  --output none

# Read outputs
PRIVATE_IP="$(az deployment group show \
  --resource-group "$RESOURCE_GROUP" \
  --name main \
  --query properties.outputs.privateIp.value -o tsv)"

VM_NAME="$(az deployment group show \
  --resource-group "$RESOURCE_GROUP" \
  --name main \
  --query properties.outputs.vmResourceId.value -o tsv | rev | cut -d/ -f1 | rev)"

# ═════════════════════════════════════════════════════════════════════════
# Phase 3 — Key Vault secrets (cannot be in Bicep — values are sensitive)
# ═════════════════════════════════════════════════════════════════════════

# Grant deployer write access
DEPLOYER_OID="$(az ad signed-in-user show --query id -o tsv)"
KV_ID="$(az keyvault show --name "$KV_NAME" --query id -o tsv)"

az role assignment create \
  --assignee-object-id "$DEPLOYER_OID" \
  --assignee-principal-type User \
  --role "Key Vault Secrets Officer" \
  --scope "$KV_ID" \
  --output none 2>/dev/null || true

info "Waiting for RBAC propagation..."
sleep 10

echo "Writing secrets to Key Vault..."
kv_set() { az keyvault secret set --vault-name "$KV_NAME" --name "$1" --value "$2" --output none; }

kv_set "op-admin-token"      "$ADMIN_TOKEN"
kv_set "op-assistant-token"  "$ASSISTANT_TOKEN"
kv_set "channel-slack-secret" "$CHANNEL_SLACK_SECRET"

if [[ "$SLACK_ENABLED" == "true" ]]; then
  kv_set "slack-bot-token" "$SLACK_BOT_TOKEN"
  kv_set "slack-app-token" "$SLACK_APP_TOKEN"
  info "Slack tokens stored."
fi

# Ensure az ssh extension is available locally
az extension add --name ssh --yes 2>/dev/null || true

# ═════════════════════════════════════════════════════════════════════════
# Done
# ═════════════════════════════════════════════════════════════════════════

cat <<SUMMARY

VM deployment complete (VNet-only, no public IP).

  Private IP:       ${PRIVATE_IP}
  Key Vault:        ${KV_NAME}
  Storage Account:  ${STORAGE_NAME}/${BACKUP_SHARE}
  Slack channel:    ${SLACK_ENABLED}

SSH via Azure CLI (Entra ID auth, no public IP required):
  az ssh vm -g ${RESOURCE_GROUP} -n ${VM_NAME}

Cloud-init is still running. After SSH, monitor with:
  sudo tail -f /var/log/cloud-init-output.log
  sudo tail -f /var/log/openpalm-bootstrap.log

SUMMARY
