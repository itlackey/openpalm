#!/usr/bin/env bash
# backup.sh — Daily backup of ~/.openpalm to Azure Files.
# Installed to /usr/local/bin/openpalm-backup.sh by cloud-init.
# Runs as root via cron; authenticates with VM managed identity.

set -euo pipefail
exec >> /var/log/openpalm-backup.log 2>&1
echo "[backup] started at $(date -u)"

source /etc/openpalm/config
az login --identity --output none

OP_HOME="/home/${ADMIN_USER}/.openpalm"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="/tmp/openpalm-backup-${TS}"

mkdir -p "$TMP"
for d in data vault config; do
  [[ -d "${OP_HOME}/${d}" ]] && cp -a "${OP_HOME}/${d}" "${TMP}/${d}"
done

tar -czf "${TMP}.tar.gz" -C "$TMP" .
rm -rf "$TMP"

az storage file upload \
  --account-name "$STORAGE_NAME" --share-name "$BACKUP_SHARE" \
  --source "${TMP}.tar.gz" --path "backups/openpalm-backup-${TS}.tar.gz" \
  --auth-mode login --output none

rm -f "${TMP}.tar.gz"

# Prune backups older than 30 days
CUTOFF="$(date -u -d '30 days ago' +%Y%m%dT%H%M%SZ)"
az storage file list \
  --account-name "$STORAGE_NAME" --share-name "$BACKUP_SHARE" \
  --path backups --auth-mode login \
  --query "[?name<'openpalm-backup-${CUTOFF}'].name" -o tsv \
| while IFS= read -r old; do
    [[ -n "$old" ]] || continue
    az storage file delete \
      --account-name "$STORAGE_NAME" --share-name "$BACKUP_SHARE" \
      --path "backups/${old}" --auth-mode login --output none
    echo "[backup] pruned: ${old}"
  done

echo "[backup] done at $(date -u)"
