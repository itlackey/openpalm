# ── Channel Runner — Unified container for baked OpenPalm channels ────────────
#
# Runs the first-party channel adapters copied from the workspace at build time.
# Set CHANNEL_PACKAGE to the baked package name at runtime.
# ──────────────────────────────────────────────────────────────────────────────

FROM oven/bun:1.3-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Build against a minimal workspace root so the baked portals resolve as local workspaces.
RUN mkdir -p /app/packages/discord-portal /app/packages/slack-portal
COPY packages/discord-portal/package.json /app/packages/discord-portal/package.json
COPY packages/slack-portal/package.json /app/packages/slack-portal/package.json
RUN printf '%s\n' '{' '  "name": "openpalm-channel-image",' '  "private": true,' '  "workspaces": [' '    "packages/discord-portal",' '    "packages/slack-portal"' '  ]' '}' > /app/package.json

# Bake the first-party portal adapters into the image from the workspace.
COPY packages/discord-portal /app/packages/discord-portal
COPY packages/slack-portal /app/packages/slack-portal
COPY core/portal/portal-entrypoint.ts /app/portal-entrypoint.ts

RUN bun install --production

# Startup script validates PORTAL_PACKAGE then runs the entrypoint.
COPY core/portal/start.sh /app/start.sh
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
