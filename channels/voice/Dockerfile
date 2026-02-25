FROM oven/bun:1.3.9
WORKDIR /app
# Bun workspace symlinks are not available inside Docker builds, so we copy the
# raw TypeScript source of @openpalm/lib directly into node_modules.
# See packages/lib/README.md "Docker Build" for details.
COPY packages/lib /app/node_modules/@openpalm/lib
COPY channels/voice/package.json ./
COPY channels/voice/server.ts ./server.ts
RUN bun install --production
CMD ["bun", "run", "server.ts"]
