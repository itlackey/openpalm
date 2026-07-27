# ── Portal Runner ─────────────────────────────────────────────────────────────
# Thin host container for portal adapters. Adapters are exact-pinned and
# installed from npm at BUILD time only (containers/portal/tools/package.json)
# — no bind mount overlays /opt/openpalm/tools and there is no boot-time
# install or update (image-baked-only model, docs/public-seams-review.md
# §E2/§S2). Bump the manifest and rebuild the image to change a version.
# ──────────────────────────────────────────────────────────────────────────────

FROM oven/bun:1.3-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Bake portal adapter packages at /opt/openpalm/tools using the standard
# cross-container pattern. Adapters are published npm packages; no source copy needed.
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
