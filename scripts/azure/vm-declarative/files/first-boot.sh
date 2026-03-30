#!/usr/bin/env bash
# first-boot.sh — Runs once via cloud-init runcmd.
#
# Reads its configuration from /etc/openpalm/boot.env (written by cloud-init).
# Installs Docker + Azure CLI, retrieves secrets from Key Vault, patches the
# setup spec, then runs the OpenPalm CLI installer.

set -euo pipefail
exec > >(tee -a /var/log/openpalm-bootstrap.log) 2>&1
echo "[openpalm] bootstrap started at $(date -u)"

# ── Load config ──────────────────────────────────────────────────────────
# shellcheck source=/dev/null
source /etc/openpalm/boot.env

: "${ADMIN_USER:?}"
: "${OP_VERSION:?}"
: "${OP_INSTALL_DIR:?}"
: "${OP_HOME:?}"
: "${KV_NAME:?}"
: "${SETUP_REF:?}"

SETUP_FILE="/var/lib/openpalm/setup-spec.yaml"

# ── Wait for dpkg/apt locks ─────────────────────────────────────────────
echo "[openpalm] waiting for apt/dpkg lock release"
for _ in $(seq 1 60); do
  fuser /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break
  sleep 3
done

# ── Install Azure CLI ───────────────────────────────────────────────────
echo "[openpalm] installing Azure CLI"
curl -sL https://aka.ms/InstallAzureCLIDeb | bash

# ── Install Docker ──────────────────────────────────────────────────────
echo "[openpalm] installing Docker Engine"
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker
usermod -aG docker "$ADMIN_USER"

echo "[openpalm] waiting for Docker daemon"
for _ in $(seq 1 30); do
  docker info >/dev/null 2>&1 && break
  sleep 2
done
docker info >/dev/null 2>&1 || { echo "[openpalm] ERROR: Docker not ready after 60s"; exit 1; }
echo "[openpalm] Docker is ready"

# ── Authenticate with managed identity ──────────────────────────────────
echo "[openpalm] authenticating with managed identity"
az login --identity --output none

# ── Retrieve secrets from Key Vault ─────────────────────────────────────
echo "[openpalm] retrieving secrets from Key Vault: ${KV_NAME}"
get_secret() { az keyvault secret show --vault-name "$KV_NAME" --name "$1" --query value -o tsv 2>/dev/null || echo ""; }

KV_ADMIN_TOKEN="$(get_secret op-admin-token)"
KV_ASSISTANT_TOKEN="$(get_secret op-assistant-token)"
KV_SLACK_BOT_TOKEN="$(get_secret slack-bot-token)"
KV_SLACK_APP_TOKEN="$(get_secret slack-app-token)"

# ── Decode the setup spec ───────────────────────────────────────────────
mkdir -p /var/lib/openpalm
base64 -d /var/lib/openpalm/setup-spec.b64 > "$SETUP_FILE"
rm -f /var/lib/openpalm/setup-spec.b64

# ── Patch the setup spec with Key Vault secrets ─────────────────────────
PATCH_ARGS=()
[[ -n "$KV_ADMIN_TOKEN" ]]    && PATCH_ARGS+=("spec.security.adminToken=${KV_ADMIN_TOKEN}")
[[ -n "$KV_ASSISTANT_TOKEN" ]] && PATCH_ARGS+=("spec.security.assistantToken=${KV_ASSISTANT_TOKEN}")

if [[ -n "$KV_SLACK_BOT_TOKEN" && -n "$KV_SLACK_APP_TOKEN" ]]; then
  echo "[openpalm] Slack tokens found — enabling Slack channel"
  PATCH_ARGS+=("spec.channels.slack.enabled=true")
  PATCH_ARGS+=("spec.channelCredentials.slack.slackBotToken=${KV_SLACK_BOT_TOKEN}")
  PATCH_ARGS+=("spec.channelCredentials.slack.slackAppToken=${KV_SLACK_APP_TOKEN}")
else
  echo "[openpalm] No Slack tokens — disabling Slack channel"
  PATCH_ARGS+=("spec.channels.slack.enabled=false")
fi

if [[ ${#PATCH_ARGS[@]} -gt 0 ]]; then
  python3 /usr/local/bin/openpalm-patch-spec.py "$SETUP_FILE" "${PATCH_ARGS[@]}"
fi

chown "$ADMIN_USER":"$ADMIN_USER" /var/lib/openpalm "$SETUP_FILE"
chmod 600 "$SETUP_FILE"

# ── Install OpenPalm CLI ────────────────────────────────────────────────
mkdir -p "$OP_INSTALL_DIR"
chown -R "$ADMIN_USER":"$ADMIN_USER" "$(dirname "$OP_INSTALL_DIR")"

SETUP_URL="https://raw.githubusercontent.com/itlackey/openpalm/${SETUP_REF}/scripts/setup.sh"
echo "[openpalm] installing OpenPalm CLI ${OP_VERSION} from ref ${SETUP_REF}"
sudo -u "$ADMIN_USER" -H env \
  OP_INSTALL_DIR="$OP_INSTALL_DIR" \
  OP_HOME="$OP_HOME" \
  bash -c "curl -fsSL ${SETUP_URL} | bash -s -- --version ${OP_VERSION} --force --no-open --file ${SETUP_FILE}"

# ── Enable daily backup cron ────────────────────────────────────────────
echo "[openpalm] enabling daily backup cron"
echo "0 3 * * * root /usr/local/bin/openpalm-backup.sh" > /etc/cron.d/openpalm-backup
chmod 644 /etc/cron.d/openpalm-backup

echo "[openpalm] bootstrap complete at $(date -u)"
