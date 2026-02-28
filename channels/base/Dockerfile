FROM oven/bun:1-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Bun workspace symlinks are not available inside Docker builds, so we copy the
# raw TypeScript source of @openpalm/lib directly into node_modules.
# See packages/lib/README.md "Docker Build" for details.
COPY packages/lib /app/node_modules/@openpalm/lib
RUN cd /app/node_modules/@openpalm/lib && bun install --production

COPY channels/base/package.json ./

ENV PORT=8080
ENV CHANNEL_FILE=/app/channel.ts
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:8080/health || exit 1

USER bun
CMD ["bun", "run", "node_modules/@openpalm/lib/src/shared/channel-entrypoint.ts"]
