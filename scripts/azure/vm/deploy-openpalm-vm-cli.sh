#!/usr/bin/env bash
set -euo pipefail

# Deploy an Ubuntu 24.04 LTS Azure VM into a private VNet, install Docker +
# OpenPalm CLI, and run `openpalm install --file ...` on first boot via
# cloud-init.
#
# The VM has NO public IP.  SSH access is via `az ssh vm`.  Only the guardian
# service port (3899) is reachable from within the VNet.
#
# Required:
#   export AZURE_SUBSCRIPTION_ID=...
#   export SETUP_SPEC_FILE=./openpalm-setup-spec.yaml
#
# Recommended:
#   export LOCATION=eastus
#   export RESOURCE_GROUP=rg-openpalm-vm
#   export VM_NAME=openpalm-vm
#   export ADMIN_USERNAME=openpalm
#   export OPENPALM_VERSION=v0.10.0
#
# Optional:
#   export VNET_NAME=vnet-openpalm          # name of the VNet to create
#   export VNET_PREFIX=10.0.0.0/16          # VNet address space
#   export SUBNET_NAME=snet-openpalm-vm     # subnet for the VM
#   export SUBNET_PREFIX=10.0.1.0/24        # subnet CIDR
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

: "${AZURE_SUBSCRIPTION_ID:?Set AZURE_SUBSCRIPTION_ID}"
: "${SETUP_SPEC_FILE:?Set SETUP_SPEC_FILE to a local OpenPalm setup YAML/JSON file}"

LOCATION="${LOCATION:-eastus}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-openpalm-vm}"
VM_NAME="${VM_NAME:-openpalm-vm}"
ADMIN_USERNAME="${ADMIN_USERNAME:-openpalm}"
VM_SIZE="${VM_SIZE:-Standard_B2s}"
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

# Ubuntu 24.04 LTS — first-party Canonical image, no marketplace terms needed,
# Debian-based, LTS support through 2029, excellent Docker compatibility.
IMAGE_URN="${IMAGE_URN:-Canonical:ubuntu-24_04-lts:server:latest}"

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

SETUP_SPEC_B64="$(base64 -w0 "$SETUP_SPEC_FILE")"

export TEMPLATE_ADMIN_USERNAME="$ADMIN_USERNAME"
export TEMPLATE_OPENPALM_VERSION="$OPENPALM_VERSION"
export TEMPLATE_OPENPALM_INSTALL_DIR="$OPENPALM_INSTALL_DIR"
export TEMPLATE_OPENPALM_HOME="$OPENPALM_HOME"
export TEMPLATE_SETUP_SPEC_B64="$SETUP_SPEC_B64"
export TEMPLATE_SSH_PUBLIC_KEY=""
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
    "TEMPLATE_SSH_PUBLIC_KEY",
]:
    text = text.replace(f"__{key}__", os.environ[key])
print(text)
PY

echo "Creating resource group..."
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --tags $TAGS >/dev/null

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
echo "Creating VM (size: $VM_SIZE, disk: ${OS_DISK_SIZE}GB, no public IP)..."
az vm create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$VM_NAME" \
  --location "$LOCATION" \
  --image "$IMAGE_URN" \
  --size "$VM_SIZE" \
  --os-disk-size-gb "$OS_DISK_SIZE" \
  --admin-username "$ADMIN_USERNAME" \
  --generate-ssh-keys \
  --vnet-name "$VNET_NAME" \
  --subnet "$SUBNET_NAME" \
  --public-ip-address "" \
  --nsg "" \
  --custom-data "$TMP_DIR/cloud-init.yaml" \
  --security-type Standard \
  --tags $TAGS \
  --output jsonc

PRIVATE_IP="$(az vm show -d -g "$RESOURCE_GROUP" -n "$VM_NAME" --query privateIps -o tsv)"

echo
echo "VM deployment complete (VNet-only, no public IP)."
echo
echo "  Private IP:       ${PRIVATE_IP}"
echo "  VNet/Subnet:      ${VNET_NAME}/${SUBNET_NAME}"
echo "  Guardian (VNet):  http://${PRIVATE_IP}:3899"
echo "  OpenPalm CLI:     ${OPENPALM_INSTALL_DIR}/openpalm"
echo
echo "SSH via Azure CLI (no public IP required):"
echo "  az ssh vm -g ${RESOURCE_GROUP} -n ${VM_NAME}"
echo
echo "Cloud-init is still running. After SSH, monitor with:"
echo "  sudo tail -f /var/log/cloud-init-output.log"
echo "  sudo tail -f /var/log/openpalm-bootstrap.log"
echo
