# Azure VM Deployment (Declarative)

Deploy OpenPalm to a single Azure VM with one command. The script provisions
all infrastructure via Bicep and bootstraps the stack automatically on first boot.

## What gets created

| Resource | Purpose |
|----------|---------|
| Resource Group | Container for all resources |
| Key Vault | Stores your setup spec (API keys, tokens) |
| VNet + Subnet + NSG | Private network; only guardian port 3899 open within VNet |
| Storage Account + File Share | Daily encrypted backups |
| Ubuntu 24.04 VM | Runs the OpenPalm Docker Compose stack |

The VM has no public IP. SSH access is via `az ssh vm` (Entra ID authentication).

## Prerequisites

- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) (`az`) installed and logged in
- An Azure subscription with permission to create resources
- A setup spec file with your configuration (see `setup-spec.example.yaml`)

## Quick start

```bash
# 1. Create your config files
cp setup.env.example setup.env
cp setup-spec.example.yaml my-setup.yaml

# 2. Edit both files with your real values
#    - setup.env: subscription ID, file path, optional overrides
#    - my-setup.yaml: LLM connections, API keys, channel tokens

# 3. Deploy
./deploy.sh
```

## Configuration

### setup.env

All variables for `deploy.sh` can be set in a `setup.env` file (ignored by git).
Environment variables already set in your shell take precedence over the file.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AZURE_SUBSCRIPTION_ID` | Yes | | Azure subscription to deploy into |
| `SETUP_SPEC_FILE` | Yes | | Path to your setup spec YAML |
| `LOCATION` | No | `eastus` | Azure region |
| `RESOURCE_GROUP` | No | `rg-openpalm-vm` | Resource group name |
| `ADMIN_USERNAME` | No | `openpalm` | VM admin user |
| `OPENPALM_VERSION` | No | `v0.10.0` | OpenPalm release to install |
| `STORAGE_NAME` | No | `stopenpalm` | Storage account name (globally unique) |
| `BACKUP_SHARE` | No | `openpalm-backups` | Azure Files share name |
| `KV_NAME` | No | `kv-openpalm` | Key Vault name (globally unique) |

> `KV_NAME` and `STORAGE_NAME` must be globally unique in Azure. Override them
> if deploying multiple instances or if the defaults are taken.

### Setup spec

The setup spec (`setup-spec.example.yaml`) defines your OpenPalm instance:
connections, API keys, channels, memory settings, etc. See the example file
for the full schema.

This file contains secrets. It is stored in Azure Key Vault at deploy time
and fetched by the VM via managed identity at boot. It never appears in
cloud-init customData, IMDS, or deployment logs.

## What happens during deployment

1. **deploy.sh** creates the resource group, Key Vault, and stores your setup spec as a secret
2. **Bicep** (`main.bicep`) provisions the VNet, NSG, storage, NIC, and VM
3. **Bicep** adds a Key Vault access policy granting the VM's managed identity read access
4. **cloud-init** runs on first boot: installs packages, writes config and scripts
5. **first-boot.sh** installs Docker, fetches the setup spec from Key Vault, and runs `openpalm install`
6. **backup.sh** is installed as a daily cron job (3 AM UTC) backing up to Azure Files

## After deployment

```bash
# SSH into the VM (no public IP — uses Entra ID via Azure CLI)
az ssh vm -g rg-openpalm-vm -n openpalm-vm

# Watch bootstrap progress
sudo tail -f /var/log/openpalm-bootstrap.log

# Check the stack
docker compose ls
docker compose ps
```

## Tear down

```bash
az group delete --name rg-openpalm-vm --yes --no-wait
```

This deletes all resources including the Key Vault (soft-deleted for 90 days).
To permanently purge the Key Vault name for reuse:

```bash
az keyvault purge --name kv-openpalm
```

## Files

| File | Purpose |
|------|---------|
| `deploy.sh` | Entry point: builds cloud-init, creates KV, deploys Bicep |
| `setup.env.example` | Template for deployment variables |
| `setup-spec.example.yaml` | Template for OpenPalm instance configuration |
| `main.bicep` | Azure infrastructure (VNet, NSG, storage, VM, RBAC) |
| `main.bicepparam` | Bicep parameter defaults |
| `first-boot.sh` | VM bootstrap: Docker install, KV fetch, `openpalm install` |
| `backup.sh` | Daily backup script (cron, managed identity, Azure Files) |
