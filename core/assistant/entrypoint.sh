#!/usr/bin/env bash
set -euo pipefail

PORT="${OPENCODE_PORT:-4096}"
ENABLE_SSH="${OPENCODE_ENABLE_SSH:-0}"
TARGET_UID="${OPENPALM_UID:-1000}"
TARGET_GID="${OPENPALM_GID:-1000}"
TARGET_USER="opencode"
TARGET_GROUP="opencode"

ensure_user_mapping() {
  if ! command -v getent >/dev/null 2>&1; then
    return 0
  fi

  local existing_group
  existing_group="$(getent group "$TARGET_GID" | cut -d: -f1 || true)"
  if [ -n "$existing_group" ]; then
    TARGET_GROUP="$existing_group"
  elif [ "$(id -u)" = "0" ]; then
    groupadd --gid "$TARGET_GID" "$TARGET_GROUP" >/dev/null 2>&1 || true
  fi

  local existing_user
  existing_user="$(getent passwd "$TARGET_UID" | cut -d: -f1 || true)"
  if [ -n "$existing_user" ]; then
    TARGET_USER="$existing_user"
  elif [ "$(id -u)" = "0" ]; then
    useradd \
      --uid "$TARGET_UID" \
      --gid "$TARGET_GID" \
      --home-dir /home/opencode \
      --shell /bin/bash \
      --no-create-home \
      "$TARGET_USER" >/dev/null 2>&1 || true
  fi
}

ensure_home_layout() {
  mkdir -p \
    /home/opencode \
    /home/opencode/.cache \
    /home/opencode/.config/opencode \
    /home/opencode/.local/state/opencode \
    /home/opencode/.local/share/opencode \
    /work \
    /etc/opencode

  if [ "$(id -u)" = "0" ]; then
    chown -R "$TARGET_UID:$TARGET_GID" \
      /home/opencode \
      /work \
      /etc/opencode \
      /var/run/sshd 2>/dev/null || true
  fi
}

maybe_set_openmemory_user_id() {
  if [ -n "${OPENMEMORY_USER_ID:-}" ] && [ "${OPENMEMORY_USER_ID}" != "default_user" ]; then
    return 0
  fi

  local inferred_user
  inferred_user=""

  if command -v getent >/dev/null 2>&1; then
    inferred_user="$(getent passwd "$TARGET_UID" | cut -d: -f1 || true)"
  fi

  if [ -z "$inferred_user" ] && command -v whoami >/dev/null 2>&1; then
    inferred_user="$(whoami 2>/dev/null || true)"
  fi

  if [ -z "$inferred_user" ]; then
    inferred_user="opencode"
  fi

  export OPENMEMORY_USER_ID="$inferred_user"
}

maybe_enable_ssh() {
  if [ "$ENABLE_SSH" != "1" ] && [ "$ENABLE_SSH" != "true" ]; then
    return 0
  fi

  mkdir -p /var/run/sshd /home/opencode/.ssh

  if [ "$(id -u)" = "0" ]; then
    chown -R "$TARGET_UID:$TARGET_GID" /home/opencode/.ssh
    chmod 755 /home/opencode
    chmod 700 /home/opencode/.ssh
  fi

  touch /home/opencode/.ssh/authorized_keys

  if [ "$(id -u)" = "0" ]; then
    chown "$TARGET_UID:$TARGET_GID" /home/opencode/.ssh/authorized_keys
    chmod 600 /home/opencode/.ssh/authorized_keys
  fi

  if command -v openssl >/dev/null 2>&1; then
    usermod -p "$(openssl passwd -6 "$(openssl rand -hex 16)")" "$TARGET_USER" 2>/dev/null || true
  fi

  if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
    ssh-keygen -A
  fi

  /usr/sbin/sshd \
    -o PasswordAuthentication=no \
    -o PermitRootLogin=no \
    -o AuthorizedKeysFile=/home/opencode/.ssh/authorized_keys \
    -o AllowTcpForwarding=no \
    -o X11Forwarding=no \
    -o PermitTunnel=no \
    -o UsePAM=no \
    -o PubkeyAuthentication=yes \
    -o StrictModes=yes
}

start_opencode() {
  cd /work

  if [ "$(id -u)" = "0" ]; then
    exec gosu "$TARGET_UID:$TARGET_GID" opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs
  fi

  exec opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs
}

ensure_user_mapping
ensure_home_layout
maybe_set_openmemory_user_id
maybe_enable_ssh
start_opencode
