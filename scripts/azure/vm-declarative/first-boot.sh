#!/usr/bin/env bash
# first-boot.sh — Runs once on the VM via cloud-init.
#
# Sources /etc/openpalm/config (written by cloud-init) for all settings.
# Installs Docker + Azure CLI, pulls secrets from Key Vault, patches the
# setup spec, and runs the OpenPalm CLI installer.

set -euo pipefail
exec > >(tee -a /var/log/openpalm-bootstrap.log) 2>&1
echo "[openpalm] started at $(date -u)"

source /etc/openpalm/config

SETUP_FILE="/var/lib/openpalm/setup-spec.yaml"

# ── Wait for apt locks ──────────────────────────────────────────────────
echo "[openpalm] waiting for apt locks"
for _ in $(seq 1 60); do
  fuser /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break
  sleep 3
done

# ── Install Azure CLI + Docker ──────────────────────────────────────────
echo "[openpalm] installing Azure CLI"
curl -sL https://aka.ms/InstallAzureCLIDeb | bash

echo "[openpalm] installing Docker"
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
usermod -aG docker "$ADMIN_USER"

echo "[openpalm] waiting for Docker"
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done
docker info >/dev/null 2>&1 || { echo "[openpalm] ERROR: Docker not ready"; exit 1; }

# ── Pull secrets from Key Vault ─────────────────────────────────────────
echo "[openpalm] authenticating with managed identity"
az login --identity --output none

get_secret() { az keyvault secret show --vault-name "$KV_NAME" --name "$1" --query value -o tsv 2>/dev/null || echo ""; }

KV_ADMIN_TOKEN="$(get_secret op-admin-token)"
KV_ASSISTANT_TOKEN="$(get_secret op-assistant-token)"
KV_SLACK_BOT_TOKEN="$(get_secret slack-bot-token)"
KV_SLACK_APP_TOKEN="$(get_secret slack-app-token)"

# ── Decode and patch the setup spec ─────────────────────────────────────
mkdir -p /var/lib/openpalm
base64 -d /var/lib/openpalm/setup-spec.b64 > "$SETUP_FILE"
rm -f /var/lib/openpalm/setup-spec.b64

# Build patch arguments
PATCH_ARGS=()
[[ -n "$KV_ADMIN_TOKEN" ]]    && PATCH_ARGS+=("spec.security.adminToken=${KV_ADMIN_TOKEN}")
[[ -n "$KV_ASSISTANT_TOKEN" ]] && PATCH_ARGS+=("spec.security.assistantToken=${KV_ASSISTANT_TOKEN}")

if [[ -n "$KV_SLACK_BOT_TOKEN" && -n "$KV_SLACK_APP_TOKEN" ]]; then
  echo "[openpalm] Slack tokens found — enabling Slack"
  PATCH_ARGS+=("spec.channels.slack.enabled=true")
  PATCH_ARGS+=("spec.channelCredentials.slack.slackBotToken=${KV_SLACK_BOT_TOKEN}")
  PATCH_ARGS+=("spec.channelCredentials.slack.slackAppToken=${KV_SLACK_APP_TOKEN}")
else
  echo "[openpalm] No Slack tokens — Slack stays disabled"
  PATCH_ARGS+=("spec.channels.slack.enabled=false")
fi

# Patch using inline Python (structured YAML edit, not sed)
if [[ ${#PATCH_ARGS[@]} -gt 0 ]]; then
  python3 - "$SETUP_FILE" "${PATCH_ARGS[@]}" <<'PYEOF'
import sys, yaml
from pathlib import Path

def set_nested(obj, key, val):
    parts = key.split(".")
    for p in parts[:-1]:
        obj = obj.setdefault(p, {})
    obj[parts[-1]] = {"true": True, "false": False}.get(val.lower(), val) if isinstance(val, str) else val

path = Path(sys.argv[1])
doc = yaml.safe_load(path.read_text())
for arg in sys.argv[2:]:
    k, _, v = arg.partition("=")
    if k and _: set_nested(doc, k, v)
path.write_text(yaml.dump(doc, default_flow_style=False, sort_keys=False))
PYEOF
fi

chown "$ADMIN_USER":"$ADMIN_USER" /var/lib/openpalm "$SETUP_FILE"
chmod 600 "$SETUP_FILE"

# ── Install OpenPalm ────────────────────────────────────────────────────
mkdir -p "$OP_INSTALL_DIR"
chown -R "$ADMIN_USER":"$ADMIN_USER" "$(dirname "$OP_INSTALL_DIR")"

SETUP_URL="https://raw.githubusercontent.com/itlackey/openpalm/${SETUP_REF}/scripts/setup.sh"
echo "[openpalm] installing CLI ${OP_VERSION} from ref ${SETUP_REF}"
sudo -u "$ADMIN_USER" -H env \
  OP_INSTALL_DIR="$OP_INSTALL_DIR" \
  OP_HOME="$OP_HOME" \
  bash -c "curl -fsSL ${SETUP_URL} | bash -s -- --version ${OP_VERSION} --force --no-open --file ${SETUP_FILE}"

# ── Backup cron ─────────────────────────────────────────────────────────
echo "0 3 * * * root /usr/local/bin/openpalm-backup.sh" > /etc/cron.d/openpalm-backup
chmod 644 /etc/cron.d/openpalm-backup

echo "[openpalm] done at $(date -u)"
