# ── Channel Runner — Unified container for baked OpenPalm channels ────────────
#
# Runs the first-party channel adapters copied from the workspace at build time.
# Set CHANNEL_PACKAGE to the baked package name at runtime.
# ──────────────────────────────────────────────────────────────────────────────

FROM oven/bun:1.3-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Build against a minimal workspace root so the baked adapters can keep their
# local workspace reference to @openpalm/channels-sdk during install.
RUN mkdir -p /app/packages/channels-sdk /app/packages/channel-api /app/packages/channel-discord /app/packages/channel-slack
COPY packages/channels-sdk/package.json /app/packages/channels-sdk/package.json
COPY packages/channel-api/package.json /app/packages/channel-api/package.json
COPY packages/channel-discord/package.json /app/packages/channel-discord/package.json
COPY packages/channel-slack/package.json /app/packages/channel-slack/package.json
RUN printf '%s\n' '{' '  "name": "openpalm-channel-image",' '  "private": true,' '  "workspaces": [' '    "packages/channels-sdk",' '    "packages/channel-api",' '    "packages/channel-discord",' '    "packages/channel-slack"' '  ]' '}' > /app/package.json

# Bake the SDK and first-party adapters into the image from the workspace.
COPY packages/channels-sdk /app/packages/channels-sdk
COPY packages/channel-api /app/packages/channel-api
COPY packages/channel-discord /app/packages/channel-discord
COPY packages/channel-slack /app/packages/channel-slack

RUN bun install --production

# Startup script validates CHANNEL_PACKAGE then runs the entrypoint.
COPY core/channel/start.sh /app/start.sh
RUN chmod +x /app/start.sh

RUN mkdir -p /home/bun \
    && chown -R bun:bun /app /home/bun

ENV HOME=/home/bun
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -sf "http://localhost:${PORT}/health" || exit 1

USER bun
CMD ["/app/start.sh"]
