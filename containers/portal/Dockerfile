# ── Portal Runner ─────────────────────────────────────────────────────────────
# Runs first-party portal adapters. Tools live at /opt/openpalm/tools following
# the standard cross-container pattern; adapters are referenced via file: paths
# in tools/package.json and will migrate to versioned npm packages when published.
# ──────────────────────────────────────────────────────────────────────────────

FROM oven/bun:1.3-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Bake portal adapter source. The file: references in tools/package.json link
# these into /opt/openpalm/tools/node_modules/ so they can be imported by
# package name (e.g. @openpalm/discord-portal). When adapters are published to
# npm the COPY lines below are removed and the file: refs become version ranges.
COPY portals/discord /app/portals/discord
RUN cd /app/portals/discord && bun install --production

COPY portals/slack /app/portals/slack
RUN cd /app/portals/slack && bun install --production

# Standard tools layer — file: links adapter source into node_modules/.
COPY containers/portal/tools/package.json /opt/openpalm/tools/package.json
RUN bun install --cwd /opt/openpalm/tools --production

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
