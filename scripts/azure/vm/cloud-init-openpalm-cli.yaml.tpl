#cloud-config
package_update: true
package_upgrade: true
packages:
  - ca-certificates
  - curl
  - git
  - jq
  - sudo
  - unzip
  - bash
  - openssl
  - python3
  - apt-transport-https
  - gnupg
  - lsb-release
  - cron

users:
  - default
  - name: __TEMPLATE_ADMIN_USERNAME__
    groups: [sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL

write_files:
  - path: /var/lib/openpalm/setup-spec.b64
    permissions: '0600'
    owner: root:root
    encoding: text/plain
    content: __TEMPLATE_SETUP_SPEC_B64__

  - path: /usr/local/bin/openpalm-backup.sh
    permissions: '0755'
    owner: root:root
    content: |
      #!/usr/bin/env bash
      # Daily backup of OpenPalm data to Azure Storage file share.
      # Runs via cron as root; authenticates with the VM managed identity.
      set -euo pipefail
      exec >> /var/log/openpalm-backup.log 2>&1
      echo "[backup] started at $(date -u)"

      ADMIN_USER="__TEMPLATE_ADMIN_USERNAME__"
      OP_HOME="/home/${ADMIN_USER}/.openpalm"
      STORAGE_ACCOUNT="__TEMPLATE_STORAGE_NAME__"
      SHARE_NAME="__TEMPLATE_BACKUP_SHARE__"
      TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
      BACKUP_DIR="/tmp/openpalm-backup-${TIMESTAMP}"

      mkdir -p "$BACKUP_DIR"

      # Back up data and vault dirs (config, secrets, sqlite databases)
      for dir in data vault config; do
        if [[ -d "${OP_HOME}/${dir}" ]]; then
          cp -a "${OP_HOME}/${dir}" "${BACKUP_DIR}/${dir}"
        fi
      done

      ARCHIVE="/tmp/openpalm-backup-${TIMESTAMP}.tar.gz"
      tar -czf "$ARCHIVE" -C "$BACKUP_DIR" .
      rm -rf "$BACKUP_DIR"

      # Upload via az cli using managed identity
      az storage file upload \
        --account-name "$STORAGE_ACCOUNT" \
        --share-name "$SHARE_NAME" \
        --source "$ARCHIVE" \
        --path "backups/openpalm-backup-${TIMESTAMP}.tar.gz" \
        --auth-mode login \
        --output none

      rm -f "$ARCHIVE"

      # Prune backups older than 30 days
      CUTOFF="$(date -u -d '30 days ago' +%Y%m%dT%H%M%SZ)"
      az storage file list \
        --account-name "$STORAGE_ACCOUNT" \
        --share-name "$SHARE_NAME" \
        --path backups \
        --auth-mode login \
        --query "[?name<'openpalm-backup-${CUTOFF}'].name" \
        -o tsv | while IFS= read -r old; do
          [[ -n "$old" ]] || continue
          az storage file delete \
            --account-name "$STORAGE_ACCOUNT" \
            --share-name "$SHARE_NAME" \
            --path "backups/${old}" \
            --auth-mode login \
            --output none
          echo "[backup] pruned old backup: ${old}"
        done

      echo "[backup] complete at $(date -u)"

  - path: /usr/local/bin/openpalm-first-boot.sh
    permissions: '0755'
    owner: root:root
    content: |
      #!/usr/bin/env bash
      set -euo pipefail
      exec > >(tee -a /var/log/openpalm-bootstrap.log) 2>&1
      echo "[openpalm] bootstrap started at $(date -u)"

      ADMIN_USER="__TEMPLATE_ADMIN_USERNAME__"
      OP_VERSION="__TEMPLATE_OPENPALM_VERSION__"
      OP_INSTALL_DIR="__TEMPLATE_OPENPALM_INSTALL_DIR__"
      OP_HOME="__TEMPLATE_OPENPALM_HOME__"
      SETUP_FILE="/var/lib/openpalm/setup-spec.yaml"
      KV_NAME="__TEMPLATE_KV_NAME__"

      # ── Wait for dpkg/apt locks (cloud-init may still be installing packages) ──
      echo "[openpalm] waiting for apt/dpkg lock release"
      for _ in $(seq 1 60); do
        if ! fuser /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then
          break
        fi
        sleep 3
      done

      # ── Install Azure CLI ──────────────────────────────────────────────────
      echo "[openpalm] installing Azure CLI"
      curl -sL https://aka.ms/InstallAzureCLIDeb | bash

      # ── Install Docker Engine ──────────────────────────────────────────────
      echo "[openpalm] installing Docker Engine"
      curl -fsSL https://get.docker.com | sh
      systemctl enable docker
      systemctl start docker
      usermod -aG docker "$ADMIN_USER"

      # Wait for Docker daemon to be responsive
      echo "[openpalm] waiting for Docker daemon"
      for _ in $(seq 1 30); do
        if docker info >/dev/null 2>&1; then
          break
        fi
        sleep 2
      done
      docker info >/dev/null 2>&1 || { echo "[openpalm] ERROR: Docker daemon not ready after 60s"; exit 1; }
      echo "[openpalm] Docker is ready"

      # ── Authenticate with managed identity ─────────────────────────────────
      echo "[openpalm] authenticating with managed identity"
      az login --identity --output none

      # ── Retrieve secrets from Key Vault ────────────────────────────────────
      echo "[openpalm] retrieving secrets from Key Vault: ${KV_NAME}"
      get_secret() { az keyvault secret show --vault-name "$KV_NAME" --name "$1" --query value -o tsv 2>/dev/null || echo ""; }

      KV_ADMIN_TOKEN="$(get_secret op-admin-token)"
      KV_ASSISTANT_TOKEN="$(get_secret op-assistant-token)"
      KV_SLACK_BOT_TOKEN="$(get_secret slack-bot-token)"
      KV_SLACK_APP_TOKEN="$(get_secret slack-app-token)"

      # ── Decode the setup spec from base64 ──────────────────────────────────
      mkdir -p /var/lib/openpalm
      base64 -d /var/lib/openpalm/setup-spec.b64 > "$SETUP_FILE"
      rm -f /var/lib/openpalm/setup-spec.b64

      # Inject Key Vault secrets into the setup spec (replace placeholder values)
      if [[ -n "$KV_ADMIN_TOKEN" ]]; then
        sed -i "s|adminToken:.*|adminToken: ${KV_ADMIN_TOKEN}|" "$SETUP_FILE"
      fi
      if [[ -n "$KV_ASSISTANT_TOKEN" ]]; then
        sed -i "s|assistantToken:.*|assistantToken: ${KV_ASSISTANT_TOKEN}|" "$SETUP_FILE"
      fi

      chown "$ADMIN_USER":"$ADMIN_USER" /var/lib/openpalm
      chown "$ADMIN_USER":"$ADMIN_USER" "$SETUP_FILE"
      chmod 600 "$SETUP_FILE"

      # ── Build Slack env vars for the install if tokens exist ───────────────
      SLACK_ENV=""
      if [[ -n "$KV_SLACK_BOT_TOKEN" && -n "$KV_SLACK_APP_TOKEN" ]]; then
        echo "[openpalm] Slack tokens found in Key Vault — Slack channel will be enabled"
        SLACK_ENV="SLACK_BOT_TOKEN=${KV_SLACK_BOT_TOKEN} SLACK_APP_TOKEN=${KV_SLACK_APP_TOKEN}"
      fi

      # ── Install OpenPalm CLI ───────────────────────────────────────────────
      mkdir -p "$OP_INSTALL_DIR"
      chown -R "$ADMIN_USER":"$ADMIN_USER" "$(dirname "$OP_INSTALL_DIR")"

      echo "[openpalm] installing OpenPalm CLI ${OP_VERSION} and applying setup spec"
      sudo -u "$ADMIN_USER" -H env \
        OP_INSTALL_DIR="$OP_INSTALL_DIR" \
        OP_HOME="$OP_HOME" \
        ${SLACK_ENV} \
        bash -c "curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash -s -- --version ${OP_VERSION} --force --no-open --file ${SETUP_FILE}"

      # ── Enable daily backup cron ───────────────────────────────────────────
      echo "[openpalm] enabling daily backup cron"
      echo "0 3 * * * root /usr/local/bin/openpalm-backup.sh" > /etc/cron.d/openpalm-backup
      chmod 644 /etc/cron.d/openpalm-backup

      echo "[openpalm] bootstrap complete at $(date -u)"

runcmd:
  - [bash, -lc, '/usr/local/bin/openpalm-first-boot.sh']
