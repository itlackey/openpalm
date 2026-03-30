#!/usr/bin/env bash
set -euo pipefail

# deploy.sh — Deploy an OpenPalm VM to Azure.
#
# Bicep (main.bicep) defines all Azure resources declaratively.
# This script handles what Bicep cannot: rendering cloud-init and writing
# secrets to Key Vault.
#
# Usage:
#   export AZURE_SUBSCRIPTION_ID=...
#   export SETUP_SPEC_FILE=./my-setup.yaml
#   # optional: export SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-...
#   ./deploy.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Config ───────────────────────────────────────────────────────────────

: "${AZURE_SUBSCRIPTION_ID:?Set AZURE_SUBSCRIPTION_ID}"
: "${SETUP_SPEC_FILE:?Set SETUP_SPEC_FILE to a local setup YAML}"

LOCATION="${LOCATION:-eastus}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-openpalm-vm}"
ADMIN_USERNAME="${ADMIN_USERNAME:-openpalm}"
OPENPALM_VERSION="${OPENPALM_VERSION:-v0.10.0}"
KV_NAME="${KV_NAME:-kv-openpalm-vm}"
STORAGE_NAME="${STORAGE_NAME:-stopenpalm}"
BACKUP_SHARE="${BACKUP_SHARE:-openpalm-backups}"
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
SLACK_APP_TOKEN="${SLACK_APP_TOKEN:-}"

[[ -f "$SETUP_SPEC_FILE" ]] || { echo "File not found: $SETUP_SPEC_FILE" >&2; exit 1; }

# ── Helpers ──────────────────────────────────────────────────────────────

generate_secret() { openssl rand -base64 32 | tr -d '/+=' | head -c 44; }

resolve_setup_ref() {
  local ver="$1"
  if curl -fsSL --head "https://github.com/itlackey/openpalm/releases/tag/${ver}" >/dev/null 2>&1; then
    echo "$ver"
  else
    echo "release/${ver#v}"
  fi
}

render_cloud_init() {
  # Reads first-boot.sh and backup.sh from disk, embeds them in a cloud-init
  # YAML along with the config values and setup spec.  No templating engine
  # needed — just a heredoc.
  local config_content="$1" setup_b64="$2"
  local first_boot backup
  first_boot="$(cat "${SCRIPT_DIR}/first-boot.sh")"
  backup="$(cat "${SCRIPT_DIR}/backup.sh")"

  cat <<CLOUD_INIT
#cloud-config
package_update: true
package_upgrade: true
packages:
  - ca-certificates
  - curl
  - git
  - jq
  - sudo
  - unzip
  - openssl
  - python3
  - python3-yaml
  - cron

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
$(echo "$config_content" | sed 's/^/      /')

  - path: /var/lib/openpalm/setup-spec.b64
    permissions: '0600'
    content: ${setup_b64}

  - path: /usr/local/bin/openpalm-first-boot.sh
    permissions: '0755'
    content: |
$(echo "$first_boot" | sed 's/^/      /')

  - path: /usr/local/bin/openpalm-backup.sh
    permissions: '0755'
    content: |
$(echo "$backup" | sed 's/^/      /')

runcmd:
  - [bash, -lc, /usr/local/bin/openpalm-first-boot.sh]
CLOUD_INIT
}

# ── Resolve inputs ───────────────────────────────────────────────────────

az account set --subscription "$AZURE_SUBSCRIPTION_ID"

SETUP_REF="$(resolve_setup_ref "$OPENPALM_VERSION")"
INSTALL_DIR="/home/${ADMIN_USERNAME}/.local/bin"
OP_HOME="/home/${ADMIN_USERNAME}/.openpalm"

ADMIN_TOKEN="${ADMIN_TOKEN:-$(generate_secret)}"
ASSISTANT_TOKEN="${ASSISTANT_TOKEN:-$(generate_secret)}"
CHANNEL_SLACK_SECRET="$(generate_secret)"

SLACK_ENABLED="false"
[[ -n "$SLACK_BOT_TOKEN" && -n "$SLACK_APP_TOKEN" ]] && SLACK_ENABLED="true"

SETUP_SPEC_B64="$(base64 -w0 "$SETUP_SPEC_FILE")"

# Single config file — sourced by both first-boot.sh and backup.sh on the VM.
CONFIG_CONTENT="ADMIN_USER=${ADMIN_USERNAME}
OP_VERSION=${OPENPALM_VERSION}
OP_INSTALL_DIR=${INSTALL_DIR}
OP_HOME=${OP_HOME}
KV_NAME=${KV_NAME}
SETUP_REF=${SETUP_REF}
STORAGE_NAME=${STORAGE_NAME}
BACKUP_SHARE=${BACKUP_SHARE}"

# ── Render cloud-init ────────────────────────────────────────────────────

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

render_cloud_init "$CONFIG_CONTENT" "$SETUP_SPEC_B64" > "${TMP_DIR}/cloud-init.yaml"
CUSTOM_DATA_B64="$(base64 -w0 "${TMP_DIR}/cloud-init.yaml")"

ssh-keygen -t ed25519 -f "${TMP_DIR}/key" -N "" -q
SSH_PUB="$(cat "${TMP_DIR}/key.pub")"

echo "Version:  ${OPENPALM_VERSION} (ref: ${SETUP_REF})"
echo "Slack:    ${SLACK_ENABLED}"

# ── Deploy ───────────────────────────────────────────────────────────────

echo "Creating resource group..."
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

echo "Deploying infrastructure (Bicep)..."
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

# ── Write secrets to Key Vault ───────────────────────────────────────────

DEPLOYER_OID="$(az ad signed-in-user show --query id -o tsv)"
KV_ID="$(az keyvault show --name "$KV_NAME" --query id -o tsv)"

az role assignment create \
  --assignee-object-id "$DEPLOYER_OID" --assignee-principal-type User \
  --role "Key Vault Secrets Officer" --scope "$KV_ID" \
  --output none 2>/dev/null || true

sleep 10  # RBAC propagation

echo "Writing secrets to Key Vault..."
kv() { az keyvault secret set --vault-name "$KV_NAME" --name "$1" --value "$2" --output none; }
kv "op-admin-token"       "$ADMIN_TOKEN"
kv "op-assistant-token"   "$ASSISTANT_TOKEN"
kv "channel-slack-secret" "$CHANNEL_SLACK_SECRET"
if [[ "$SLACK_ENABLED" == "true" ]]; then
  kv "slack-bot-token" "$SLACK_BOT_TOKEN"
  kv "slack-app-token" "$SLACK_APP_TOKEN"
fi

az extension add --name ssh --yes 2>/dev/null || true

# ── Output ───────────────────────────────────────────────────────────────

PRIVATE_IP="$(az deployment group show \
  --resource-group "$RESOURCE_GROUP" --name main \
  --query properties.outputs.privateIp.value -o tsv)"

cat <<DONE

Deployed.  Private IP: ${PRIVATE_IP}

  az ssh vm -g ${RESOURCE_GROUP} -n ${ADMIN_USERNAME}-vm

  sudo tail -f /var/log/openpalm-bootstrap.log

DONE
