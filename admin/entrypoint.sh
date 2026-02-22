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
# Top-level mount points only (non-recursive — fast)
for dir in /data /config /state; do
  [ -d "$dir" ] && chown "$TARGET_UID:$TARGET_GID" "$dir"
done

# Small write-heavy subdirs (recursive — still fast, few files)
for dir in /state/automations /data/admin; do
  [ -d "$dir" ] && chown -R "$TARGET_UID:$TARGET_GID" "$dir"
done

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
