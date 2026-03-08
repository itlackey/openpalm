# OpenPalm Memory API — Bun.js wrapper around @openpalm/memory
#
# Build context must be the repo root (context: .) so compose.dev.yaml paths work.

FROM oven/bun:1-alpine

LABEL org.opencontainers.image.name="openpalm/memory"

RUN addgroup -g 1000 memory && adduser -u 1000 -G memory -h /home/memory -D memory

WORKDIR /app

# Copy workspace package sources first for better layer caching
COPY packages/memory/package.json packages/memory/
COPY packages/memory/src/ packages/memory/src/
COPY packages/memory/tsconfig.json packages/memory/

# Copy server package
COPY core/memory/package.json .
COPY core/memory/src/ src/

# Install dependencies
RUN bun install

RUN chown -R memory:memory /app

USER memory

EXPOSE 8765
CMD ["bun", "run", "src/server.ts"]
