# Simplified Azure Container Apps Deployment Plan

## Goals

- Remove memory and scheduler containers from the Azure deployment.
- Keep only assistant and guardian.
- Expose the assistant's OpenCode webserver as the default ACA ingress, restricted to an explicit IP allowlist.
- Eliminate the VM entirely — deploy purely on Azure Container Apps.
- Add an hourly AKM database backup job that syncs `/home/opencode/.akm` to an Azure File Share and retains 7 days of rolling copies.

## Architecture

```
Internet
    │
    ▼ (HTTPS, IP-allowlisted)
ACA Ingress — openpalm-assistant
    OpenCode web UI  :4096
    │
    │ internal ACA DNS (assistant_net equivalent)
    ▼
openpalm-guardian  :8080  (internal-only ingress)
    HMAC validation, audit logging
    ↔ routes to openpalm-assistant:4096

openpalm-akm-backup  (ACA Scheduled Job)
    cron: 0 * * * *  (every hour)
    mounts: openpalm-stash (ro) → openpalm-akm-backups (rw)
    retains: 7 days of timestamped snapshots
```

Guardian has no external ingress in this deployment. It remains internal for any channel integrations added later. The OpenCode web server on the assistant is the only publicly reachable endpoint and is guarded by an ACA IP security restriction allowlist.

## Azure Resources

| Resource | Type | Notes |
|---|---|---|
| `rg-openpalm` | Resource Group | All resources in one group for easy teardown |
| `openpalm-env` | ACA Environment | Shared environment; enables internal DNS between apps |
| `openpalm-assistant` | Container App | External ingress, IP-restricted, single replica |
| `openpalm-guardian` | Container App | Internal ingress only |
| `openpalm-akm-backup` | ACA Scheduled Job | Hourly cron, alpine/busybox image |
| `openpalmstore<suffix>` | Storage Account | Azure Files backend for all shares |
| `kv-openpalm-<suffix>` | Key Vault | All runtime secrets; no inline secrets in YAML |
| `id-openpalm` | User-assigned Managed Identity | Grants apps Key Vault Secrets User role |

### Azure Files Shares

| Share name | Mounted in | Container path | Access |
|---|---|---|---|
| `openpalm-assistant-home` | assistant | `/home/opencode` | rw |
| `openpalm-config` | assistant | `/etc/openpalm` | ro |
| `openpalm-work` | assistant | `/work` | rw |
| `openpalm-logs` | assistant | `/home/opencode/.local/state/opencode` | rw |
| `openpalm-stash` | assistant, akm-backup | `/home/opencode/.akm` (assistant, rw), `/source` (job, ro) | rw / ro |
| `openpalm-guardian-data` | guardian | `/app/data` | rw |
| `openpalm-guardian-logs` | guardian | `/app/audit` | rw |
| `openpalm-akm-backups` | akm-backup | `/backup` | rw |

The `openpalm-stash` share is the live AKM database directory. The backup job mounts it read-only so it never interferes with the assistant's writes.

## Key Vault Secrets

All secrets are written to Key Vault during `setup` before any apps are deployed. The managed identity is attached to every app and job; no inline secret values appear in any YAML or script log.

| Secret name | Consumer | Description |
|---|---|---|
| `opencode-password` | assistant | `OPENCODE_PASSWORD` — required when `OPENCODE_AUTH=true` |
| `assistant-token` | assistant, guardian | `OP_ASSISTANT_TOKEN` / guardian's outbound auth |
| `guardian-channel-secrets` | guardian | `guardian.env` content or per-channel secrets |
| `openai-api-key` | assistant | Primary LLM provider key |
| `anthropic-api-key` | assistant | Alternate provider key |
| `<additional provider keys>` | assistant | Any other active provider keys |

Token scoping rule: guardian receives only the secrets it needs to validate and forward requests. Assistant receives only the LLM provider key for the configured `SYSTEM_LLM_PROVIDER`; unused provider keys are unset at startup by the existing `maybe_unset_unused_provider_keys` logic in `entrypoint.sh`.

## Container App: assistant

### Ingress

```yaml
ingress:
  external: true
  targetPort: 4096
  transport: auto
  ipSecurityRestrictions:
    - name: allow-<label>
      ipAddressRange: "<CIDR>"
      action: Allow
    # repeat for each allowed CIDR
```

ACA's allowlist behaviour: when any `Allow` rules are present, all traffic not matching a listed CIDR is automatically denied. No explicit `Deny 0.0.0.0/0` rule is needed.

The allowed IP list is supplied to the deploy script as `OP_ALLOWED_IPS`, a comma-separated list of CIDRs (e.g. `1.2.3.4/32,5.6.7.8/32`). The script emits one `ipSecurityRestrictions` entry per CIDR.

### Environment Changes vs. core.compose.yml

- `OPENCODE_AUTH=true` — **required**; the server is externally reachable, authentication must be on.
- `OPENCODE_PASSWORD` — sourced from Key Vault secret `opencode-password`.
- Remove `MEMORY_API_URL` and `MEMORY_AUTH_TOKEN` — memory container is not deployed.
- Remove `MEMORY_USER_ID` — unused without memory.
- Remove `depends_on: memory` — no longer applicable.
- `OP_ADMIN_API_URL` — leave empty; assistant admin tools already fail gracefully when Admin is absent.

All other env vars (LLM provider keys, AKM paths, Google/Microsoft credential paths) are unchanged. Provider credential files that live in `vault/user/` in self-hosted deployments are handled in ACA via Key Vault secrets or operator-seeded files on the `openpalm-config` share.

### Sizing

```yaml
resources:
  cpu: 2.0
  memory: 4Gi
scale:
  minReplicas: 1
  maxReplicas: 1
```

Single replica enforced: OpenCode maintains per-session state in the mounted home volume. Multi-replica would require session affinity and is out of scope.

### Health probe

Existing healthcheck maps directly to an ACA HTTP probe:

```yaml
probes:
  - type: liveness
    httpGet:
      path: /health
      port: 4096
    initialDelaySeconds: 30
    periodSeconds: 30
    failureThreshold: 5
  - type: readiness
    httpGet:
      path: /health
      port: 4096
    initialDelaySeconds: 30
    periodSeconds: 30
    failureThreshold: 5
```

## Container App: guardian

### Ingress

Internal only — no `external: true`. Guardian is reachable within the ACA environment at `https://openpalm-guardian.internal.<env-domain>:443`.

```yaml
ingress:
  external: false
  targetPort: 8080
  transport: http
```

### Environment

`OP_ASSISTANT_URL` is set to the internal FQDN of the assistant app, resolved at deploy time from `az containerapp show`:

```
OP_ASSISTANT_URL=https://openpalm-assistant.internal.<env-domain>
```

All channel HMAC secrets come from Key Vault via managed identity references.

### Sizing

```yaml
resources:
  cpu: 0.25
  memory: 0.5Gi
scale:
  minReplicas: 1
  maxReplicas: 1
```

## ACA Scheduled Job: akm-backup

### Purpose

Every hour, copy the contents of the live AKM stash directory to a timestamped snapshot on the backup share, then prune snapshots older than 7 days.

### Schedule

```
0 * * * *
```

### Image

`busybox:latest` or `alpine:3` (no custom build needed).

### Volume mounts

| Share | Mount path | Mode |
|---|---|---|
| `openpalm-stash` | `/source` | ro |
| `openpalm-akm-backups` | `/backup` | rw |

### Job script

```sh
#!/bin/sh
set -eu

SNAPSHOT="snapshot-$(date -u +%Y%m%dT%H%M%SZ)"
DEST="/backup/${SNAPSHOT}"
STAGING="${DEST}.tmp"

# Copy to a staging directory first, then rename to make the
# snapshot appear atomically. SQLite WAL files are copied together
# with the main db file to keep the snapshot consistent.
cp -a /source/. "${STAGING}/"
mv "${STAGING}" "${DEST}"

# Prune snapshots older than 7 days. find with -mtime +7 matches
# directories whose modification time is more than 7*24h ago.
find /backup -maxdepth 1 -name 'snapshot-*' -type d -mtime +7 \
  -exec rm -rf {} +

echo "Backup complete: ${SNAPSHOT}"
find /backup -maxdepth 1 -name 'snapshot-*' -type d | sort
```

The staging-then-rename pattern avoids leaving a partial snapshot visible to any monitoring that reads the backup share. Note that because Azure Files does not support atomic rename across directories in all SMB configurations, the script uses a `.tmp` suffix convention; operators should treat any `*.tmp` directories as incomplete and safe to delete.

### SQLite safety note

If the AKM database uses WAL mode, the `.db`, `.db-wal`, and `.db-shm` files must all be present in the snapshot together. The `cp -a /source/.` command copies the entire directory, so all three files are captured in the same pass. A brief window of inconsistency is possible (e.g. a write commits between copying the main db and the WAL file). For the assistant-only deployment, this is acceptable: the backup is a recovery aid, not a transactional replica. Operators needing stronger consistency can use the `VACUUM INTO` SQLite command via the assistant before triggering a backup.

### Retry policy

```yaml
retryPolicy:
  maxRetries: 3
  retryDelay: 30s
```

### Sizing

```yaml
resources:
  cpu: 0.25
  memory: 0.5Gi
```

## Deployment Script: deploy/azure/deploy-aca.sh

### Subcommands

| Subcommand | Action |
|---|---|
| `setup` | Provision resource group, storage account, file shares, Key Vault, managed identity; write all secrets to Key Vault; seed directory structure on shares |
| `deploy` | Generate and apply ACA app YAML for assistant and guardian; create akm-backup scheduled job |
| `all` | `setup` then `deploy` |
| `update-ips` | Update the IP allowlist on the assistant ingress without redeploying the full app |
| `status` | Print running state of both apps and last backup job execution |
| `teardown` | Delete the resource group and all contained resources |

### Required inputs (environment variables or flags)

| Variable | Description |
|---|---|
| `AZURE_RESOURCE_GROUP` | Resource group name (default: `rg-openpalm`) |
| `AZURE_LOCATION` | Region (e.g. `eastus`) |
| `AZURE_SUBSCRIPTION` | Subscription ID |
| `OP_IMAGE_TAG` | Image tag to deploy (default: `latest`) |
| `OP_IMAGE_NAMESPACE` | Registry namespace/prefix (default: `openpalm`) |
| `OP_ALLOWED_IPS` | Comma-separated list of allowed CIDRs for assistant ingress |
| `OP_OPENCODE_PASSWORD` | Password for OpenCode web UI (will be stored in Key Vault) |
| `OP_ASSISTANT_TOKEN` | Assistant token for guardian→assistant auth |
| `SYSTEM_LLM_PROVIDER` | Active LLM provider name |
| `<PROVIDER>_API_KEY` | API key for the active provider |

### Script conventions

- Use `az` CLI argument arrays, not inline interpolation, for any value that could contain special characters or secrets.
- Generate per-app YAML to `deploy/azure/apps/` (gitignored rendered output; checked-in templates only).
- Validate with `shellcheck` before committing.
- Print all provisioned resource names and the assistant ingress URL on successful `deploy`; never print secret values.

## Deliverables

```
deploy/azure/
├── PLAN.md                        (this file)
├── README.md                      (operator guide)
├── deploy-aca.sh                  (main deployment script)
├── apps/
│   ├── assistant.yaml             (ACA app template)
│   └── guardian.yaml              (ACA app template)
└── jobs/
    └── akm-backup.yaml            (ACA scheduled job template)
```

## What This Removes vs. Issue #315

| #315 scope | This plan |
|---|---|
| `memory` container | Removed |
| `scheduler` container | Removed |
| `channel-chat` container and add-channel flow | Removed (no channels in simplified deployment) |
| Guardian as the only external ingress | Changed — assistant is the external ingress |
| Admin-less runtime with memory persistence | Memory dropped; AKM stash on Azure Files is the primary persistence |

Guardian is retained as an internal service available for future channel additions. The `add-channel` workflow is deferred until channel support is re-introduced.

## Deviations from Self-Hosted Model

| Self-hosted | ACA |
|---|---|
| `~/.openpalm/vault/stack/stack.env` | Key Vault secrets via managed identity |
| `~/.openpalm/data/stash` | `openpalm-stash` Azure Files share |
| Init service creates data dirs | `setup` subcommand seeds shares before first deploy |
| Guardian is LAN-only by network topology | Guardian has internal ACA ingress; no external route |
| No inbound authentication on assistant (127.0.0.1 only) | `OPENCODE_AUTH=true` mandatory; IP allowlist on ACA ingress |
| Memory service provides vector persistence | No memory service; AKM SQLite on Azure Files is sole persistence |

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| OpenCode auth disabled by default | Plan mandates `OPENCODE_AUTH=true`; deploy script validates this and refuses to proceed without a password |
| IP allowlist misconfiguration locks out operator | `update-ips` subcommand for safe updates; `setup` documents how to add the operator's current IP |
| AKM snapshot inconsistency during write | Staging-then-rename pattern; operator guidance on `VACUUM INTO` for hard consistency |
| Stale `.tmp` backup directories | Job README notes they are safe to delete; backup prune step only targets `snapshot-*` pattern |
| Azure Files SMB lock contention | Assistant mounts stash rw; backup job mounts stash ro; reads on SMB don't block writes |
| Single replica constraint | Documented explicitly; `maxReplicas: 1` enforced in YAML; scale-out requires session affinity work outside this plan's scope |
