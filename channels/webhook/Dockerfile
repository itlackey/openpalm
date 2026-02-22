FROM oven/bun:1.3.5
WORKDIR /app
COPY package.json tsconfig.json ./
COPY server.ts ./server.ts
RUN bun install --production
CMD ["bun", "run", "server.ts"]
