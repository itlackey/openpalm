#!/usr/bin/env bash
set -euo pipefail

# deploy.sh — Provision an Azure VM running the OpenPalm stack.
#
# Creates:  Resource Group → Key Vault → Storage Account → VNet/NSG → VM
#
# The VM has no public IP.  SSH is via `az ssh vm` (Entra ID).
# Only the guardian port (3899) is reachable, and only from within the VNet.
#
# Usage:
#   export AZURE_SUBSCRIPTION_ID=...
#   export SETUP_SPEC_FILE=./my-setup.yaml
#   # optional: export SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-...
#   ./deploy.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

# ── Load defaults, then let env vars override ────────────────────────────
set -a
source "${SCRIPT_DIR}/defaults.env"
set +a

# Required
: "${AZURE_SUBSCRIPTION_ID:?Set AZURE_SUBSCRIPTION_ID}"
: "${SETUP_SPEC_FILE:?Set SETUP_SPEC_FILE to a local OpenPalm setup YAML/JSON file}"

# Derived
OPENPALM_INSTALL_DIR="${OPENPALM_INSTALL_DIR:-/home/${ADMIN_USERNAME}/.local/bin}"
OPENPALM_HOME="${OPENPALM_HOME:-/home/${ADMIN_USERNAME}/.openpalm}"
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
SLACK_APP_TOKEN="${SLACK_APP_TOKEN:-}"

# Prereqs
require az
require python3
require base64
require openssl

[[ -f "$SETUP_SPEC_FILE" ]] || { error "SETUP_SPEC_FILE not found: $SETUP_SPEC_FILE"; exit 1; }

az account set --subscription "$AZURE_SUBSCRIPTION_ID"

# ── Resolve version ref ─────────────────────────────────────────────────
SETUP_REF="$(resolve_setup_ref "$OPENPALM_VERSION")"
echo "Image:      $IMAGE_URN"
echo "Version:    $OPENPALM_VERSION (ref: $SETUP_REF)"
echo "VM size:    $VM_SIZE"

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
  "admin_username":      "$ADMIN_USERNAME",
  "openpalm_version":    "$OPENPALM_VERSION",
  "openpalm_install_dir":"$OPENPALM_INSTALL_DIR",
  "openpalm_home":       "$OPENPALM_HOME",
  "setup_spec_b64":      "$SETUP_SPEC_B64",
  "kv_name":             "$KV_NAME",
  "storage_name":        "$STORAGE_NAME",
  "backup_share":        "$BACKUP_SHARE",
  "setup_ref":           "$SETUP_REF"
}
EOF

# ═════════════════════════════════════════════════════════════════════════
# Phase 1 — Resource Group
# ═════════════════════════════════════════════════════════════════════════
echo "Creating resource group..."
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --tags $TAGS --output none

# ═════════════════════════════════════════════════════════════════════════
# Phase 2 — Key Vault + Secrets
# ═════════════════════════════════════════════════════════════════════════
echo "Creating Key Vault..."
az keyvault create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$KV_NAME" \
  --location "$LOCATION" \
  --enable-rbac-authorization true \
  --tags $TAGS \
  --output none

DEPLOYER_OID="$(az ad signed-in-user show --query id -o tsv)"
KV_ID="$(az keyvault show --name "$KV_NAME" --query id -o tsv)"

az role assignment create \
  --assignee-object-id "$DEPLOYER_OID" \
  --assignee-principal-type User \
  --role "Key Vault Secrets Officer" \
  --scope "$KV_ID" \
  --output none 2>/dev/null || true

sleep 10  # RBAC propagation

echo "Writing secrets to Key Vault..."
kv_set_secret "$KV_NAME" "op-admin-token"       "$ADMIN_TOKEN"
kv_set_secret "$KV_NAME" "op-assistant-token"    "$ASSISTANT_TOKEN"
kv_set_secret "$KV_NAME" "channel-slack-secret"  "$CHANNEL_SLACK_SECRET"
if [[ "$SLACK_ENABLED" == "true" ]]; then
  kv_set_secret "$KV_NAME" "slack-bot-token" "$SLACK_BOT_TOKEN"
  kv_set_secret "$KV_NAME" "slack-app-token" "$SLACK_APP_TOKEN"
  info "Slack tokens stored."
fi

# ═════════════════════════════════════════════════════════════════════════
# Phase 3 — Storage Account + Backup Share
# ═════════════════════════════════════════════════════════════════════════
echo "Creating Storage Account..."
az storage account create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$STORAGE_NAME" \
  --location "$LOCATION" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false \
  --tags $TAGS \
  --output none

STORAGE_KEY="$(az storage account keys list \
  --resource-group "$RESOURCE_GROUP" \
  --account-name "$STORAGE_NAME" \
  --query '[0].value' -o tsv)"

az storage share create \
  --account-name "$STORAGE_NAME" \
  --account-key "$STORAGE_KEY" \
  --name "$BACKUP_SHARE" \
  --quota 50 \
  --output none

# ═════════════════════════════════════════════════════════════════════════
# Phase 4 — Networking (VNet + NSG)
# ═════════════════════════════════════════════════════════════════════════
echo "Creating VNet and subnet..."
az network vnet create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$VNET_NAME" \
  --location "$LOCATION" \
  --address-prefix "$VNET_PREFIX" \
  --subnet-name "$SUBNET_NAME" \
  --subnet-prefix "$SUBNET_PREFIX" \
  --tags $TAGS \
  --output none

echo "Creating network security group..."
az network nsg create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$NSG_NAME" \
  --location "$LOCATION" \
  --tags $TAGS \
  --output none

# Explicit deny-all for visibility (Azure has an implicit one at 65500)
az network nsg rule create \
  --resource-group "$RESOURCE_GROUP" --nsg-name "$NSG_NAME" \
  --name DenyAllInbound --priority 4096 --direction Inbound --access Deny \
  --protocol '*' --source-address-prefixes '*' \
  --destination-address-prefixes '*' --destination-port-ranges '*' \
  --output none

# Guardian only, VNet only
az network nsg rule create \
  --resource-group "$RESOURCE_GROUP" --nsg-name "$NSG_NAME" \
  --name AllowGuardianFromVNet --priority 1000 --direction Inbound --access Allow \
  --protocol Tcp --source-address-prefixes VirtualNetwork \
  --destination-address-prefixes '*' --destination-port-ranges 3899 \
  --output none

az network vnet subnet update \
  --resource-group "$RESOURCE_GROUP" \
  --vnet-name "$VNET_NAME" \
  --name "$SUBNET_NAME" \
  --network-security-group "$NSG_NAME" \
  --output none

# ═════════════════════════════════════════════════════════════════════════
# Phase 5 — VM
# ═════════════════════════════════════════════════════════════════════════
# SSH is via `az ssh vm` (Entra ID).  --generate-ssh-keys is required by
# az vm create but the NSG blocks all inbound SSH — keys are unreachable.
echo "Creating VM (${VM_SIZE}, ${OS_DISK_SIZE}GB disk, no public IP)..."
az vm create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$VM_NAME" \
  --location "$LOCATION" \
  --image "$IMAGE_URN" \
  --size "$VM_SIZE" \
  --os-disk-size-gb "$OS_DISK_SIZE" \
  --admin-username "$ADMIN_USERNAME" \
  --authentication-type ssh \
  --generate-ssh-keys \
  --assign-identity '[system]' \
  --vnet-name "$VNET_NAME" \
  --subnet "$SUBNET_NAME" \
  --public-ip-address "" \
  --nsg "" \
  --custom-data "${TMP_DIR}/cloud-init.yaml" \
  --security-type Standard \
  --tags $TAGS \
  --output jsonc

az extension add --name ssh --yes 2>/dev/null || true

# ═════════════════════════════════════════════════════════════════════════
# Phase 6 — RBAC for VM identity
# ═════════════════════════════════════════════════════════════════════════
VM_IDENTITY="$(az vm show -g "$RESOURCE_GROUP" -n "$VM_NAME" --query identity.principalId -o tsv)"

echo "Granting VM identity access to Key Vault..."
az role assignment create \
  --assignee-object-id "$VM_IDENTITY" --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" --scope "$KV_ID" --output none

STORAGE_ID="$(az storage account show --name "$STORAGE_NAME" --query id -o tsv)"

echo "Granting VM identity access to Storage Account..."
az role assignment create \
  --assignee-object-id "$VM_IDENTITY" --assignee-principal-type ServicePrincipal \
  --role "Storage File Data Privileged Contributor" --scope "$STORAGE_ID" --output none

# ═════════════════════════════════════════════════════════════════════════
# Done
# ═════════════════════════════════════════════════════════════════════════
PRIVATE_IP="$(az vm show -d -g "$RESOURCE_GROUP" -n "$VM_NAME" --query privateIps -o tsv)"

cat <<SUMMARY

VM deployment complete (VNet-only, no public IP).

  Private IP:       ${PRIVATE_IP}
  VNet/Subnet:      ${VNET_NAME}/${SUBNET_NAME}
  Guardian (VNet):  http://${PRIVATE_IP}:3899
  Key Vault:        ${KV_NAME}
  Storage Account:  ${STORAGE_NAME}/${BACKUP_SHARE}
  Slack channel:    ${SLACK_ENABLED}
  OpenPalm CLI:     ${OPENPALM_INSTALL_DIR}/openpalm

SSH via Azure CLI (Entra ID auth, no public IP required):
  az ssh vm -g ${RESOURCE_GROUP} -n ${VM_NAME}

Cloud-init is still running. After SSH, monitor with:
  sudo tail -f /var/log/cloud-init-output.log
  sudo tail -f /var/log/openpalm-bootstrap.log

SUMMARY
