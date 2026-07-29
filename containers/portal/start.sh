#!/usr/bin/env bash
set -euo pipefail

if [ -z "${PORTAL_PACKAGE:-}" ]; then
	echo "PORTAL_PACKAGE must name a baked adapter package" >&2
	exit 1
fi

export HOME="/tmp/openpalm-portal"
mkdir -p "$HOME"
export BUN_INSTALL_CACHE_DIR="${BUN_INSTALL_CACHE_DIR:-$HOME/.cache/bun/install}"

# E2/S2: adapter packages (@openpalm/discord-portal, @openpalm/slack-portal)
# are packed from local candidates and baked into /opt/openpalm/tools at image
# build time. No bind mount overlays that path
# anymore (the image-baked-only model) — the
# baked tree IS what runs; there is no boot-time install or update. Keep only
# a fast presence check so a broken/incomplete image build fails loudly here
# instead of surfacing as an obscure "module not found" once the adapter
# entrypoint tries to import it.
if [ ! -d "/opt/openpalm/tools/node_modules" ]; then
	echo "ERROR: /opt/openpalm/tools/node_modules not found — the image was not built with the adapter tools baked in" >&2
	exit 1
fi

# Run the portal entrypoint. varlock-based runtime redaction was retired
# in #391; secret hygiene now lives in the in-process logger redactor
# (`@openpalm/lib/logger`) and the akm secret store (knowledge/secrets/).
#
# Portals that do not use the default entrypoint can override
# this by setting PORTAL_ENTRYPOINT to a path inside the baked package.
ENTRYPOINT="${PORTAL_ENTRYPOINT:-/app/portal-entrypoint.ts}"
exec bun run "$ENTRYPOINT"
