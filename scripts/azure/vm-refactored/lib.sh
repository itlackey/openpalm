#!/usr/bin/env bash
# lib.sh — Shared helper functions for the deploy scripts.
# Source this file; do not execute it directly.

set -euo pipefail

# ── Logging ──────────────────────────────────────────────────────────────
info()  { printf '  → %s\n' "$*"; }
error() { printf '  ✗ %s\n' "$*" >&2; }

# ── Require a command exists ─────────────────────────────────────────────
require() {
  command -v "$1" >/dev/null 2>&1 || {
    error "Missing required command: $1"
    exit 1
  }
}

# ── Generate a 44-char url-safe secret ───────────────────────────────────
generate_secret() {
  openssl rand -base64 32 | tr -d '/+=' | head -c 44
}

# ── Resolve the setup.sh git ref that matches OPENPALM_VERSION ──────────
# Checks whether a GitHub release tag exists; falls back to release/<ver>.
resolve_setup_ref() {
  local ver="$1"
  local bare="${ver#v}"
  local tag_url="https://github.com/itlackey/openpalm/releases/tag/${ver}"
  if curl -fsSL --head "$tag_url" >/dev/null 2>&1; then
    printf '%s\n' "${ver}"
  else
    printf 'release/%s\n' "${bare}"
  fi
}

# ── Write a secret to Key Vault (idempotent) ────────────────────────────
kv_set_secret() {
  local vault="$1" name="$2" value="$3"
  az keyvault secret set --vault-name "$vault" --name "$name" --value "$value" --output none
}
