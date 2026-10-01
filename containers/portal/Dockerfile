FROM oven/bun:1.4.2-slim
WORKDIR /app

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
COPY packages/lib/package.json ./packages/lib/package.json
COPY packages/skeleton/package.json ./packages/skeleton/package.json
COPY packages/guardian/package.json ./packages/guardian/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/portal/package.json ./packages/portal/package.json
COPY packages/electron/package.json ./packages/electron/package.json
COPY packages/claude-desktop/package.json ./packages/claude-desktop/package.json
COPY containers/assistant/tools/package.json ./containers/assistant/tools/package.json
COPY containers/guardian/tools/package.json ./containers/guardian/tools/package.json
RUN bun install --frozen-lockfile --production --ignore-scripts --linker hoisted --filter @openpalm/portal
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
