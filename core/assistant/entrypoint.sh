#!/usr/bin/env bash
set -euo pipefail

PORT="${OPENCODE_PORT:-4096}"
ENABLE_SSH="${OPENCODE_ENABLE_SSH:-0}"

if [[ "$ENABLE_SSH" == "1" ]]; then
  mkdir -p /run/sshd
  if [[ ! -f /etc/ssh/ssh_host_rsa_key ]]; then
    ssh-keygen -A
  fi

  if [[ -n "${OPENCODE_SSH_PUBLIC_KEY:-}" ]]; then
    mkdir -p /home/opencode/.ssh
    printf '%s\n' "$OPENCODE_SSH_PUBLIC_KEY" > /home/opencode/.ssh/authorized_keys
    chown -R opencode:opencode /home/opencode/.ssh
    chmod 700 /home/opencode/.ssh
    chmod 600 /home/opencode/.ssh/authorized_keys
  fi

  /usr/sbin/sshd -D &
fi

cd /work
exec opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs
