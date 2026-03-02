#!/bin/bash
set -e

# Install the channel npm package if specified
if [ -n "$CHANNEL_PACKAGE" ]; then
  echo "Installing channel package: $CHANNEL_PACKAGE"
  bun add "$CHANNEL_PACKAGE"
fi

# Run the channel entrypoint
exec bun run node_modules/@openpalm/channels-sdk/src/channel-entrypoint.ts
