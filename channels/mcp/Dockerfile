FROM oven/bun:1.3.5
WORKDIR /app
# Bun workspace symlinks are not available inside Docker builds, so we copy the
# raw TypeScript source of @openpalm/lib directly into node_modules.
# See packages/lib/README.md "Docker Build" for details.
COPY packages/lib /app/node_modules/@openpalm/lib
COPY channels/mcp/package.json ./
COPY channels/mcp/channel.ts ./channel.ts
COPY channels/mcp/server.ts ./server.ts
RUN bun install --production
CMD ["bun", "run", "server.ts"]
