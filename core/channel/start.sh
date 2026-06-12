#!/usr/bin/env bash
set -e

if [ -z "$CHANNEL_PACKAGE" ]; then
	echo "CHANNEL_PACKAGE must name a baked adapter package" >&2
	exit 1
fi

# Run the channel entrypoint. varlock-based runtime redaction was retired
# in #391; secret hygiene now lives in the in-process logger redactor
# (`@openpalm/lib/logger`) and the akm secret store (knowledge/secrets/).
#
# Channels that do not use the default BaseChannel entrypoint can override
# this by setting CHANNEL_ENTRYPOINT to a path inside the baked package.
ENTRYPOINT="${CHANNEL_ENTRYPOINT:-/app/channel-entrypoint.ts}"
exec bun run "$ENTRYPOINT"
