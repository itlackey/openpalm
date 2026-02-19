#!/usr/bin/env bash
# Sets up a local development environment for OpenPalm.
# Creates .env with absolute paths and seeds .dev/ directories to mimic
# the directory layout that the production installer creates on a fresh system.
#
# Usage:
#   ./dev-setup.sh           # first-time setup (no-clobber)
#   ./dev-setup.sh --clean   # wipe .dev/ and .env, then re-seed (fresh install)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
DEV_DIR="$REPO_ROOT/.dev"

# ── Handle --clean flag ──────────────────────────────────────────────
if [[ "${1:-}" == "--clean" ]]; then
  echo "Cleaning previous dev environment..."
  rm -rf "$DEV_DIR"
  rm -f "$REPO_ROOT/.env"
  echo "  Removed .dev/ and .env"
fi

echo "Setting up OpenPalm local dev environment..."
echo "  Repo root: $REPO_ROOT"
echo "  Dev dir:   $DEV_DIR"

# ── Create .env from template with absolute paths ───────────────────
if [[ -f "$REPO_ROOT/.env" ]]; then
  echo "  .env already exists — skipping (delete it or use --clean to regenerate)"
else
  sed "s|/REPLACE/WITH/ABSOLUTE/PATH|$REPO_ROOT|g" "$REPO_ROOT/.env.example" > "$REPO_ROOT/.env"
  echo "  Created .env"
fi

# ── Create the full XDG-style directory tree ─────────────────────────
# This mirrors exactly what the production installer creates on a new system.
# See assets/state/docker-compose.yml for the volume mounts that reference these.

# CONFIG_HOME directories
mkdir -p \
  "$DEV_DIR/config/caddy" \
  "$DEV_DIR/config/opencode-core" \
  "$DEV_DIR/config/channels" \
  "$DEV_DIR/config/cron" \
  "$DEV_DIR/config/ssh"

# DATA_HOME directories (persistent storage for databases, vectors, blobs)
mkdir -p \
  "$DEV_DIR/data/caddy" \
  "$DEV_DIR/data/postgres" \
  "$DEV_DIR/data/qdrant" \
  "$DEV_DIR/data/openmemory" \
  "$DEV_DIR/data/shared" \
  "$DEV_DIR/data/admin"

# STATE_HOME directories (runtime state, logs, workspace)
mkdir -p \
  "$DEV_DIR/state/caddy" \
  "$DEV_DIR/state/opencode-core" \
  "$DEV_DIR/state/workspace" \
  "$DEV_DIR/state/gateway"

# ── Seed config files (no-clobber: don't overwrite existing) ─────────
cp -n "$REPO_ROOT/assets/state/caddy/Caddyfile"  "$DEV_DIR/config/caddy/Caddyfile"        2>/dev/null || true
cp -n "$REPO_ROOT/assets/config/channels/"*.env   "$DEV_DIR/config/channels/"               2>/dev/null || true
cp -n "$REPO_ROOT/assets/config/secrets.env"      "$DEV_DIR/config/secrets.env"              2>/dev/null || true
cp -n "$REPO_ROOT/assets/config/user.env"         "$DEV_DIR/config/user.env"                 2>/dev/null || true
cp -n "$REPO_ROOT/assets/config/ssh/authorized_keys" "$DEV_DIR/config/ssh/authorized_keys"  2>/dev/null || true

# Seed empty opencode.jsonc for user overrides (extensions are baked into the image)
if [[ ! -f "$DEV_DIR/config/opencode-core/opencode.jsonc" ]]; then
  echo '{}' > "$DEV_DIR/config/opencode-core/opencode.jsonc"
fi

# Seed a default project in the workspace so OpenCode's web UI has something to open.
# OpenCode discovers projects by their git root, so we initialize a bare repo.
if [[ ! -d "$DEV_DIR/state/workspace/default/.git" ]]; then
  mkdir -p "$DEV_DIR/state/workspace/default"
  git init "$DEV_DIR/state/workspace/default" >/dev/null 2>&1
fi

echo ""
echo "Done. Directory layout:"
echo "  .dev/config/  — CONFIG_HOME (caddy, opencode-core, channels, cron, ssh, secrets.env, user.env)"
echo "  .dev/data/    — DATA_HOME   (postgres, qdrant, openmemory, caddy, shared, admin)"
echo "  .dev/state/   — STATE_HOME  (opencode-core, workspace, gateway, caddy)"
echo ""
echo "Start the stack:"
echo "  docker compose --project-directory . --env-file .env -f assets/state/docker-compose.yml -f docker-compose.yml up -d --build"
echo ""
echo "Fresh install (wipe everything and rebuild):"
echo "  ./dev-setup.sh --clean"
echo "  docker compose --project-directory . --env-file .env -f assets/state/docker-compose.yml -f docker-compose.yml up -d --build"
