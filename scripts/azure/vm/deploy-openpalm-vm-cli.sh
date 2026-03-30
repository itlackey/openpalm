#!/usr/bin/env bash
set -euo pipefail

# Deploy an Ubuntu 24.04 LTS Azure VM, install Docker + OpenPalm CLI, and run
# `openpalm install --file ...` on first boot via cloud-init.
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
#   export SSH_PUBLIC_KEY_FILE="$HOME/.ssh/id_ed25519.pub"
#   export OPENPALM_VERSION=v0.10.0
#
# Optional image override (must be a Debian-based image):
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
SSH_PUBLIC_KEY_FILE="${SSH_PUBLIC_KEY_FILE:-$HOME/.ssh/id_ed25519.pub}"
OPENPALM_VERSION="${OPENPALM_VERSION:-v0.10.0}"
OPENPALM_INSTALL_DIR="${OPENPALM_INSTALL_DIR:-/home/${ADMIN_USERNAME}/.local/bin}"
OPENPALM_HOME="${OPENPALM_HOME:-/home/${ADMIN_USERNAME}/.openpalm}"
TAGS="${TAGS:-app=openpalm env=dev managed-by=azure-cli}"

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

if [[ ! -f "$SSH_PUBLIC_KEY_FILE" ]]; then
  echo "SSH public key file not found: $SSH_PUBLIC_KEY_FILE" >&2
  exit 1
fi

if [[ ! -f "$CLOUD_INIT_TEMPLATE" ]]; then
  echo "Cloud-init template not found: $CLOUD_INIT_TEMPLATE" >&2
  exit 1
fi

az account set --subscription "$AZURE_SUBSCRIPTION_ID"

echo "Using image URN: $IMAGE_URN"

SETUP_SPEC_B64="$(base64 -w0 "$SETUP_SPEC_FILE")"
SSH_PUBLIC_KEY_CONTENT="$(cat "$SSH_PUBLIC_KEY_FILE")"

export TEMPLATE_ADMIN_USERNAME="$ADMIN_USERNAME"
export TEMPLATE_OPENPALM_VERSION="$OPENPALM_VERSION"
export TEMPLATE_OPENPALM_INSTALL_DIR="$OPENPALM_INSTALL_DIR"
export TEMPLATE_OPENPALM_HOME="$OPENPALM_HOME"
export TEMPLATE_SETUP_SPEC_B64="$SETUP_SPEC_B64"
export TEMPLATE_SSH_PUBLIC_KEY="$SSH_PUBLIC_KEY_CONTENT"
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

echo "Creating VM (size: $VM_SIZE, disk: ${OS_DISK_SIZE}GB)..."
az vm create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$VM_NAME" \
  --location "$LOCATION" \
  --image "$IMAGE_URN" \
  --size "$VM_SIZE" \
  --os-disk-size-gb "$OS_DISK_SIZE" \
  --admin-username "$ADMIN_USERNAME" \
  --ssh-key-values "$SSH_PUBLIC_KEY_FILE" \
  --custom-data "$TMP_DIR/cloud-init.yaml" \
  --public-ip-sku Standard \
  --security-type Standard \
  --tags $TAGS \
  --output jsonc

echo "Opening firewall ports for OpenPalm services..."
az vm open-port \
  --resource-group "$RESOURCE_GROUP" \
  --name "$VM_NAME" \
  --port 3800,3880 \
  --priority 1010 >/dev/null

PUBLIC_IP="$(az vm show -d -g "$RESOURCE_GROUP" -n "$VM_NAME" --query publicIps -o tsv)"

echo
echo "VM deployment complete."
echo "  SSH:              ssh ${ADMIN_USERNAME}@${PUBLIC_IP}"
echo "  Assistant API:    http://${PUBLIC_IP}:3800"
echo "  Admin UI:         http://${PUBLIC_IP}:3880"
echo "  OpenPalm CLI:     ${OPENPALM_INSTALL_DIR}/openpalm"
echo
echo "Cloud-init is still running. Monitor progress with:"
echo "  sudo tail -f /var/log/cloud-init-output.log"
echo "  sudo tail -f /var/log/openpalm-bootstrap.log"
echo
