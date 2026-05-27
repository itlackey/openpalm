#!/usr/bin/env bash
set -e

# Install the channel npm package if specified.
#
# CHANNEL_PACKAGE should pin the version to keep restarts reproducible
# (e.g. `@openpalm/channel-api@1.4.2`, not `@openpalm/channel-api@latest`).
# `--exact` forces bun to record that exact version in the per-container
# package.json so subsequent installs in this same container resolve to the
# same artifact even if the registry advances.
#
# TODO (follow-up): bake one image per channel at build time so we stop
# making a network round-trip on every container start. The per-channel
# image keeps the unified runtime entrypoint and just pre-installs
# CHANNEL_PACKAGE so this curl-then-run pattern goes away.
if [ -n "$CHANNEL_PACKAGE" ]; then
	echo "Installing channel package: $CHANNEL_PACKAGE"
	bun add --exact "$CHANNEL_PACKAGE"
fi

# Run the channel entrypoint. varlock-based runtime redaction was retired
# in #391; secret hygiene now lives in the in-process logger redactor
# (`@openpalm/lib/logger`) and the `akm vault` secret store.
#
# Channels that do not use the default BaseChannel entrypoint can override
# this by setting CHANNEL_ENTRYPOINT to a path inside the installed package.
ENTRYPOINT="${CHANNEL_ENTRYPOINT:-node_modules/@openpalm/channels-sdk/src/channel-entrypoint.ts}"
exec bun run "$ENTRYPOINT"
