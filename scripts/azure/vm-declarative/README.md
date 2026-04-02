# Azure VM Deployment (Declarative)

Deploy OpenPalm to a single Azure VM with one command.

## What gets created

| Resource | Purpose |
|----------|---------|
| Resource Group | Container for all resources |
| Key Vault | Stores secrets (API keys, tokens) |
| VNet + Subnet + NSG | Network; ports 80/443 open to internet, 3899 within VNet |
| Public IP | Static IP for inbound HTTPS (Caddy / Let's Encrypt) |
| Storage Account + File Share | Daily backups |
| Ubuntu 24.04 VM | Runs the OpenPalm Docker Compose stack |

The VM has a public IP with ports 80/443 open for Caddy HTTPS.
SSH is still via `az ssh vm` (Entra ID) — port 22 is not exposed.

## Prerequisites

- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) logged in
- An Azure subscription

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
| `OPENAI_API_KEY` | Yes | | LLM provider key (stored in KV) |
| `LOCATION` | No | `eastus` | Azure region |
| `RESOURCE_GROUP` | No | `rg-openpalm-vm` | Resource group name |
| `ADMIN_USERNAME` | No | `openpalm` | VM admin user |
| `OPENPALM_VERSION` | No | `v0.10.0` | OpenPalm release |
| `STORAGE_NAME` | No | `stopenpalm` | Storage account (globally unique) |
| `BACKUP_SHARE` | No | `openpalm-backups` | Azure Files share name |
| `KV_NAME` | No | `kv-openpalm` | Key Vault name (globally unique) |
| `CADDY_GUARDIAN_FQDN` | No | | FQDN for guardian (webhook/channel endpoint) |
| `CADDY_ADMIN_FQDN` | No | | FQDN for admin panel |
| `CADDY_ASSISTANT_FQDN` | No | | FQDN for assistant API |
| `CADDY_EMAIL` | No | | Email for Let's Encrypt notifications |

Setting any `CADDY_*_FQDN` variable enables Caddy reverse proxy with
automatic HTTPS via Let's Encrypt. Each FQDN gets its own TLS certificate.

**DNS requirement:** Create A records pointing each FQDN at the VM's public
IP address (shown after deployment). Caddy will fail to obtain certificates
until DNS resolves and ports 80/443 are reachable from the internet.

Secret variables (API keys, tokens, channel credentials) are automatically
extracted and stored in Key Vault. The VM fetches them at boot via managed
identity and sources them into the install environment.

### deploy.spec.yaml

Defines capabilities, owner, and provider connections. Contains NO secrets.
See `example.spec.yaml`.

## How it works

1. `deploy.sh` extracts secrets from `deploy.env` into Key Vault, embeds the spec in cloud-init, deploys Bicep
2. Bicep provisions infra (VM, VNet, Public IP, KV, Storage) + grants VM managed identity read access to Key Vault
3. `vm/first-boot.sh` installs Docker, fetches secrets from KV into env, runs `openpalm install --file`
4. If any `CADDY_*_FQDN` is set, installs Caddy and generates a Caddyfile with reverse proxy entries
5. `vm/backup.sh` runs daily at 3 AM UTC via cron

## After deployment

```bash
az ssh vm -g rg-openpalm-vm -n openpalm-vm
sudo tail -f /var/log/openpalm-bootstrap.log
```

### HTTPS with Caddy

If you set `CADDY_*_FQDN` variables, the deploy output will show the public
IP. Create DNS A records pointing your FQDNs at that IP. Caddy will
automatically obtain Let's Encrypt certificates once DNS propagates.

All backend services bind to `127.0.0.1` — only Caddy is exposed to the
internet. The generated Caddyfile maps each FQDN to its service:

| FQDN variable | Proxies to |
|---|---|
| `CADDY_GUARDIAN_FQDN` | `127.0.0.1:3899` (guardian) |
| `CADDY_ADMIN_FQDN` | `127.0.0.1:3880` (admin panel) |
| `CADDY_ASSISTANT_FQDN` | `127.0.0.1:3800` (assistant) |

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
  first-boot.sh         VM bootstrap: Docker, KV secrets, install
  backup.sh             Daily backup to Azure Files
```
