#!/usr/bin/env bash
set -euo pipefail

# ── Resolve runtime UID/GID (default: 1000, overridden by OPENPALM_UID/GID) ──
TARGET_UID="${OPENPALM_UID:-1000}"
TARGET_GID="${OPENPALM_GID:-1000}"
CURRENT_UID=$(id -u openpalm)
CURRENT_GID=$(getent group openpalm | cut -d: -f3)

if [ "$TARGET_GID" != "$CURRENT_GID" ]; then
  groupmod -g "$TARGET_GID" openpalm
fi
if [ "$TARGET_UID" != "$CURRENT_UID" ]; then
  usermod -u "$TARGET_UID" openpalm
fi

# ── Fix ownership on bind-mounted volumes ─────────────────────────────────────
# /config and /state contain only small env files and rendered configs — safe
# to recursively chown. /data is large (postgres, qdrant) so only fix /data/admin.
for dir in /config /state; do
  [ -d "$dir" ] && chown -R "$TARGET_UID:$TARGET_GID" "$dir"
done
[ -d /data ] && chown "$TARGET_UID:$TARGET_GID" /data
[ -d /data/admin ] && chown -R "$TARGET_UID:$TARGET_GID" /data/admin

# ── Docker socket access ──────────────────────────────────────────────────────
# Detect the GID of the Docker socket and add openpalm to that group
DOCKER_SOCK="${OPENPALM_CONTAINER_SOCKET_IN_CONTAINER:-/var/run/docker.sock}"
if [ -S "$DOCKER_SOCK" ]; then
  DOCKER_GID=$(stat -c '%g' "$DOCKER_SOCK")
  # Create or reuse a group with that GID and add openpalm
  if ! getent group "$DOCKER_GID" >/dev/null 2>&1; then
    groupadd -g "$DOCKER_GID" docker-host
  fi
  DOCKER_GROUP=$(getent group "$DOCKER_GID" | cut -d: -f1)
  usermod -aG "$DOCKER_GROUP" openpalm
fi

# ── Start cron daemon (runs as root, reads user crontabs) ─────────────────────
cron

# ── Drop to non-root and start the admin server ──────────────────────────────
exec gosu openpalm bun run src/server.ts
