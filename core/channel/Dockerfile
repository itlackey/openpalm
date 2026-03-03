# ── Channel Runner — Unified container for npm-based OpenPalm channels ────────
#
# Runs any channel published as an npm package that extends BaseChannel.
# Set CHANNEL_PACKAGE to the npm package name at runtime.
# Falls back to CHANNEL_FILE for legacy file-based channels.
# ──────────────────────────────────────────────────────────────────────────────

FROM oven/bun:1-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Install the channels SDK
COPY packages/channels-sdk /app/node_modules/@openpalm/channels-sdk
RUN cd /app/node_modules/@openpalm/channels-sdk && bun install --production

# Startup script installs the channel package (if set) then runs the entrypoint
COPY core/channel/start.sh /app/start.sh
RUN chmod +x /app/start.sh

RUN chown -R bun:bun /app

ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -sf "http://localhost:${PORT}/health" || exit 1

USER bun
CMD ["/app/start.sh"]
