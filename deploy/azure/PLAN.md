# Simplified Azure Container Apps Deployment Plan

## Goals

- Remove memory and scheduler containers from the Azure deployment.
- Keep only assistant and guardian.
- Expose the assistant's OpenCode webserver as the default ACA ingress, restricted to an explicit IP allowlist.
- Eliminate the VM entirely — deploy purely on Azure Container Apps.
- Add an hourly AKM database backup that safely snapshots the SQLite database in `$HOME/.local/state` to an Azure File Share and retains 7 days of rolling copies.

## Architecture

```
Internet
    │
    ▼ (HTTPS, IP-allowlisted)
ACA Ingress — openpalm-assistant  (single container)
    OpenCode web UI  :4096
    background: backup loop writes sqlite3 .backup → Azure Files every hour
    startup:    restore loop seeds db from latest Azure Files snapshot
    │
    │ internal ACA DNS
    ▼
openpalm-guardian  :8080  (internal-only ingress)
    HMAC validation, audit logging
```

## Why the home directory cannot go on Azure Files

Azure Files uses SMB. SMB does not correctly implement POSIX advisory file locks (`fcntl`/`flock`). SQLite relies on these locks for write serialisation and WAL-mode coordination. Running a live SQLite database on an SMB mount produces "database is locked" errors, torn writes, and eventual corruption.

**Consequence:** no path that contains an active SQLite database can be mounted from Azure Files. The AKM database at `$HOME/.local/state/` must live on a local, POSIX-compliant filesystem inside the container.

**Solution:** use an ACA `emptyDir` volume for `/home/opencode/.local/state/`. An emptyDir is provisioned from the ACA host's local disk with full POSIX lock semantics. The emptyDir is cleared on container restart; durability comes from the backup/restore cycle baked into `entrypoint.sh`.

## Why no sidecar

The backup can run as a background subshell started in `entrypoint.sh` before the `exec gosu opencode...` call. When `exec` replaces the shell process, the background subshell is orphaned to Tini (PID 1, already the container init). Tini adopts and reaps orphans correctly, so the backup loop runs for the full container lifetime with no second container needed.

This keeps the ACA app definition to a single container, removes the need to build and maintain a separate sidecar image, and avoids the shared-emptyDir complexity of multi-container apps.

## Required Image Change

`sqlite3` CLI is not in the assistant image. Add it to the existing `apt-get install` line in `core/assistant/Dockerfile`:

```diff
-    && apt-get install -y --no-install-recommends tini curl git ca-certificates bash openssh-server gosu sudo socat unzip \
+    && apt-get install -y --no-install-recommends tini curl git ca-certificates bash openssh-server gosu sudo socat unzip sqlite3 \
```

No other image changes are required.

## Required Entrypoint Changes

Two new functions in `core/assistant/entrypoint.sh`, called in order before `start_opencode`:

### maybe_restore_akm_db

Runs on every cold start. If the emptyDir is empty (no db file) and a backup snapshot exists on the mounted Azure Files backup share, copies the latest snapshot into place before OpenCode starts.

```sh
maybe_restore_akm_db() {
  local db_path="${AKM_DB_PATH:-}"
  local restore_mount="/mnt/akm-backups"

  if [ -z "${db_path}" ]; then
    return 0
  fi

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

### start_backup_loop

Starts a background subshell before the `exec`. The subshell is orphaned to Tini when `exec` replaces the shell; it then runs for the lifetime of the container.

```sh
start_backup_loop() {
  local db_path="${AKM_DB_PATH:-}"
  local backup_root="/mnt/akm-backups"
  local interval="${BACKUP_INTERVAL_SECONDS:-3600}"

  if [ -z "${db_path}" ] || ! command -v sqlite3 >/dev/null 2>&1; then
    return 0
  fi

  (
    # Wait for AKM to create the db (it may be created lazily after first use).
    while [ ! -f "${db_path}" ]; do
      sleep 10
    done

    while true; do
      local snapshot="${backup_root}/snapshot-$(date -u +%Y%m%dT%H%M%SZ)"
      mkdir -p "${snapshot}"

      # SQLite Online Backup API: consistent copy under concurrent write activity,
      # WAL-aware, no exclusive lock required.
      sqlite3 "${db_path}" ".backup '${snapshot}/akm.db'"

      # Prune snapshots older than 7 days.
      find "${backup_root}" -maxdepth 1 -name 'snapshot-*' -type d -mtime +7 \
        -exec rm -rf {} +

      sleep "${interval}"
    done
  ) &
}
```

### Call order in entrypoint.sh

```sh
maybe_adjust_uid_gid
ensure_home_layout
maybe_set_memory_user_id
maybe_enable_ssh
maybe_proxy_lmstudio
maybe_unset_unused_provider_keys
maybe_restore_akm_db    # new
start_backup_loop       # new — must be before start_opencode
start_opencode          # exec replaces shell; backup loop orphaned to tini
```

## Azure Resources

| Resource | Type | Notes |
|---|---|---|
| `rg-openpalm` | Resource Group | All resources in one group for easy teardown |
| `openpalm-env` | ACA Environment | Shared environment; enables internal DNS between apps |
| `openpalm-assistant` | Container App | External ingress, IP-restricted, single container, single replica |
| `openpalm-guardian` | Container App | Internal ingress only |
| `openpalmstore<suffix>` | Storage Account | Azure Files backend for all shares |
| `kv-openpalm-<suffix>` | Key Vault | All runtime secrets; no inline secrets in YAML |
| `id-openpalm` | User-assigned Managed Identity | Grants apps Key Vault Secrets User role |

## Volume Layout

### Azure Files shares (SMB-safe paths only)

| Share name | Mount path | Mode | Purpose |
|---|---|---|---|
| `openpalm-opencode-config` | `/home/opencode/.config/opencode` | rw | OpenCode config |
| `openpalm-opencode-share` | `/home/opencode/.local/share/opencode` | rw | auth.json and OpenCode shared data |
| `openpalm-stash` | `/home/opencode/.akm` | rw | AKM file artifacts (not the db) |
| `openpalm-config` | `/etc/openpalm` | ro | Operator config |
| `openpalm-work` | `/work` | rw | Assistant workspace |
| `openpalm-akm-backups` | `/mnt/akm-backups` | rw | Backup snapshots (restore reads here; backup loop writes here) |
| `openpalm-guardian-data` | `/app/data` | rw | Guardian state |
| `openpalm-guardian-logs` | `/app/audit` | rw | Guardian audit log |

### ACA emptyDir volume

| Volume | Mount path | Mode | Purpose |
|---|---|---|---|
| `state-vol` | `/home/opencode/.local/state` | rw | AKM SQLite database; POSIX locks on local ACA disk |

The emptyDir is cleared on container restart. The backup/restore cycle in `entrypoint.sh` provides durability. Maximum data loss on crash = time since last successful backup (default: up to 1 hour; set `BACKUP_INTERVAL_SECONDS=300` to reduce to 5 minutes).

### What is not mounted

The rest of `/home/opencode` (`.cache/`, `.bun/`, `.local/bin/`, etc.) lives on the container layer filesystem. These are either reinstalled at startup or are ephemeral caches.

OpenCode logs (`/home/opencode/.local/state/opencode`) are inside the emptyDir and are ephemeral. If persistent logs are needed, add a separate Azure Files share mounted at `/home/opencode/.local/state/opencode` — this subdirectory contains only log files (no SQLite) and is SMB-safe.

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
    # one entry per CIDR in OP_ALLOWED_IPS
```

When any `Allow` rules are present, ACA denies all other traffic automatically.

The allowed IP list is supplied to the deploy script as `OP_ALLOWED_IPS`, a comma-separated list of CIDRs. The script emits one `ipSecurityRestrictions` entry per CIDR.

### Environment changes vs. core.compose.yml

- `OPENCODE_AUTH=true` — **required**; the server is externally reachable.
- `OPENCODE_PASSWORD` — sourced from Key Vault secret `opencode-password`.
- `AKM_DB_PATH` — exact path to the AKM SQLite file, e.g. `/home/opencode/.local/state/akm.db`.
- `BACKUP_INTERVAL_SECONDS` — backup frequency in seconds (default `3600`).
- Remove `MEMORY_API_URL`, `MEMORY_AUTH_TOKEN`, `MEMORY_USER_ID` — memory not deployed.
- `OP_ADMIN_API_URL` — leave empty; assistant admin tools fail gracefully when Admin is absent.

### Volumes (in ACA YAML)

```yaml
volumes:
  - name: state-vol
    storageType: EmptyDir
  - name: openpalm-akm-backups
    storageType: AzureFile
    storageName: openpalm-akm-backups
  # ... other Azure Files volumes ...

containers:
  - name: opencode
    image: <registry>/assistant:<tag>
    volumeMounts:
      - volumeName: state-vol
        mountPath: /home/opencode/.local/state
      - volumeName: openpalm-akm-backups
        mountPath: /mnt/akm-backups
      # ... other mounts ...
```

### Sizing

```yaml
resources:
  cpu: 2.0
  memory: 4Gi
scale:
  minReplicas: 1
  maxReplicas: 1
```

Single replica enforced. The emptyDir is per-replica; multiple replicas would each have independent db state.

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

Internal only — no external ingress.

```yaml
ingress:
  external: false
  targetPort: 8080
  transport: http
```

`OP_ASSISTANT_URL` is set to the assistant app's internal FQDN, resolved at deploy time from `az containerapp show`.

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
| `deploy` | Generate and apply ACA app YAML for assistant and guardian |
| `all` | `setup` then `deploy` |
| `update-ips` | Update the IP allowlist on the assistant ingress without a full redeploy |
| `status` | Print running state of both apps |
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

## Required Changes Summary

| File | Change |
|---|---|
| `core/assistant/Dockerfile` | Add `sqlite3` to the `apt-get install` line |
| `core/assistant/entrypoint.sh` | Add `maybe_restore_akm_db` and `start_backup_loop` functions; call them before `start_opencode` |

## Deliverables

```
core/assistant/Dockerfile            (add sqlite3)
core/assistant/entrypoint.sh        (add restore + backup loop)

deploy/azure/
├── PLAN.md                          (this file)
├── README.md                        (operator guide)
├── deploy-aca.sh                    (main deployment script)
└── apps/
    ├── assistant.yaml               (ACA app template)
    └── guardian.yaml                (ACA app template)
```

## What This Removes vs. Issue #315

| #315 scope | This plan |
|---|---|
| `memory` container | Removed |
| `scheduler` container | Removed |
| `channel-chat` and add-channel flow | Removed (no channels in simplified deployment) |
| Guardian as the only external ingress | Changed — assistant is the external ingress |
| Monolithic home share on Azure Files | Replaced with granular mounts; SQLite path on emptyDir |

## Deviations from Self-Hosted Model

| Self-hosted | ACA |
|---|---|
| `~/.openpalm/vault/stack/stack.env` | Key Vault secrets via managed identity |
| `~/.openpalm/data/stash` | `openpalm-stash` Azure Files share (file artifacts only) |
| Full home bind-mount on host filesystem | Granular share mounts per subdirectory; `.local/state` on emptyDir |
| AKM db always durable (host filesystem) | AKM db ephemeral on emptyDir; durable via hourly backup + restore-on-start |
| No inbound auth on assistant (127.0.0.1 only) | `OPENCODE_AUTH=true` mandatory; IP allowlist on ACA ingress |
| Memory service provides vector persistence | No memory service; AKM SQLite is sole persistence |

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Data loss on unexpected container restart | Configurable via `BACKUP_INTERVAL_SECONDS`; default 1 hour; set to 300 for 5-minute window |
| OpenCode auth disabled | Deploy script validates `OP_OPENCODE_PASSWORD` is set and refuses to proceed without it |
| IP allowlist misconfiguration locks out operator | `update-ips` subcommand; README documents adding operator's current IP during setup |
| AKM db corruption during backup | `sqlite3 .backup` uses the SQLite Online Backup API — no raw file copy, no exclusive lock, WAL-safe |
| Backup loop dies silently | Loop runs in background; a crash does not affect OpenCode; next container restart triggers restore-on-start from the last successful snapshot |
| `AKM_DB_PATH` not set or wrong | Both functions are no-ops when `AKM_DB_PATH` is empty; backup loop also skips if `sqlite3` is not in PATH |
| Restore copies a corrupt snapshot | Add `sqlite3 "${db_path}" "PRAGMA integrity_check"` after the `cp` and abort startup if it fails, to avoid starting with a known-bad db |
| emptyDir cleared on revision update | Expected; entrypoint restore runs automatically on every cold start |
| Single replica constraint | Documented explicitly; `maxReplicas: 1` enforced in YAML |
