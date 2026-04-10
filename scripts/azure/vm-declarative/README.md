# Azure VM Deployment (Declarative)

Deploy OpenPalm to a single Azure VM with one command.

## What gets created

| Resource | Purpose |
|----------|---------|
| Resource Group | Container for all resources |
| Key Vault | Stores secrets (API keys, tokens) |
| VNet + Subnet + NSG | Private network; only guardian port 3899 within VNet |
| Storage Account + File Shares | `openpalm` (data, mounted on VM) + `openpalm-backups` (daily backups) |
| Ubuntu 24.04 VM | Runs the OpenPalm Docker Compose stack |

No public IP. SSH via `az ssh vm` (Entra ID).

## Prerequisites

- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) logged in
- An Azure subscription
- An Azure AI Foundry resource with model deployments (gpt-5.3-chat, gpt-4.1-mini, text-embedding-3-large)

## Quick start

```bash
cp deploy.env.example deploy.env
cp example.spec.yaml deploy.spec.yaml

# Edit both, then:
./deploy.sh
```

## Configuration

### deploy.env

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AZURE_SUBSCRIPTION_ID` | Yes | | Azure subscription |
| `SETUP_SPEC_FILE` | Yes | `./deploy.spec.yaml` | Path to setup spec YAML |
| `OP_ADMIN_TOKEN` | Yes | | Admin API token (stored in KV) |
| `AZURE_OPENAI_API_KEY` | Yes | | Azure AI Foundry API key (stored in KV) |
| `AZURE_RESOURCE_NAME` | Yes | | AI Foundry resource name (e.g. `ai-myproject-eastus2`) |
| `LOCATION` | No | `eastus2` | Azure region |
| `RESOURCE_GROUP` | No | `rg-openpalm-vm` | Resource group name |
| `ADMIN_USERNAME` | No | `openpalm` | VM admin user |
| `OPENPALM_VERSION` | No | `v0.10.2` | OpenPalm release |
| `STORAGE_NAME` | No | `stopenpalm` | Storage account (globally unique) |
| `BACKUP_SHARE` | No | `openpalm-backups` | Backup file share name |
| `DATA_SHARE` | No | `openpalm` | Data file share name (mounted at `/mnt/openpalm`) |
| `KV_NAME` | No | `kv-openpalm` | Key Vault name (globally unique) |

Secret variables (API keys, tokens, channel credentials) are automatically
extracted and stored in Key Vault. The VM fetches them at boot via managed
identity and sources them into the install environment.

### deploy.spec.yaml

Defines capabilities, owner, and provider connections. Contains NO secrets.
See `example.spec.yaml`.

## Azure AI Foundry

The deployment uses Azure AI Foundry for all LLM and embedding capabilities:

- **Memory LLM**: `gpt-41-mini` (gpt-4.1-mini) — uses `max_tokens` which newer GPT-5.x models reject
- **Memory Embeddings**: `text-embedding-3-large` (3072 dims)
- **Assistant LLM**: `gpt-5.3-chat` — configured via OpenCode user config, uses `@ai-sdk/openai-compatible` through a local proxy

### Azure proxy (`azure-proxy.ts`)

Azure OpenAI requires `?api-version=` on every request. OpenCode's built-in
`azure` provider doesn't support the Responses API, and `@ai-sdk/openai-compatible`
can't add query parameters. A lightweight Bun proxy runs inside the assistant
container to bridge the gap:

- Adds `?api-version=2024-10-21` to all requests
- Rewrites `max_tokens` to `max_completion_tokens` (required by GPT-5.x models)
- Strips unsupported parameters (`reasoningSummary`)
- Authenticates with `api-key` header

The proxy is started automatically via `fileshare.compose.yml` entrypoint override.

## How it works

1. `deploy.sh` extracts secrets from `deploy.env` into Key Vault, embeds the spec in cloud-init, deploys Bicep
2. Bicep provisions infra (VM, VNet, KV, Storage + file shares) + grants VM managed identity access
3. `vm/first-boot.sh`:
   - Installs Docker and cifs-utils
   - Fetches secrets from KV via managed identity
   - Mounts the `openpalm` data file share at `/mnt/openpalm`
   - Runs `openpalm install --file` with the spec
   - Creates the Azure proxy script, OpenCode config, and `fileshare.compose.yml`
   - Starts the full Docker Compose stack (core + addons + fileshare overlay)
4. `vm/backup.sh` runs daily at 3 AM UTC via cron

## After deployment

```bash
# Run commands on the VM (no VPN/Bastion needed):
az vm run-command invoke -g openpalm-rg -n openpalm-vm \
  --command-id RunShellScript --scripts "COMMAND" \
  --query value[0].message -o tsv

# Check bootstrap progress:
... --scripts "tail -40 /var/log/openpalm-bootstrap.log"

# Check stack health:
... --scripts "sudo -u openpalm docker ps"

# SSH key saved to deploy.key (for use with VPN/Bastion if added later)
```

## Tear down

```bash
az group delete --name rg-openpalm-vm --yes --no-wait
az keyvault purge --name kv-openpalm   # free up the globally-unique name
```

## Files

```
deploy.sh               Entry point (run on your machine)
deploy.env.example      All config: Azure settings + secrets
example.spec.yaml       Template for deploy.spec.yaml (no secrets)
main.bicep              Azure infrastructure (VM, VNet, KV, Storage, RBAC)
vm/
  first-boot.sh         VM bootstrap: Docker, KV secrets, file share, Azure proxy, install
  backup.sh             Daily backup to Azure Files
```
