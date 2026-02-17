FROM oven/bun:1.1.42
WORKDIR /app
COPY package.json tsconfig.json ./
COPY server.ts ./server.ts
RUN bun install --production
CMD ["bun", "run", "server.ts"]
