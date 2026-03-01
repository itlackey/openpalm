#!/usr/bin/env bash
set -euo pipefail

# ── Automation environment ────────────────────────────────────────────
# Scheduled jobs run under crond which does not inherit the container's
# environment. Write key variables to a sourceable file so automation
# scripts can access the admin API and resolve paths.
cat > /etc/openpalm-env <<EOF
ADMIN_TOKEN=${ADMIN_TOKEN:-}
OPENPALM_STATE_HOME=${OPENPALM_STATE_HOME:-}
OPENPALM_CONFIG_HOME=${OPENPALM_CONFIG_HOME:-}
OPENPALM_DATA_HOME=${OPENPALM_DATA_HOME:-}
EOF
chmod 600 /etc/openpalm-env

# ── Automation setup ─────────────────────────────────────────────────
# Staged automation files live in STATE_HOME/automations/ (already
# bind-mounted). Copy them to /etc/cron.d/ with required ownership
# (root:root, 644) so the scheduler will accept them.
AUTOMATIONS_DIR="${OPENPALM_STATE_HOME:-}/automations"
AUTOMATIONS_ACTIVE=0
if [ -n "$AUTOMATIONS_DIR" ] && [ -d "$AUTOMATIONS_DIR" ]; then
	rm -f /etc/cron.d/openpalm-*

	for f in "$AUTOMATIONS_DIR"/*; do
		[ -f "$f" ] || continue
		base=$(basename "$f")
		safe_name=$(echo "$base" | tr '.' '-')
		dest="/etc/cron.d/openpalm-${safe_name}"
		cp "$f" "$dest"
		chown root:root "$dest"
		chmod 644 "$dest"
		AUTOMATIONS_ACTIVE=1
	done

	if [ "$AUTOMATIONS_ACTIVE" = "1" ]; then
		cron
	fi
fi

# ── Drop privileges and run SvelteKit app ──────────────────────────────
exec gosu "${OPENPALM_UID:-1000}:${OPENPALM_GID:-1000}" node build/index.js
