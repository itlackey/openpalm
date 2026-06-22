#!/usr/bin/env bash
set -e

if [ -z "$PORTAL_PACKAGE" ]; then
	echo "PORTAL_PACKAGE must name a baked adapter package" >&2
	exit 1
fi

# Update adapter packages within declared semver ranges (same pattern as
# assistant and guardian). Falls back to baked image defaults on error.
bun update --cwd /opt/openpalm/tools --production \
	|| echo "WARN: tool update had errors; check logs above" >&2

# Run the portal entrypoint. varlock-based runtime redaction was retired
# in #391; secret hygiene now lives in the in-process logger redactor
# (`@openpalm/lib/logger`) and the akm secret store (knowledge/secrets/).
#
# Portals that do not use the default entrypoint can override
# this by setting PORTAL_ENTRYPOINT to a path inside the baked package.
ENTRYPOINT="${PORTAL_ENTRYPOINT:-/app/portal-entrypoint.ts}"
exec bun run "$ENTRYPOINT"
