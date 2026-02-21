FROM oven/bun:1.1.42
WORKDIR /app
COPY packages/lib /app/node_modules/@openpalm/lib
COPY channels/chat/package.json ./
COPY channels/chat/server.ts ./server.ts
RUN bun install --production
CMD ["bun", "run", "server.ts"]
