#!/usr/bin/env bash
set -euo pipefail

# Deploy an Ubuntu 24.04 LTS Azure VM into a private VNet, install Docker +
# OpenPalm CLI, and run `openpalm install --file ...` on first boot via
# cloud-init.
#
# Infrastructure created:
#   - VNet + subnet + NSG (guardian-only ingress from VNet)
#   - Key Vault for secrets (Slack tokens, admin/assistant tokens)
#   - Storage Account for backups (openpalm-backups file share)
#   - VM with system-assigned managed identity (reads Key Vault, writes Storage)
#
# The VM has NO public IP.  SSH access is exclusively via `az ssh vm` which
# tunnels through the Azure control plane using Entra ID authentication.
# No SSH keys are placed on the VM and no SSH port is opened in the NSG.
# Only the guardian service port (3899) is reachable from within the VNet.
#
# Required:
#   export AZURE_SUBSCRIPTION_ID=...
#   export SETUP_SPEC_FILE=./openpalm-setup-spec.yaml
#
# Required for Slack channel (omit both to deploy without Slack):
#   export SLACK_BOT_TOKEN=xoxb-...
#   export SLACK_APP_TOKEN=xapp-...
#
# Recommended:
#   export LOCATION=eastus
#   export RESOURCE_GROUP=rg-openpalm-vm
#   export VM_NAME=openpalm-vm
#   export ADMIN_USERNAME=openpalm
#   export OPENPALM_VERSION=v0.10.0
#
# Optional:
#   export VNET_NAME=vnet-openpalm
#   export VNET_PREFIX=10.0.0.0/16
#   export SUBNET_NAME=snet-openpalm-vm
#   export SUBNET_PREFIX=10.0.1.0/24
#   export KV_NAME=kv-openpalm-vm          # Key Vault name (globally unique)
#   export STORAGE_NAME=stopenpalm          # Storage Account name (globally unique)
#   export IMAGE_URN="Canonical:ubuntu-24_04-lts:server:latest"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require az
require python3
require base64
require openssl

: "${AZURE_SUBSCRIPTION_ID:?Set AZURE_SUBSCRIPTION_ID}"
: "${SETUP_SPEC_FILE:?Set SETUP_SPEC_FILE to a local OpenPalm setup YAML/JSON file}"

LOCATION="${LOCATION:-eastus}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-openpalm-vm}"
VM_NAME="${VM_NAME:-openpalm-vm}"
ADMIN_USERNAME="${ADMIN_USERNAME:-openpalm}"
VM_SIZE="${VM_SIZE:-Standard_B1ms}"
OS_DISK_SIZE="${OS_DISK_SIZE:-64}"
OPENPALM_VERSION="${OPENPALM_VERSION:-v0.10.0}"
OPENPALM_INSTALL_DIR="${OPENPALM_INSTALL_DIR:-/home/${ADMIN_USERNAME}/.local/bin}"
OPENPALM_HOME="${OPENPALM_HOME:-/home/${ADMIN_USERNAME}/.openpalm}"
TAGS="${TAGS:-app=openpalm env=dev managed-by=azure-cli}"

# Networking
VNET_NAME="${VNET_NAME:-vnet-openpalm}"
VNET_PREFIX="${VNET_PREFIX:-10.0.0.0/16}"
SUBNET_NAME="${SUBNET_NAME:-snet-openpalm-vm}"
SUBNET_PREFIX="${SUBNET_PREFIX:-10.0.1.0/24}"
NSG_NAME="${NSG_NAME:-nsg-openpalm-vm}"

# Key Vault & Storage (names must be globally unique — override as needed)
KV_NAME="${KV_NAME:-kv-openpalm-vm}"
STORAGE_NAME="${STORAGE_NAME:-stopenpalm}"
BACKUP_SHARE="${BACKUP_SHARE:-openpalm-backups}"

# Slack tokens (optional — Slack channel is enabled only when both are set)
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
SLACK_APP_TOKEN="${SLACK_APP_TOKEN:-}"

# Ubuntu 24.04 LTS — first-party Canonical image, no marketplace terms needed,
# Debian-based, LTS support through 2029, excellent Docker compatibility.
IMAGE_URN="${IMAGE_URN:-Canonical:ubuntu-24_04-lts:server:latest}"

# Resolve the setup.sh download ref from the version.  Tagged releases use the
# tag directly; otherwise fall back to a release/<major.minor> branch.
resolve_setup_ref() {
  local ver="$1"
  # Strip leading 'v' for branch-style refs
  local bare="${ver#v}"
  # If a GitHub release asset exists for the tag, use the tag directly.
  # Otherwise derive the release branch (e.g. v0.10.0 → release/0.10.0).
  # We test the tag via a lightweight HEAD request to avoid downloading.
  local tag_url="https://github.com/itlackey/openpalm/releases/tag/${ver}"
  if curl -fsSL --head "$tag_url" >/dev/null 2>&1; then
    printf '%s\n' "${ver}"
  else
    # Derive release/<major.minor.patch> branch
    printf 'release/%s\n' "${bare}"
  fi
}
SETUP_REF="$(resolve_setup_ref "$OPENPALM_VERSION")"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_INIT_TEMPLATE="${CLOUD_INIT_TEMPLATE:-${SCRIPT_DIR}/cloud-init-openpalm-cli.yaml.tpl}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [[ ! -f "$SETUP_SPEC_FILE" ]]; then
  echo "SETUP_SPEC_FILE not found: $SETUP_SPEC_FILE" >&2
  exit 1
fi

if [[ ! -f "$CLOUD_INIT_TEMPLATE" ]]; then
  echo "Cloud-init template not found: $CLOUD_INIT_TEMPLATE" >&2
  exit 1
fi

az account set --subscription "$AZURE_SUBSCRIPTION_ID"

echo "Using image URN: $IMAGE_URN"
echo "Setup script ref: $SETUP_REF"

# ── Generate internal secrets if not already set ─────────────────────────
generate_secret() { openssl rand -base64 32 | tr -d '/+=' | head -c 44; }

ADMIN_TOKEN="${ADMIN_TOKEN:-$(generate_secret)}"
ASSISTANT_TOKEN="${ASSISTANT_TOKEN:-$(generate_secret)}"
CHANNEL_SLACK_SECRET="$(generate_secret)"

SETUP_SPEC_B64="$(base64 -w0 "$SETUP_SPEC_FILE")"

SLACK_ENABLED="false"
if [[ -n "$SLACK_BOT_TOKEN" && -n "$SLACK_APP_TOKEN" ]]; then
  SLACK_ENABLED="true"
fi

export TEMPLATE_ADMIN_USERNAME="$ADMIN_USERNAME"
export TEMPLATE_OPENPALM_VERSION="$OPENPALM_VERSION"
export TEMPLATE_OPENPALM_INSTALL_DIR="$OPENPALM_INSTALL_DIR"
export TEMPLATE_OPENPALM_HOME="$OPENPALM_HOME"
export TEMPLATE_SETUP_SPEC_B64="$SETUP_SPEC_B64"
export TEMPLATE_KV_NAME="$KV_NAME"
export TEMPLATE_STORAGE_NAME="$STORAGE_NAME"
export TEMPLATE_BACKUP_SHARE="$BACKUP_SHARE"
export TEMPLATE_SETUP_REF="$SETUP_REF"
export CLOUD_INIT_TEMPLATE_PATH="$CLOUD_INIT_TEMPLATE"

python3 - <<'PY' > "$TMP_DIR/cloud-init.yaml"
import os
from pathlib import Path

tpl_path = Path(os.environ["CLOUD_INIT_TEMPLATE_PATH"])
text = tpl_path.read_text()
for key in [
    "TEMPLATE_ADMIN_USERNAME",
    "TEMPLATE_OPENPALM_VERSION",
    "TEMPLATE_OPENPALM_INSTALL_DIR",
    "TEMPLATE_OPENPALM_HOME",
    "TEMPLATE_SETUP_SPEC_B64",
    "TEMPLATE_KV_NAME",
    "TEMPLATE_STORAGE_NAME",
    "TEMPLATE_BACKUP_SHARE",
    "TEMPLATE_SETUP_REF",
]:
    text = text.replace(f"__{key}__", os.environ[key])
print(text)
PY

echo "Creating resource group..."
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --tags $TAGS >/dev/null

# ── Key Vault ────────────────────────────────────────────────────────────
echo "Creating Key Vault..."
az keyvault create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$KV_NAME" \
  --location "$LOCATION" \
  --enable-rbac-authorization true \
  --tags $TAGS \
  --output none

# Grant the current deployer "Key Vault Secrets Officer" so we can write secrets
DEPLOYER_OID="$(az ad signed-in-user show --query id -o tsv)"
KV_ID="$(az keyvault show --name "$KV_NAME" --query id -o tsv)"

az role assignment create \
  --assignee-object-id "$DEPLOYER_OID" \
  --assignee-principal-type User \
  --role "Key Vault Secrets Officer" \
  --scope "$KV_ID" \
  --output none 2>/dev/null || true

# Brief wait for RBAC propagation
sleep 10

echo "Writing secrets to Key Vault..."
set_secret() { az keyvault secret set --vault-name "$KV_NAME" --name "$1" --value "$2" --output none; }
set_secret "op-admin-token" "$ADMIN_TOKEN"
set_secret "op-assistant-token" "$ASSISTANT_TOKEN"
set_secret "channel-slack-secret" "$CHANNEL_SLACK_SECRET"
if [[ "$SLACK_ENABLED" == "true" ]]; then
  set_secret "slack-bot-token" "$SLACK_BOT_TOKEN"
  set_secret "slack-app-token" "$SLACK_APP_TOKEN"
  echo "  Slack tokens stored in Key Vault."
fi

# ── Storage Account (backups) ────────────────────────────────────────────
echo "Creating Storage Account for backups..."
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

STORAGE_KEY="$(az storage account keys list --resource-group "$RESOURCE_GROUP" --account-name "$STORAGE_NAME" --query '[0].value' -o tsv)"

az storage share create \
  --account-name "$STORAGE_NAME" \
  --account-key "$STORAGE_KEY" \
  --name "$BACKUP_SHARE" \
  --quota 50 \
  --output none

# ── Networking: VNet + Subnet + NSG ──────────────────────────────────────
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

# Deny all inbound by default (Azure NSG has an implicit DenyAllInbound at
# priority 65500, but we add an explicit one at 4096 for visibility).
az network nsg rule create \
  --resource-group "$RESOURCE_GROUP" \
  --nsg-name "$NSG_NAME" \
  --name DenyAllInbound \
  --priority 4096 \
  --direction Inbound \
  --access Deny \
  --protocol '*' \
  --source-address-prefixes '*' \
  --destination-address-prefixes '*' \
  --destination-port-ranges '*' \
  --output none

# Allow guardian port (3899) from VNet only
az network nsg rule create \
  --resource-group "$RESOURCE_GROUP" \
  --nsg-name "$NSG_NAME" \
  --name AllowGuardianFromVNet \
  --priority 1000 \
  --direction Inbound \
  --access Allow \
  --protocol Tcp \
  --source-address-prefixes VirtualNetwork \
  --destination-address-prefixes '*' \
  --destination-port-ranges 3899 \
  --output none

# Associate NSG with the subnet
az network vnet subnet update \
  --resource-group "$RESOURCE_GROUP" \
  --vnet-name "$VNET_NAME" \
  --name "$SUBNET_NAME" \
  --network-security-group "$NSG_NAME" \
  --output none

# ── VM ───────────────────────────────────────────────────────────────────
# The intended SSH path is `az ssh vm` which uses Entra ID and tunnels through
# the Azure control plane — no inbound SSH port is needed.  However, az vm
# create requires at least one auth mechanism, so we use --generate-ssh-keys as
# a fallback.  The NSG blocks all inbound SSH traffic, making these keys
# unreachable from the network.
echo "Creating VM (size: $VM_SIZE, disk: ${OS_DISK_SIZE}GB, no public IP)..."
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
  --custom-data "$TMP_DIR/cloud-init.yaml" \
  --security-type Standard \
  --tags $TAGS \
  --output jsonc

# Install the az ssh extension on the VM so Entra ID SSH works
az extension add --name ssh --yes 2>/dev/null || true

# ── RBAC: grant VM managed identity access to Key Vault and Storage ──────
VM_IDENTITY="$(az vm show -g "$RESOURCE_GROUP" -n "$VM_NAME" --query identity.principalId -o tsv)"

echo "Granting VM identity access to Key Vault (secrets read)..."
az role assignment create \
  --assignee-object-id "$VM_IDENTITY" \
  --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" \
  --scope "$KV_ID" \
  --output none

STORAGE_ID="$(az storage account show --name "$STORAGE_NAME" --query id -o tsv)"

echo "Granting VM identity access to Storage Account (file share contributor)..."
az role assignment create \
  --assignee-object-id "$VM_IDENTITY" \
  --assignee-principal-type ServicePrincipal \
  --role "Storage File Data Privileged Contributor" \
  --scope "$STORAGE_ID" \
  --output none

PRIVATE_IP="$(az vm show -d -g "$RESOURCE_GROUP" -n "$VM_NAME" --query privateIps -o tsv)"

echo
echo "VM deployment complete (VNet-only, no public IP)."
echo
echo "  Private IP:       ${PRIVATE_IP}"
echo "  VNet/Subnet:      ${VNET_NAME}/${SUBNET_NAME}"
echo "  Guardian (VNet):  http://${PRIVATE_IP}:3899"
echo "  Key Vault:        ${KV_NAME}"
echo "  Storage Account:  ${STORAGE_NAME}/${BACKUP_SHARE}"
echo "  Slack channel:    ${SLACK_ENABLED}"
echo "  OpenPalm CLI:     ${OPENPALM_INSTALL_DIR}/openpalm"
echo
echo "SSH via Azure CLI (Entra ID auth, no public IP required):"
echo "  az ssh vm -g ${RESOURCE_GROUP} -n ${VM_NAME}"
echo
echo "Cloud-init is still running. After SSH, monitor with:"
echo "  sudo tail -f /var/log/cloud-init-output.log"
echo "  sudo tail -f /var/log/openpalm-bootstrap.log"
echo
