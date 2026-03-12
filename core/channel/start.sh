#!/usr/bin/env bash
set -e

# Install the channel npm package if specified
if [ -n "$CHANNEL_PACKAGE" ]; then
	echo "Installing channel package: $CHANNEL_PACKAGE"
	bun add "$CHANNEL_PACKAGE"
fi

# Run the channel entrypoint, wrapping with varlock for secret redaction if available
if command -v varlock >/dev/null 2>&1 && [ -f /app/.env.schema ]; then
  exec varlock run --path /app/ -- bun run node_modules/@openpalm/channels-sdk/src/channel-entrypoint.ts
fi
exec bun run node_modules/@openpalm/channels-sdk/src/channel-entrypoint.ts
