# Simplified Azure Container Apps Deployment Plan

## Goals

- Remove memory and scheduler containers from the Azure deployment.
- Keep only assistant and guardian.
- Expose the assistant's OpenCode webserver as the default ACA ingress, restricted to an explicit IP allowlist.
- Eliminate the VM entirely — deploy purely on Azure Container Apps.
- Add an hourly AKM database backup that safely snapshots the SQLite database in `$HOME/.local/state` to an Azure File Share and retains 7 days of rolling copies. The backup runs as a sidecar container inside the assistant app so it has direct filesystem access and can use SQLite's online backup API without raw file copying.

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

akm-backup  (sidecar in openpalm-assistant)
    runs every hour inside the assistant app
    reads $HOME/.local/state/*.db via shared home volume
    writes to openpalm-akm-backups share
    retains 7 days of timestamped snapshots
```

Guardian has no external ingress in this deployment. It remains internal for any channel integrations added later. The OpenCode web server on the assistant is the only publicly reachable endpoint and is guarded by an ACA IP security restriction allowlist.

## Azure Resources

| Resource | Type | Notes |
|---|---|---|
| `rg-openpalm` | Resource Group | All resources in one group for easy teardown |
| `openpalm-env` | ACA Environment | Shared environment; enables internal DNS between apps |
| `openpalm-assistant` | Container App | External ingress, IP-restricted, single replica; includes `akm-backup` sidecar |
| `openpalm-guardian` | Container App | Internal ingress only |
| `openpalmstore<suffix>` | Storage Account | Azure Files backend for all shares |
| `kv-openpalm-<suffix>` | Key Vault | All runtime secrets; no inline secrets in YAML |
| `id-openpalm` | User-assigned Managed Identity | Grants apps Key Vault Secrets User role |

### Azure Files Shares

| Share name | Mounted in | Container path | Access |
|---|---|---|---|
| `openpalm-assistant-home` | opencode (main), akm-backup (sidecar) | `/home/opencode` | rw (main), ro (sidecar) |
| `openpalm-config` | opencode (main) | `/etc/openpalm` | ro |
| `openpalm-work` | opencode (main) | `/work` | rw |
| `openpalm-logs` | opencode (main) | `/home/opencode/.local/state/opencode` | rw |
| `openpalm-stash` | opencode (main) | `/home/opencode/.akm` | rw |
| `openpalm-guardian-data` | guardian | `/app/data` | rw |
| `openpalm-guardian-logs` | guardian | `/app/audit` | rw |
| `openpalm-akm-backups` | akm-backup (sidecar) | `/backup` | rw |

The AKM SQLite database lives under `$HOME/.local/state/` inside the main opencode container, which is part of the `openpalm-assistant-home` share. The sidecar mounts that same share read-only so it can never write to or corrupt the live database. Backups are written to the separate `openpalm-akm-backups` share.

The `openpalm-logs` share overlays a subdirectory of the home share (`/home/opencode/.local/state/opencode`). The AKM database is NOT inside that subdirectory; it sits directly under `.local/state/` and is therefore visible to the sidecar through the home share mount.

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

## Sidecar Container: akm-backup

### Why a sidecar, not a separate ACA job

The AKM database is a live SQLite file inside the assistant container's filesystem. A separate ACA job can only see it via an Azure Files share mount, which means the job would be doing a raw file copy of a potentially open database — guaranteed to produce a corrupt snapshot if a write is in flight.

Running the backup as a sidecar container inside the same ACA app gives it two things a separate job cannot have:

1. **SQLite's online backup API** — `sqlite3 source.db ".backup 'dest.db'"` uses the SQLite Online Backup API, which creates a consistent snapshot even under concurrent write activity, respects WAL mode checkpointing, and never requires an exclusive lock.
2. **Shared volume mount** — the sidecar mounts `openpalm-assistant-home` read-only, giving it direct access to the live database path without any intermediate copy step.

### Image

`alpine:3` with `apk add sqlite` added at build time, or any image that provides the `sqlite3` CLI. No custom image is required; a Dockerfile for the sidecar lives at `deploy/azure/sidecar/Dockerfile`.

### Volume mounts (sidecar only)

| Share | Mount path | Mode |
|---|---|---|
| `openpalm-assistant-home` | `/home/opencode` | ro |
| `openpalm-akm-backups` | `/backup` | rw |

### Backup script

```sh
#!/bin/sh
set -eu

# Operator sets AKM_DB_PATH to the exact SQLite file path.
# Default assumes a single db directly under .local/state/.
AKM_DB_PATH="${AKM_DB_PATH:-/home/opencode/.local/state/akm.db}"
BACKUP_ROOT="/backup"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-3600}"

run_backup() {
  if [ ! -f "${AKM_DB_PATH}" ]; then
    echo "AKM db not found at ${AKM_DB_PATH}, skipping"
    return 0
  fi

  SNAPSHOT="${BACKUP_ROOT}/snapshot-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "${SNAPSHOT}"

  # SQLite online backup API. Creates a consistent snapshot of a live,
  # potentially write-active database without requiring an exclusive lock.
  # Works correctly with WAL mode — the WAL is checkpointed into the copy.
  sqlite3 "${AKM_DB_PATH}" ".backup '${SNAPSHOT}/akm.db'"

  # Prune snapshots older than 7 days.
  find "${BACKUP_ROOT}" -maxdepth 1 -name 'snapshot-*' -type d -mtime +7 \
    -exec rm -rf {} +

  echo "Backup complete: ${SNAPSHOT}"
}

# Run once immediately on startup, then every INTERVAL seconds.
run_backup
while true; do
  sleep "${INTERVAL}"
  run_backup
done
```

`AKM_DB_PATH` is passed as an environment variable on the sidecar container so the path can be overridden without rebuilding the image. The operator should confirm the exact filename; if AKM creates multiple database files under `.local/state/`, extend the script to iterate over `*.db` files in that directory.

### Sidecar container definition (within assistant.yaml)

```yaml
containers:
  - name: opencode
    image: <registry>/assistant:<tag>
    # ... main container config ...
    volumeMounts:
      - volumeName: assistant-home
        mountPath: /home/opencode
      # ... other mounts ...

  - name: akm-backup
    image: <registry>/akm-backup-sidecar:<tag>
    env:
      - name: AKM_DB_PATH
        value: /home/opencode/.local/state/akm.db
    volumeMounts:
      - volumeName: assistant-home
        mountPath: /home/opencode
        readOnly: true
      - volumeName: akm-backups
        mountPath: /backup
    resources:
      cpu: 0.25
      memory: 0.5Gi
```

Volumes are defined at the app level and shared across both containers; only the mount mode (readOnly) differs.

### Sidecar lifecycle

The sidecar starts and stops with the assistant app revision. If the sidecar crashes, ACA restarts only the sidecar container, not the main opencode process — this is the standard ACA multi-container behaviour. The sidecar has no liveness probe; a failed backup logs an error and retries on the next hourly cycle rather than killing the container.

## Deployment Script: deploy/azure/deploy-aca.sh

### Subcommands

| Subcommand | Action |
|---|---|
| `setup` | Provision resource group, storage account, file shares, Key Vault, managed identity; write all secrets to Key Vault; seed directory structure on shares |
| `deploy` | Generate and apply ACA app YAML for assistant (including akm-backup sidecar) and guardian |
| `all` | `setup` then `deploy` |
| `update-ips` | Update the IP allowlist on the assistant ingress without redeploying the full app |
| `status` | Print running state of both apps and last backup log from the akm-backup sidecar |
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
│   ├── assistant.yaml             (ACA app template — includes akm-backup sidecar)
│   └── guardian.yaml              (ACA app template)
└── sidecar/
    ├── Dockerfile                 (alpine + sqlite3 for akm-backup sidecar)
    └── backup.sh                  (backup script baked into sidecar image)
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
| `~/.openpalm/data/stash` | `openpalm-stash` Azure Files share (AKM stash artifacts, not the db) |
| Init service creates data dirs | `setup` subcommand seeds shares before first deploy |
| Guardian is LAN-only by network topology | Guardian has internal ACA ingress; no external route |
| No inbound authentication on assistant (127.0.0.1 only) | `OPENCODE_AUTH=true` mandatory; IP allowlist on ACA ingress |
| Memory service provides vector persistence | No memory service; AKM SQLite in `$HOME/.local/state` (on home share) is sole persistence |

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| OpenCode auth disabled by default | Plan mandates `OPENCODE_AUTH=true`; deploy script validates this and refuses to proceed without a password |
| IP allowlist misconfiguration locks out operator | `update-ips` subcommand for safe updates; `setup` documents how to add the operator's current IP |
| AKM db corruption during backup | SQLite `.backup` command uses the online backup API — no raw file copy, no exclusive lock required, WAL-safe |
| Sidecar crashes and disrupts assistant | ACA restarts only the crashed sidecar container; the main opencode process is unaffected |
| AKM_DB_PATH wrong at first deploy | Sidecar logs "db not found" and skips gracefully; operator corrects the env var and restarts the revision |
| Azure Files SMB lock contention | Home share: main container rw, sidecar ro — SMB read-only mounts never block concurrent writes |
| Single replica constraint | Documented explicitly; `maxReplicas: 1` enforced in YAML; scale-out requires session affinity work outside this plan's scope |
