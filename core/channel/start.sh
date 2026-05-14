#!/usr/bin/env bash
set -e

# Install the channel npm package if specified
if [ -n "$CHANNEL_PACKAGE" ]; then
	echo "Installing channel package: $CHANNEL_PACKAGE"
	bun add "$CHANNEL_PACKAGE"
fi

# Run the channel entrypoint. varlock-based runtime redaction was retired
# in #391; secret hygiene now lives in the in-process logger redactor
# (`@openpalm/lib/logger`) and the `akm vault` secret store.
exec bun run node_modules/@openpalm/channels-sdk/src/channel-entrypoint.ts
