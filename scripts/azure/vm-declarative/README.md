# Azure VM Deployment (Declarative)

Deploy OpenPalm to a single Azure VM with one command.

## What gets created

| Resource | Purpose |
|----------|---------|
| Resource Group | Container for all resources |
| Key Vault | Stores secrets (API keys, tokens) |
| VNet + Subnet + NSG | Private network; only guardian port 3899 within VNet |
| Storage Account + File Share | Daily backups |
| Ubuntu 24.04 VM | Runs the OpenPalm Docker Compose stack |

No public IP. SSH via `az ssh vm` (Entra ID).

## Prerequisites

- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) logged in
- An Azure subscription
- A setup spec (see `setup-spec.example.yaml`)

## Quick start

```bash
cp setup.env.example setup.env
cp secrets.env.example secrets.env
cp setup-spec.example.yaml my-setup.yaml

# Edit all three, then:
./deploy.sh
```

## Configuration

### setup.env — deployment config

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AZURE_SUBSCRIPTION_ID` | Yes | | Azure subscription |
| `SETUP_SPEC_FILE` | Yes | | Path to setup spec YAML |
| `LOCATION` | No | `eastus` | Azure region |
| `RESOURCE_GROUP` | No | `rg-openpalm-vm` | Resource group name |
| `ADMIN_USERNAME` | No | `openpalm` | VM admin user |
| `OPENPALM_VERSION` | No | `v0.10.0` | OpenPalm release |
| `STORAGE_NAME` | No | `stopenpalm` | Storage account (globally unique) |
| `BACKUP_SHARE` | No | `openpalm-backups` | Azure Files share name |
| `KV_NAME` | No | `kv-openpalm` | Key Vault name (globally unique) |

### secrets.env — secret values

Contains actual secret values (`OP_ADMIN_TOKEN`, `OPENAI_API_KEY`, etc.).
Env var names match `PROVIDER_KEY_MAP`. Stored in Key Vault.
Fetched by the VM at boot and sourced into the install environment.

### setup spec — instance config (v2 SetupSpec)

Defines capabilities, owner, and provider connections. Contains NO secrets.
The spec goes in cloud-init (safe). At boot, `first-boot.sh` sources
secrets from Key Vault into env vars, then runs `openpalm install --file`.
The install command resolves API keys and tokens from the environment.

## How it works

1. `deploy.sh` stores `secrets.env` in Key Vault, embeds the spec (no secrets) in cloud-init, deploys Bicep
2. Bicep provisions infra + grants VM managed identity read access to Key Vault
3. `first-boot.sh` installs Docker, fetches secrets from KV into env, runs `openpalm install --file`
4. `backup.sh` runs daily at 3 AM UTC via cron

## After deployment

```bash
az ssh vm -g rg-openpalm-vm -n openpalm-vm
sudo tail -f /var/log/openpalm-bootstrap.log
```

## Tear down

```bash
az group delete --name rg-openpalm-vm --yes --no-wait
az keyvault purge --name kv-openpalm   # free up the globally-unique name
```

## Files

| File | Purpose |
|------|---------|
| `deploy.sh` | Entry point |
| `setup.env.example` | Deployment config template |
| `secrets.env.example` | Secret values template (stored in KV) |
| `setup-spec.example.yaml` | v2 SetupSpec (no secrets — API keys come from env) |
| `main.bicep` | Azure infrastructure |
| `main.bicepparam` | Bicep parameter defaults |
| `first-boot.sh` | VM bootstrap: Docker, KV secrets into env, install |
| `backup.sh` | Daily backup to Azure Files |
