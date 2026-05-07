# Simplified Azure Container Apps Deployment Plan

## Goals

- Remove memory and scheduler containers from the Azure deployment.
- Keep only assistant and guardian.
- Expose the assistant's OpenCode webserver as the default ACA ingress, restricted to an explicit IP allowlist.
- Eliminate the VM entirely — deploy purely on Azure Container Apps.
- Add an hourly AKM database backup that safely snapshots the SQLite database in `$HOME/.local/state` to an Azure File Share and retains 7 days of rolling copies. The backup runs as a sidecar container inside the assistant app sharing an emptyDir volume, and uses SQLite's online backup API to write consistent snapshots to Azure Files.

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

akm-backup  (sidecar in openpalm-assistant)
    shares emptyDir volume with the opencode container
    runs sqlite3 .backup every hour: emptyDir → Azure Files backup share
    restores from latest backup share snapshot on container cold start
    retains 7 days of timestamped snapshots
```

Guardian has no external ingress in this deployment. It remains internal for future channel integrations. The OpenCode web server on the assistant is the only publicly reachable endpoint, guarded by an ACA IP security restriction allowlist.

## Why the home directory cannot go on Azure Files

Azure Files uses the SMB protocol. SMB does not correctly implement POSIX advisory file locks (`fcntl`/`flock`). SQLite relies on these locks for all write serialisation and WAL-mode coordination. Running a live SQLite database on an SMB mount produces "database is locked" errors, torn writes, and eventual corruption.

**Consequence:** no path that contains an active SQLite database can be mounted from Azure Files. The AKM database at `$HOME/.local/state/` must live on a local, POSIX-compliant filesystem inside the container.

**Solution:** use an ACA `emptyDir` volume for `/home/opencode/.local/state/`. An emptyDir is provisioned from the ACA host's local disk, has full POSIX lock semantics, and is shared between all containers in the same app revision. The sidecar reads the live database from this emptyDir and writes consistent snapshots to Azure Files using `sqlite3 .backup` (the SQLite Online Backup API, which is safe for concurrent write activity).

The emptyDir is ephemeral — it is cleared when the app revision is replaced or the container restarts. Durability is provided by the hourly backup cycle: on each cold start the assistant entrypoint checks whether the state directory is empty and, if so, copies the latest snapshot from the Azure Files backup share before OpenCode starts. The maximum data loss window is the interval between the last successful backup and the crash (at most one hour).

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

## Volume Layout

### Azure Files shares

Mounted only at paths that never contain SQLite databases. All shares use SMB.

| Share name | Container | Mount path | Mode | Purpose |
|---|---|---|---|---|
| `openpalm-opencode-config` | opencode | `/home/opencode/.config/opencode` | rw | OpenCode config files |
| `openpalm-opencode-share` | opencode | `/home/opencode/.local/share/opencode` | rw | auth.json and OpenCode shared data |
| `openpalm-stash` | opencode | `/home/opencode/.akm` | rw | AKM stash artifacts (files, not the db) |
| `openpalm-config` | opencode | `/etc/openpalm` | ro | Operator config |
| `openpalm-work` | opencode | `/work` | rw | Assistant workspace |
| `openpalm-guardian-data` | guardian | `/app/data` | rw | Guardian state |
| `openpalm-guardian-logs` | guardian | `/app/audit` | rw | Guardian audit log |
| `openpalm-akm-backups` | opencode (ro), akm-backup (rw) | `/mnt/akm-restore` (opencode), `/backup` (sidecar) | ro / rw | Backup snapshots; opencode mounts read-only for restore on cold start |

### ACA emptyDir volume

| Volume name | Containers | Mount path | Mode | Purpose |
|---|---|---|---|---|
| `state-vol` | opencode (rw), akm-backup (ro) | `/home/opencode/.local/state` | rw / ro | AKM SQLite database; proper POSIX locks on local disk |

The emptyDir is created fresh on each container start. It is shared between containers in the same app revision but is not shared across revisions or app restarts. Durability is provided by the backup/restore cycle described below.

### What is not mounted

The rest of `/home/opencode` (`.cache/`, `.bun/`, `.local/bin/`, etc.) lives on the container's layer filesystem. These are either reinstalled at startup by the entrypoint or are truly ephemeral caches. The entrypoint already calls `ensure_home_layout` to create required directories.

OpenCode logs (previously at `/home/opencode/.local/state/opencode`) are now inside the emptyDir and are ephemeral. This is acceptable — logs are a debug aid, not durable state. If persistent logs are required, mount an additional Azure Files share at `/home/opencode/.local/state/opencode` (this subdirectory path does not contain SQLite files and is SMB-safe).

## Restore-on-Start and Backup Cycle

### Cold start restore (entrypoint change)

The assistant's `entrypoint.sh` requires one new function added before `start_opencode`:

```sh
maybe_restore_akm_db() {
  local db_path="${AKM_DB_PATH:-/home/opencode/.local/state/akm.db}"
  local restore_mount="/mnt/akm-restore"

  # emptyDir is freshly created; restore from latest backup if the db is absent.
  if [ -f "${db_path}" ]; then
    return 0
  fi

  local latest
  latest="$(find "${restore_mount}" -maxdepth 1 -name 'snapshot-*' -type d 2>/dev/null \
    | sort | tail -1)"

  if [ -n "${latest}" ] && [ -f "${latest}/akm.db" ]; then
    mkdir -p "$(dirname "${db_path}")"
    cp "${latest}/akm.db" "${db_path}"
    echo "Restored AKM db from ${latest}"
  else
    echo "No AKM backup found; starting with empty database"
  fi
}
```

This function is safe to call on every start: it is a no-op if the db already exists. On a container restart the emptyDir is cleared by ACA so the restore path always runs.

`AKM_DB_PATH` must be passed as an environment variable on the assistant container with the exact path to the database file. The `openpalm-akm-backups` share is mounted read-only at `/mnt/akm-restore` in the main container for this purpose only.

### Hourly backup (sidecar)

The sidecar reads the live database via the shared emptyDir and writes a consistent snapshot to the Azure Files backup share using `sqlite3 .backup`.

```sh
#!/bin/sh
set -eu

AKM_DB_PATH="${AKM_DB_PATH:-/home/opencode/.local/state/akm.db}"
BACKUP_ROOT="/backup"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-3600}"

run_backup() {
  if [ ! -f "${AKM_DB_PATH}" ]; then
    echo "AKM db not found at ${AKM_DB_PATH}, skipping"
    return 0
  fi

  local snapshot="${BACKUP_ROOT}/snapshot-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "${snapshot}"

  # SQLite Online Backup API. Produces a consistent copy even under concurrent
  # write activity. WAL-aware: the WAL is checkpointed into the backup file.
  # No exclusive lock is taken on the source database.
  sqlite3 "${AKM_DB_PATH}" ".backup '${snapshot}/akm.db'"

  # Prune snapshots older than 7 days.
  find "${BACKUP_ROOT}" -maxdepth 1 -name 'snapshot-*' -type d -mtime +7 \
    -exec rm -rf {} +

  echo "Backup complete: ${snapshot}"
}

# Backup immediately on sidecar start (captures state before first hourly tick),
# then repeat every INTERVAL seconds.
run_backup
while true; do
  sleep "${INTERVAL}"
  run_backup
done
```

### Sidecar volume mounts

| Volume | Mount path | Mode |
|---|---|---|
| `state-vol` (emptyDir) | `/home/opencode/.local/state` | ro |
| `openpalm-akm-backups` (Azure Files) | `/backup` | rw |

The sidecar mounts the emptyDir **read-only** — it has no write access to the live database directory. All write activity goes to the separate backup share.

## Sidecar Container Definition (within assistant.yaml)

```yaml
volumes:
  - name: state-vol
    storageType: EmptyDir
  - name: akm-backups
    storageType: AzureFile
    storageName: openpalm-akm-backups

containers:
  - name: opencode
    image: <registry>/assistant:<tag>
    env:
      - name: AKM_DB_PATH
        value: /home/opencode/.local/state/akm.db
      # ... other env vars ...
    volumeMounts:
      - volumeName: state-vol
        mountPath: /home/opencode/.local/state
      - volumeName: akm-backups
        mountPath: /mnt/akm-restore
        readOnly: true
      # ... other mounts (config, share, stash, work) ...

  - name: akm-backup
    image: <registry>/akm-backup-sidecar:<tag>
    env:
      - name: AKM_DB_PATH
        value: /home/opencode/.local/state/akm.db
      - name: BACKUP_INTERVAL_SECONDS
        value: "3600"
    volumeMounts:
      - volumeName: state-vol
        mountPath: /home/opencode/.local/state
        readOnly: true
      - volumeName: akm-backups
        mountPath: /backup
    resources:
      cpu: 0.25
      memory: 0.5Gi
```

The emptyDir volume is scoped to the app revision — it is shared between the two containers in the same revision and cleared when the revision is replaced.

## Sidecar Image

`alpine:3` with `sqlite3` installed:

```dockerfile
FROM alpine:3
RUN apk add --no-cache sqlite
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]
```

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

When any `Allow` rules are present, ACA denies all traffic not matching a listed CIDR automatically. No explicit `Deny 0.0.0.0/0` rule is needed.

The allowed IP list is supplied to the deploy script as `OP_ALLOWED_IPS`, a comma-separated list of CIDRs (e.g. `1.2.3.4/32,5.6.7.8/32`). The script emits one `ipSecurityRestrictions` entry per CIDR.

### Environment changes vs. core.compose.yml

- `OPENCODE_AUTH=true` — **required**; the server is externally reachable.
- `OPENCODE_PASSWORD` — sourced from Key Vault secret `opencode-password`.
- `AKM_DB_PATH` — set to the exact db file path, e.g. `/home/opencode/.local/state/akm.db`.
- Remove `MEMORY_API_URL`, `MEMORY_AUTH_TOKEN`, `MEMORY_USER_ID` — memory container is not deployed.
- `OP_ADMIN_API_URL` — leave empty; assistant admin tools fail gracefully when Admin is absent.

### Sizing

```yaml
resources:
  cpu: 2.0
  memory: 4Gi
scale:
  minReplicas: 1
  maxReplicas: 1
```

Single replica enforced. The emptyDir is revision-scoped; multiple replicas would each have their own independent emptyDir and db state.

### Health probe

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

Internal only — no external ingress. Reachable within the ACA environment at its internal FQDN.

```yaml
ingress:
  external: false
  targetPort: 8080
  transport: http
```

`OP_ASSISTANT_URL` is set to the assistant app's internal FQDN, resolved at deploy time:

```
OP_ASSISTANT_URL=https://openpalm-assistant.internal.<env-domain>
```

```yaml
resources:
  cpu: 0.25
  memory: 0.5Gi
scale:
  minReplicas: 1
  maxReplicas: 1
```

## Key Vault Secrets

| Secret name | Consumer | Description |
|---|---|---|
| `opencode-password` | assistant | `OPENCODE_PASSWORD` — required when `OPENCODE_AUTH=true` |
| `assistant-token` | assistant, guardian | `OP_ASSISTANT_TOKEN` / guardian outbound auth |
| `guardian-channel-secrets` | guardian | Per-channel HMAC secrets |
| `openai-api-key` | assistant | Primary LLM provider key |
| `anthropic-api-key` | assistant | Alternate provider key |
| `<additional provider keys>` | assistant | Any other active provider keys |

Unused provider keys are unset at startup by the existing `maybe_unset_unused_provider_keys` logic in `entrypoint.sh`.

## Deployment Script: deploy/azure/deploy-aca.sh

### Subcommands

| Subcommand | Action |
|---|---|
| `setup` | Provision resource group, storage account, file shares, Key Vault, managed identity; write all secrets to Key Vault; seed share directory structure |
| `deploy` | Build sidecar image; generate and apply ACA app YAML for assistant (with sidecar) and guardian |
| `all` | `setup` then `deploy` |
| `update-ips` | Update the IP allowlist on the assistant ingress without a full redeploy |
| `status` | Print running state of both apps and last backup log from the akm-backup sidecar |
| `teardown` | Delete the resource group and all contained resources |

### Required inputs

| Variable | Description |
|---|---|
| `AZURE_RESOURCE_GROUP` | Resource group name (default: `rg-openpalm`) |
| `AZURE_LOCATION` | Region (e.g. `eastus`) |
| `AZURE_SUBSCRIPTION` | Subscription ID |
| `OP_IMAGE_TAG` | Image tag to deploy (default: `latest`) |
| `OP_IMAGE_NAMESPACE` | Registry namespace/prefix (default: `openpalm`) |
| `OP_ALLOWED_IPS` | Comma-separated list of allowed CIDRs for assistant ingress |
| `OP_OPENCODE_PASSWORD` | Password for OpenCode web UI (stored in Key Vault) |
| `OP_ASSISTANT_TOKEN` | Assistant token for guardian→assistant auth |
| `AKM_DB_PATH` | Exact path to AKM SQLite database inside the container |
| `SYSTEM_LLM_PROVIDER` | Active LLM provider name |
| `<PROVIDER>_API_KEY` | API key for the active provider |

### Script conventions

- Use `az` CLI argument arrays, not inline interpolation, for values that could contain special characters or secrets.
- Generate per-app YAML to `deploy/azure/apps/` (gitignored rendered output; templates are checked in).
- Validate with `shellcheck` before committing.
- Print provisioned resource names and the assistant ingress URL on successful `deploy`; never print secret values.

## Required Code Change

This deployment requires one addition to `core/assistant/entrypoint.sh`: the `maybe_restore_akm_db` function described in the restore-on-start section above, called immediately before `start_opencode`. This is the only required change to the core runtime. All other changes are deployment artifacts.

## Deliverables

```
core/assistant/entrypoint.sh         (add maybe_restore_akm_db)

deploy/azure/
├── PLAN.md                          (this file)
├── README.md                        (operator guide)
├── deploy-aca.sh                    (main deployment script)
├── apps/
│   ├── assistant.yaml               (ACA app template — includes akm-backup sidecar)
│   └── guardian.yaml                (ACA app template)
└── sidecar/
    ├── Dockerfile                   (alpine + sqlite3)
    └── backup.sh                    (backup loop script)
```

## What This Removes vs. Issue #315

| #315 scope | This plan |
|---|---|
| `memory` container | Removed |
| `scheduler` container | Removed |
| `channel-chat` and add-channel flow | Removed (no channels in simplified deployment) |
| Guardian as the only external ingress | Changed — assistant is the external ingress |
| Single monolithic home share on Azure Files | Replaced with granular mounts; SQLite paths on emptyDir |

## Deviations from Self-Hosted Model

| Self-hosted | ACA |
|---|---|
| `~/.openpalm/vault/stack/stack.env` | Key Vault secrets via managed identity |
| `~/.openpalm/data/stash` | `openpalm-stash` Azure Files share (AKM file artifacts) |
| `~/openpalm/data/assistant` (full home bind-mount) | Granular share mounts per subdirectory; `.local/state` on emptyDir |
| AKM db on host filesystem (POSIX locks) | AKM db on emptyDir (POSIX locks on local ACA disk) |
| AKM db always durable | AKM db ephemeral on emptyDir; durable via hourly backup + restore-on-start |
| Init service creates data dirs | `setup` seeds shares; entrypoint creates emptyDir subdirs |
| No inbound authentication on assistant (127.0.0.1 only) | `OPENCODE_AUTH=true` mandatory; IP allowlist on ACA ingress |
| Memory service provides vector persistence | No memory service; AKM SQLite is sole persistence |

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Data loss on unexpected container restart | Backup interval is configurable via `BACKUP_INTERVAL_SECONDS`; default 1 hour; set to 300s (5 min) to reduce window |
| OpenCode auth disabled | Plan mandates `OPENCODE_AUTH=true`; deploy script validates and refuses to proceed without a password |
| IP allowlist misconfiguration locks out operator | `update-ips` subcommand for safe updates; README documents adding operator's current IP during setup |
| AKM db corruption during backup | `sqlite3 .backup` uses the SQLite Online Backup API — no raw file copy, no exclusive lock, WAL-safe |
| Sidecar crashes | ACA restarts only the sidecar; the opencode process is unaffected; next backup runs after restart |
| `AKM_DB_PATH` wrong on first deploy | Sidecar logs "db not found" and skips gracefully; operator corrects the env var and restarts the revision |
| Restore reads a corrupt backup snapshot | `maybe_restore_akm_db` uses `cp` not `sqlite3`, so a corrupt backup is copied as-is; add a `sqlite3 dest.db "PRAGMA integrity_check"` validation step before the first OpenCode start if hard safety is needed |
| emptyDir cleared on revision update | Expected behaviour; entrypoint restore runs automatically on every cold start |
| Single replica constraint | Documented explicitly; `maxReplicas: 1` enforced in YAML; multi-replica requires session affinity and shared db, out of scope |
