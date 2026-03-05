#!/usr/bin/env bash
set -euo pipefail

PORT="${OPENCODE_PORT:-4096}"
ENABLE_SSH="${OPENCODE_ENABLE_SSH:-0}"

# Ensure cache and config directories exist and are writable by the current UID
# (the container may run as an arbitrary UID via OPENPALM_UID)
mkdir -p /home/opencode/.cache /home/opencode/.config 2>/dev/null || true

# Support arbitrary UIDs (e.g. macOS where user UID ≠ 1000).
# If the current UID has no /etc/passwd entry, add one so tools like
# 'whoami', 'git', and 'gh' can resolve a username.
if ! getent passwd "$(id -u)" >/dev/null 2>&1; then
	if printf 'opencode:x:%d:%d:OpenCode:/home/opencode:/bin/bash\n' \
		"$(id -u)" "$(id -g)" >> /etc/passwd 2>/dev/null; then
		: # entry added successfully
	else
		echo "opencode-entrypoint: warning: could not add UID $(id -u) to /etc/passwd; whoami/git/gh may fail" >&2
	fi
fi

export HOME=/home/opencode
export USER="${USER:-opencode}"
export LOGNAME="${LOGNAME:-opencode}"

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
