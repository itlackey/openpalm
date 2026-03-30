#!/usr/bin/env bash
# backup.sh — Daily backup of OpenPalm data to an Azure Files share.
#
# Installed to /usr/local/bin/openpalm-backup.sh by cloud-init and invoked
# by a cron job.  Authenticates with the VM's managed identity.
#
# Environment (baked at deploy time via cloud-init config):
#   OPENPALM_ADMIN_USER   — the linux user that owns ~/.openpalm
#   OPENPALM_STORAGE_NAME — Azure Storage Account name
#   OPENPALM_BACKUP_SHARE — Azure Files share name

set -euo pipefail
exec >> /var/log/openpalm-backup.log 2>&1
echo "[backup] started at $(date -u)"

: "${OPENPALM_ADMIN_USER:?}"
: "${OPENPALM_STORAGE_NAME:?}"
: "${OPENPALM_BACKUP_SHARE:?}"

OP_HOME="/home/${OPENPALM_ADMIN_USER}/.openpalm"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/tmp/openpalm-backup-${TIMESTAMP}"

mkdir -p "$BACKUP_DIR"

for dir in data vault config; do
  [[ -d "${OP_HOME}/${dir}" ]] && cp -a "${OP_HOME}/${dir}" "${BACKUP_DIR}/${dir}"
done

ARCHIVE="/tmp/openpalm-backup-${TIMESTAMP}.tar.gz"
tar -czf "$ARCHIVE" -C "$BACKUP_DIR" .
rm -rf "$BACKUP_DIR"

az storage file upload \
  --account-name "$OPENPALM_STORAGE_NAME" \
  --share-name "$OPENPALM_BACKUP_SHARE" \
  --source "$ARCHIVE" \
  --path "backups/openpalm-backup-${TIMESTAMP}.tar.gz" \
  --auth-mode login \
  --output none

rm -f "$ARCHIVE"

# Prune backups older than 30 days
CUTOFF="$(date -u -d '30 days ago' +%Y%m%dT%H%M%SZ)"
az storage file list \
  --account-name "$OPENPALM_STORAGE_NAME" \
  --share-name "$OPENPALM_BACKUP_SHARE" \
  --path backups \
  --auth-mode login \
  --query "[?name<'openpalm-backup-${CUTOFF}'].name" \
  -o tsv | while IFS= read -r old; do
    [[ -n "$old" ]] || continue
    az storage file delete \
      --account-name "$OPENPALM_STORAGE_NAME" \
      --share-name "$OPENPALM_BACKUP_SHARE" \
      --path "backups/${old}" \
      --auth-mode login \
      --output none
    echo "[backup] pruned: ${old}"
  done

echo "[backup] complete at $(date -u)"
