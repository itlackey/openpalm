#!/usr/bin/env bash
# gws-setup.sh — Interactive Google Workspace CLI setup for OpenPalm
#
# Authenticates the gws CLI on the host, then copies credentials into
# vault/user/.gws/ so the assistant container can use them.
#
# Usage:
#   ./scripts/gws-setup.sh [--op-home ~/.openpalm] [--scopes drive,gmail,sheets]
#
# Auth methods (prompted interactively):
#   1) Interactive setup  — gws auth setup (creates GCP project + OAuth + tokens)
#   2) Manual OAuth       — user provides client_secret.json, gws auth login generates tokens
#   3) Export from host   — copies existing ~/.config/gws/ to vault (all files)
#   4) Service account    — user provides a service account key JSON
#   5) Manual token       — user pastes a pre-obtained access token (~1hr expiry)
set -euo pipefail

OP_HOME="${OP_HOME:-${HOME}/.openpalm}"
SCOPES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --op-home)  OP_HOME="$2"; shift 2 ;;
    --scopes)   SCOPES="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--op-home PATH] [--scopes service1,service2]"
      echo ""
      echo "Options:"
      echo "  --op-home   OpenPalm home directory (default: ~/.openpalm)"
      echo "  --scopes    Comma-separated GWS scopes (default: interactive)"
      echo ""
      echo "Scopes: drive, gmail, sheets, calendar, chat, docs, admin, tasks, people"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

VAULT_GWS="${OP_HOME}/vault/user/.gws"
VAULT_USER="${OP_HOME}/vault/user"

# Check gws is installed
if ! command -v gws &>/dev/null; then
  echo "ERROR: gws CLI not found. Install it first:"
  echo "  npm install -g @googleworkspace/cli"
  echo "  # or: cargo install --git https://github.com/googleworkspace/cli --locked"
  echo "  # or: brew install googleworkspace-cli"
  exit 1
fi

echo "=== Google Workspace CLI Setup for OpenPalm ==="
echo ""
echo "OP_HOME: ${OP_HOME}"
echo "GWS config will be saved to: ${VAULT_GWS}/"
echo ""

# Ensure target directories exist
mkdir -p "${VAULT_GWS}"

echo "Choose an authentication method:"
echo ""
echo "  1) Interactive setup  — gws auth setup creates everything automatically"
echo "                          (GCP project + client_secret.json + credentials.json)"
echo ""
echo "  2) Manual OAuth       — you already downloaded client_secret.json from Cloud Console"
echo "                          (gws auth login will generate credentials.json)"
echo ""
echo "  3) Export from host   — you already ran 'gws auth login' on this machine"
echo "                          (copies ~/.config/gws/ contents to vault)"
echo ""
echo "  4) Service account    — you have a service account key JSON from Cloud Console"
echo "                          (no browser or login needed)"
echo ""
echo "  5) Manual token       — you have an access token from gcloud or another tool"
echo "                          (quick test only — expires in ~1 hour)"
echo ""
read -rp "Enter choice [1-5]: " choice

case "$choice" in
  1)
    echo ""
    echo "Running 'gws auth setup'..."
    echo "This will create a GCP project, enable Workspace APIs, and open a browser."
    echo "After you approve access, gws stores client_secret.json + encrypted credentials."
    echo ""
    if [[ -n "$SCOPES" ]]; then
      gws auth setup -s "$SCOPES"
    else
      gws auth setup
    fi
    echo ""
    echo "Copying all credentials to vault..."
    echo "  client_secret.json  — OAuth app identity"
    echo "  credentials.json    — encrypted user tokens"
    echo "  .encryption_key     — decryption key for credentials"
    cp -r "${HOME}/.config/gws/." "${VAULT_GWS}/"
    echo "Done. All files copied to ${VAULT_GWS}/"
    ;;

  2)
    echo ""
    echo "This method requires a client_secret.json downloaded from Google Cloud Console."
    echo ""
    echo "To get one:"
    echo "  1. Go to console.cloud.google.com > APIs & Services > Credentials"
    echo "  2. Create Credentials > OAuth client ID > Desktop app"
    echo "  3. Download the JSON file"
    echo "  4. IMPORTANT: Add yourself as a test user under OAuth consent screen > Test users"
    echo ""

    # Check if client_secret.json already exists
    if [[ -f "${HOME}/.config/gws/client_secret.json" ]]; then
      echo "Found existing client_secret.json at ~/.config/gws/client_secret.json"
      read -rp "Use this file? [Y/n]: " use_existing
      if [[ "${use_existing,,}" == "n" ]]; then
        read -rp "Path to your client_secret.json: " cs_path
        if [[ ! -f "$cs_path" ]]; then
          echo "ERROR: File not found: ${cs_path}"
          exit 1
        fi
        mkdir -p "${HOME}/.config/gws"
        cp "$cs_path" "${HOME}/.config/gws/client_secret.json"
        echo "Copied to ~/.config/gws/client_secret.json"
      fi
    else
      read -rp "Path to your client_secret.json: " cs_path
      if [[ ! -f "$cs_path" ]]; then
        echo "ERROR: File not found: ${cs_path}"
        exit 1
      fi
      mkdir -p "${HOME}/.config/gws"
      cp "$cs_path" "${HOME}/.config/gws/client_secret.json"
      echo "Copied to ~/.config/gws/client_secret.json"
    fi

    echo ""
    echo "Running 'gws auth login' — this will open a browser for you to approve access."
    echo "After approval, gws generates credentials.json (encrypted user tokens)."
    echo ""
    if [[ -n "$SCOPES" ]]; then
      gws auth login -s "$SCOPES"
    else
      echo "Tip: Use --scopes to limit scope count (unverified apps cap at ~25 scopes)"
      gws auth login
    fi
    echo ""
    echo "Copying all credentials to vault..."
    echo "  client_secret.json  — OAuth app identity (you provided this)"
    echo "  credentials.json    — encrypted user tokens (gws generated this)"
    echo "  .encryption_key     — decryption key for credentials"
    cp -r "${HOME}/.config/gws/." "${VAULT_GWS}/"
    echo "Done. All files copied to ${VAULT_GWS}/"
    ;;

  3)
    GWS_CONFIG="${HOME}/.config/gws"
    if [[ ! -d "$GWS_CONFIG" ]]; then
      echo "ERROR: No gws config found at ${GWS_CONFIG}"
      echo "Run 'gws auth login' first, then re-run this script with option 3."
      exit 1
    fi
    echo ""
    echo "Copying ${GWS_CONFIG}/ to ${VAULT_GWS}/..."
    cp -r "${GWS_CONFIG}/." "${VAULT_GWS}/"
    echo ""
    echo "Files copied:"
    ls -la "${VAULT_GWS}/"
    ;;

  4)
    echo ""
    echo "Service account auth uses a key JSON file downloaded from Cloud Console."
    echo ""
    echo "To get one:"
    echo "  1. Go to console.cloud.google.com > IAM & Admin > Service Accounts"
    echo "  2. Click a service account (or create one)"
    echo "  3. Keys tab > Add Key > Create new key > JSON"
    echo "  4. Download the JSON file"
    echo ""
    echo "Note: Service accounts need domain-wide delegation to access user data"
    echo "(Drive, Gmail, etc.) in Google Workspace organizations."
    echo ""
    read -rp "Path to service account key JSON: " sa_path
    if [[ ! -f "$sa_path" ]]; then
      echo "ERROR: File not found: ${sa_path}"
      exit 1
    fi
    # Service account keys go to gcloud-credentials.json (used by GOOGLE_APPLICATION_CREDENTIALS)
    cp "$sa_path" "${VAULT_USER}/gcloud-credentials.json"
    chmod 600 "${VAULT_USER}/gcloud-credentials.json"
    echo ""
    echo "Service account key saved to: ${VAULT_USER}/gcloud-credentials.json"
    echo "The container reads this via GOOGLE_APPLICATION_CREDENTIALS=/etc/vault/gcloud-credentials.json"
    ;;

  5)
    echo ""
    echo "Paste an access token from 'gcloud auth print-access-token' or similar."
    echo "WARNING: Access tokens expire after ~1 hour. This is for quick testing only."
    echo ""
    read -rp "Token: " token
    if [[ -z "$token" ]]; then
      echo "ERROR: Empty token"
      exit 1
    fi
    USER_ENV="${OP_HOME}/vault/user/user.env"
    # Append or update GOOGLE_WORKSPACE_CLI_TOKEN in user.env
    if grep -q '^GOOGLE_WORKSPACE_CLI_TOKEN=' "$USER_ENV" 2>/dev/null; then
      sed -i "s|^GOOGLE_WORKSPACE_CLI_TOKEN=.*|GOOGLE_WORKSPACE_CLI_TOKEN=${token}|" "$USER_ENV"
    else
      echo "GOOGLE_WORKSPACE_CLI_TOKEN=${token}" >> "$USER_ENV"
    fi
    echo "Token saved to ${USER_ENV}"
    echo "This token takes highest precedence — it overrides any other credentials."
    ;;

  *)
    echo "Invalid choice: ${choice}"
    exit 1
    ;;
esac

echo ""
echo "=== Verifying setup ==="

# Test with the vault credentials (only set CONFIG_DIR — setting CREDENTIALS_FILE
# to a missing file causes gws to fail instead of falling through to config dir)
export GOOGLE_WORKSPACE_CLI_CONFIG_DIR="${VAULT_GWS}"
unset GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE 2>/dev/null || true
if gws drive files list --params '{"pageSize": 1}' &>/dev/null; then
  echo "SUCCESS: gws authentication is working."
else
  echo "WARNING: gws verification failed. This may be normal if:"
  echo "  - The token hasn't been activated yet"
  echo "  - Drive API is not enabled for this project"
  echo "  - Scopes don't include Drive access"
  echo "  - You used a service account without domain-wide delegation"
  echo ""
  echo "Try manually:"
  echo "  GOOGLE_WORKSPACE_CLI_CONFIG_DIR=${VAULT_GWS} gws drive files list --params '{\"pageSize\": 1}'"
fi

echo ""
echo "=== Next Steps ==="
echo ""
echo "Recreate the assistant container to pick up the new credentials:"
echo "  docker compose ... up -d --force-recreate --no-deps assistant"
echo ""
echo "Do NOT use 'docker restart' — it does not re-read env_file changes."
