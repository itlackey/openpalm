# ── Portal Runner — Unified container for baked OpenPalm portals ─────────────
#
# Runs the first-party portal adapters copied from the workspace at build time.
# Set PORTAL_PACKAGE to the baked package name at runtime.
# ──────────────────────────────────────────────────────────────────────────────

FROM oven/bun:1.3-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Bake each first-party portal adapter and install its own dependencies in place
# (deps installed AFTER the COPY, into the package's own node_modules — no
# workspace, no symlinked package, no generated manifest). The entrypoint imports
# the selected adapter by path, so each one is fully self-contained.
COPY portals/discord /app/portals/discord
RUN cd /app/portals/discord && bun install --production

COPY portals/slack /app/portals/slack
RUN cd /app/portals/slack && bun install --production

COPY containers/portal/portal-entrypoint.ts /app/portal-entrypoint.ts

# Startup script validates PORTAL_PACKAGE then runs the entrypoint.
COPY containers/portal/start.sh /app/start.sh
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
