# ── Channel Runner — Unified container for baked OpenPalm channels ────────────
#
# Runs the first-party channel adapters copied from the workspace at build time.
# Set CHANNEL_PACKAGE to the baked package name at runtime.
# ──────────────────────────────────────────────────────────────────────────────

FROM oven/bun:1.3-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Build against a minimal workspace root so the baked portals resolve as local workspaces.
RUN mkdir -p /app/portals/discord /app/portals/slack
COPY portals/discord/package.json /app/portals/discord/package.json
COPY portals/slack/package.json /app/portals/slack/package.json
RUN printf '%s\n' '{' '  "name": "openpalm-portal-image",' '  "private": true,' '  "workspaces": [' '    "portals/discord",' '    "portals/slack"' '  ]' '}' > /app/package.json

# Bake the first-party portal adapters into the image from the workspace.
COPY portals/discord /app/portals/discord
COPY portals/slack /app/portals/slack
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
