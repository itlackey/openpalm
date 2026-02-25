FROM oven/bun:1.3.5
WORKDIR /app
# Bun workspace symlinks are not available inside Docker builds, so we copy the
# raw TypeScript source of @openpalm/lib directly into node_modules.
# See packages/lib/README.md "Docker Build" for details.
COPY packages/lib /app/node_modules/@openpalm/lib
COPY channels/discord/package.json ./
COPY channels/discord/server.ts ./server.ts
COPY channels/discord/types.ts ./types.ts
COPY channels/discord/permissions.ts ./permissions.ts
COPY channels/discord/discord-api.ts ./discord-api.ts
COPY channels/discord/commands.ts ./commands.ts
COPY channels/discord/interactions.ts ./interactions.ts
RUN bun install --production
CMD ["bun", "run", "server.ts"]
