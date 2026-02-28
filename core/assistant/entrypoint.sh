#!/usr/bin/env bash
set -euo pipefail

PORT="${OPENCODE_PORT:-4096}"
ENABLE_SSH="${OPENCODE_ENABLE_SSH:-0}"
TARGET_UID="${OPENPALM_UID:-1000}"
TARGET_GID="${OPENPALM_GID:-1000}"

# ── UID/GID alignment ─────────────────────────────────────────────────
# Ensure the node user inside the container matches the host user's
# UID/GID so bind-mounted files have correct ownership.
if [ "$(id -u node)" != "$TARGET_UID" ]; then
	usermod -u "$TARGET_UID" -o node 2>/dev/null || true
fi
if [ "$(id -g node)" != "$TARGET_GID" ]; then
	groupmod -g "$TARGET_GID" -o node 2>/dev/null || true
fi
chown -R node:node /home/opencode 2>/dev/null || true

# ── Cron setup ─────────────────────────────────────────────────────────
# Staged cron files are mounted read-only at /opt/cron.d/ from
# STATE_HOME/cron/. Copy them to /etc/cron.d/ with required ownership
# (root:root, 644) so crond will accept them.
#
# Cron file format (standard /etc/cron.d/ — includes user field):
#   SHELL=/bin/bash
#   0 2 * * * node /work/scripts/backup.sh
#
# Filenames in /etc/cron.d/ must contain only [a-zA-Z0-9_-] (no dots),
# so the .cron extension is stripped and files are prefixed with "openpalm-".
CRON_STAGED="/opt/cron.d"
CRON_ACTIVE=0
if [ -d "$CRON_STAGED" ]; then
	# Clean any previous openpalm cron files
	rm -f /etc/cron.d/openpalm-*

	for f in "$CRON_STAGED"/*.cron; do
		[ -f "$f" ] || continue
		base=$(basename "$f" .cron)
		# Sanitize: replace dots with hyphens (cron ignores filenames with dots)
		safe_name=$(echo "$base" | tr '.' '-')
		dest="/etc/cron.d/openpalm-${safe_name}"
		cp "$f" "$dest"
		chown root:root "$dest"
		chmod 644 "$dest"
		CRON_ACTIVE=1
	done

	if [ "$CRON_ACTIVE" = "1" ]; then
		cron
	fi
fi

# ── SSH setup ──────────────────────────────────────────────────────────
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

# ── Drop privileges and run opencode ───────────────────────────────────
cd /work
exec gosu node opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs
