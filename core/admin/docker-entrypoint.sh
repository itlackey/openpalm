#!/bin/sh
set -e

# ── Admin entrypoint ─────────────────────────────────────────────────────
# Ensures Docker socket access and correct file ownership on volumes.
#
# Some Docker runtimes (OrbStack, Colima) remap Docker socket ownership
# to root:root inside containers. The standard user + group_add compose
# approach fails because the group_add GID is detected on the host and
# may not match the in-container GID.
#
# This entrypoint runs as root (the container default), creates a runtime
# user matching the host UID/GID, grants that user Docker socket access
# via the socket's actual in-container group, then drops privileges.
#
# Environment:
#   OPENPALM_UID  — target user ID  (default: 1000)
#   OPENPALM_GID  — target group ID (default: 1000)
# ──────────────────────────────────────────────────────────────────────────

TARGET_UID="${OPENPALM_UID:-1000}"
TARGET_GID="${OPENPALM_GID:-1000}"

# ── Create runtime user with matching host UID/GID ────────────────────
groupadd -g "$TARGET_GID" -o openpalm 2>/dev/null || true
useradd -u "$TARGET_UID" -g openpalm -o -M -d /app -s /sbin/nologin openpalm 2>/dev/null || true

# ── Grant Docker socket access ────────────────────────────────────────
if [ -S /var/run/docker.sock ]; then
  SOCK_GID=$(stat -c '%g' /var/run/docker.sock)
  if [ "$SOCK_GID" != "$TARGET_GID" ]; then
    # Ensure a group with the socket's GID exists, then add our user to it
    if ! getent group "$SOCK_GID" >/dev/null 2>&1; then
      groupadd -g "$SOCK_GID" -o dockersock 2>/dev/null || true
    fi
    usermod -aG "$SOCK_GID" openpalm 2>/dev/null || true
  fi
fi

exec gosu openpalm "$@"
