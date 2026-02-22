FROM oven/bun:1.3.5
WORKDIR /app
COPY packages/lib /app/node_modules/@openpalm/lib
COPY channels/voice/package.json ./
COPY channels/voice/server.ts ./server.ts
RUN bun install --production
CMD ["bun", "run", "server.ts"]
