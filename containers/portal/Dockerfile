FROM oven/bun:1.3.14-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

COPY packages/portal/package.json ./package.json
RUN bun install --production --ignore-scripts
COPY packages/portal/src ./src

RUN mkdir -p /home/bun /var/lib/openpalm \
    && chown -R bun:bun /app /home/bun /var/lib/openpalm

ENV HOME=/home/bun
ENV PORT=8080

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -sf "http://127.0.0.1:${PORT}/health" || exit 1

USER bun
CMD ["bun", "run", "src/index.ts"]
