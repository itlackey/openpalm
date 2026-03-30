#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
Usage: scripts/pass-init.sh --gpg-id <recipient> [--home <openpalm-home>] [--prefix <pass-prefix>]

Initializes an install-scoped pass store for OpenPalm and writes
data/secrets/provider.json so the admin runtime can detect the pass backend.
EOF
}

OP_HOME="${OP_HOME:-${HOME}/.openpalm}"
PASS_PREFIX="openpalm"
GPG_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gpg-id)
      GPG_ID="${2:-}"
      shift 2
      ;;
    --home)
      OP_HOME="${2:-}"
      shift 2
      ;;
    --prefix)
      PASS_PREFIX="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$GPG_ID" ]]; then
  echo "--gpg-id is required" >&2
  usage >&2
  exit 1
fi

SECRETS_DIR="$OP_HOME/data/secrets"
STORE_DIR="$SECRETS_DIR/pass-store"
PROVIDER_CONFIG="$SECRETS_DIR/provider.json"

mkdir -p "$SECRETS_DIR"
chmod 0700 "$SECRETS_DIR"

export PASSWORD_STORE_DIR="$STORE_DIR"
if ! gpg --list-keys "$GPG_ID" >/dev/null 2>&1; then
  echo "GPG key not found or not readable: $GPG_ID" >&2
  exit 1
fi

if [[ ! -d "$STORE_DIR" || ! -f "$STORE_DIR/.gpg-id" ]]; then
  pass init "$GPG_ID"
fi

if [[ ! -f "$STORE_DIR/.gpg-id" ]] || ! grep -Fxq "$GPG_ID" "$STORE_DIR/.gpg-id"; then
  echo "pass store initialization failed for $GPG_ID" >&2
  exit 1
fi

cat >"$PROVIDER_CONFIG" <<EOF
{
  "provider": "pass",
  "passwordStoreDir": "$STORE_DIR",
  "passPrefix": "$PASS_PREFIX"
}
EOF
chmod 0600 "$PROVIDER_CONFIG"

echo "Initialized pass backend at $STORE_DIR"
