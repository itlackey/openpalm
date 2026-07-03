#!/usr/bin/env bash
set -euo pipefail

if [ -z "${PORTAL_PACKAGE:-}" ]; then
	echo "PORTAL_PACKAGE must name a baked adapter package" >&2
	exit 1
fi

export HOME="/tmp/openpalm-portal"
mkdir -p "$HOME"
export BUN_INSTALL_CACHE_DIR="${BUN_INSTALL_CACHE_DIR:-$HOME/.cache/bun/install}"

# Install or update adapter packages from the operator-managed package.json
# (bind-mounted at /opt/openpalm/tools from OP_HOME/data/portal/tools).
# Use bun install on cold start (node_modules absent) and bun update on warm
# restarts — both resolve within the declared semver ranges.
if [ ! -f "/opt/openpalm/tools/package.json" ]; then
	echo "ERROR: /opt/openpalm/tools/package.json not found — seed OP_HOME/data/portal/tools/package.json" >&2
	exit 1
fi
if [ ! -d "/opt/openpalm/tools/node_modules" ]; then
	bun install --cwd /opt/openpalm/tools --production \
		|| { echo "ERROR: tool install failed; check logs above" >&2; exit 1; }
else
	bun update --cwd /opt/openpalm/tools --production \
		|| echo "WARN: tool update had errors; check logs above" >&2
fi

# Run the portal entrypoint. varlock-based runtime redaction was retired
# in #391; secret hygiene now lives in the in-process logger redactor
# (`@openpalm/lib/logger`) and the akm secret store (knowledge/secrets/).
#
# Portals that do not use the default entrypoint can override
# this by setting PORTAL_ENTRYPOINT to a path inside the baked package.
ENTRYPOINT="${PORTAL_ENTRYPOINT:-/app/portal-entrypoint.ts}"
exec bun run "$ENTRYPOINT"
