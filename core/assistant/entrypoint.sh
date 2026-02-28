#!/usr/bin/env bash
set -euo pipefail

PORT="${OPENCODE_PORT:-4096}"
ENABLE_SSH="${OPENCODE_ENABLE_SSH:-0}"

if [ "$ENABLE_SSH" = "1" ] || [ "$ENABLE_SSH" = "true" ]; then
	mkdir -p /var/run/sshd /home/opencode/.ssh
	chown -R node:node /home/opencode/.ssh
	chmod 755 /home/opencode
	chmod 700 /home/opencode/.ssh
	touch /home/opencode/.ssh/authorized_keys
	chown node:node /home/opencode/.ssh/authorized_keys
	chmod 600 /home/opencode/.ssh/authorized_keys
	if command -v openssl >/dev/null 2>&1; then
		usermod -p "$(openssl passwd -6 "$(openssl rand -hex 16)")" node 2>/dev/null || true
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
fi

cd /work
exec opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs
