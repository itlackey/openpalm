#!/usr/bin/env bash
set -euo pipefail

# Guardian entrypoint — seeds the operator-only akm vault with channel HMAC
# secrets before starting the guardian server.
#
# Channel HMAC secrets live canonically in vault/stack/guardian.env (loaded
# by docker compose as an env_file). This script mirrors those values into
# an akm vault inside the guardian stash so operators can audit, rotate,
# and consume them through the akm CLI without re-reading env files.
#
# Idempotent: re-running ensures the vault exists and overwrites only the
# CHANNEL_*_SECRET keys we manage. Unrelated keys in the vault are left
# untouched.

AKM_BIN="${AKM_BIN:-/usr/local/bin/akm}"
VAULT_NAME="${GUARDIAN_AKM_VAULT_NAME:-channel-hmac}"
STASH_ROOT="${AKM_STASH_DIR:-/akm-guardian}"

seed_channel_hmac_vault() {
  if [ ! -x "$AKM_BIN" ]; then
    echo "WARN: akm binary not found at $AKM_BIN — skipping vault seed" >&2
    return 0
  fi

  if [ ! -d "$STASH_ROOT" ]; then
    echo "WARN: akm stash dir $STASH_ROOT missing — skipping vault seed" >&2
    return 0
  fi

  # Discover CHANNEL_<NAME>_SECRET env vars and feed them into the vault.
  local count=0
  local key channel value

  # Create the vault (no-op if it already exists). `akm vault create` is
  # the documented init step in akm 0.8.0; ignore its exit code so we
  # tolerate "already exists" without depending on a specific message.
  "$AKM_BIN" vault create "$VAULT_NAME" >/dev/null 2>&1 || true

  while IFS='=' read -r key value; do
    case "$key" in
      CHANNEL_*_SECRET)
        # Strip CHANNEL_ prefix and _SECRET suffix → lowercase channel id.
        channel="${key#CHANNEL_}"
        channel="${channel%_SECRET}"
        if [ -z "$channel" ] || [ -z "$value" ]; then
          continue
        fi
        # akm vault set <vault> <key> <value>. We use the channel id (lowercased)
        # as the vault key so consumers can `akm vault run channel-hmac discord ...`.
        local lower
        lower="$(echo "$channel" | tr '[:upper:]' '[:lower:]')"
        if "$AKM_BIN" vault set "$VAULT_NAME" "$lower" "$value" >/dev/null 2>&1; then
          count=$((count + 1))
        else
          echo "WARN: akm vault set failed for channel $lower" >&2
        fi
        ;;
    esac
  done < <(env)

  echo "guardian: seeded $count channel HMAC secret(s) into akm vault '$VAULT_NAME'"
}

seed_channel_hmac_vault

# Hand off to the original command (varlock wraps bun run src/server.ts).
exec "$@"
