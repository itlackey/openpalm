#!/usr/bin/env bash
set -euo pipefail

# ── Cron setup ─────────────────────────────────────────────────────────
# Staged cron files live in STATE_HOME/cron/ (already bind-mounted).
# Copy them to /etc/cron.d/ with required ownership (root:root, 644)
# so crond will accept them. Filenames in /etc/cron.d/ must not contain
# dots, so the .cron extension is stripped and files are prefixed.
CRON_DIR="${OPENPALM_STATE_HOME:-}/cron"
CRON_ACTIVE=0
if [ -n "$CRON_DIR" ] && [ -d "$CRON_DIR" ]; then
	rm -f /etc/cron.d/openpalm-*

	for f in "$CRON_DIR"/*.cron; do
		[ -f "$f" ] || continue
		base=$(basename "$f" .cron)
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

# ── Drop privileges and run SvelteKit app ──────────────────────────────
exec gosu "${OPENPALM_UID:-1000}:${OPENPALM_GID:-1000}" node build/index.js
