# ── Portal Runner ─────────────────────────────────────────────────────────────
# Thin host container for portal adapters. Candidate SDK and adapter source is
# copied and packed locally; only their external dependencies are resolved.
# ──────────────────────────────────────────────────────────────────────────────

FROM oven/bun:1.3-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Bake the exact candidate SDK and adapter code. This is shared by live builds
# and coordinated dry runs, before any standalone npm publication is needed.
COPY containers/portal/workspace.package.json /opt/openpalm/local-src/package.json
COPY packages/portal-sdk /opt/openpalm/local-src/packages/portal-sdk
COPY packages/portal-discord /opt/openpalm/local-src/packages/portal-discord
COPY packages/portal-slack /opt/openpalm/local-src/packages/portal-slack
RUN mkdir -p /opt/openpalm/local-artifacts /opt/openpalm/tools \
    && (cd /opt/openpalm/local-src && bun install --lockfile-only --ignore-scripts) \
    && (cd /opt/openpalm/local-src/packages/portal-sdk && bun pm pack --destination /opt/openpalm/local-artifacts --quiet) \
    && (cd /opt/openpalm/local-src/packages/portal-discord && bun pm pack --destination /opt/openpalm/local-artifacts --quiet) \
    && (cd /opt/openpalm/local-src/packages/portal-slack && bun pm pack --destination /opt/openpalm/local-artifacts --quiet) \
    && (cd /opt/openpalm/tools && bun add /opt/openpalm/local-artifacts/*.tgz --production) \
    && rm -rf /opt/openpalm/local-src /opt/openpalm/local-artifacts

COPY containers/portal/portal-entrypoint.ts /app/portal-entrypoint.ts
COPY containers/portal/start.sh /app/start.sh
RUN chmod +x /app/start.sh

RUN mkdir -p /home/bun \
    && chown -R bun:bun /app /home/bun /opt/openpalm/tools

ENV HOME=/home/bun
ENV PORT=8080
ENV PATH="/opt/openpalm/tools/node_modules/.bin:$PATH"

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -sf "http://localhost:${PORT}/health" || exit 1

USER bun
CMD ["/app/start.sh"]
