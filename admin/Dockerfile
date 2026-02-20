FROM oven/bun:1.1.42 AS ui-builder
WORKDIR /build
COPY ui/package.json ui/bun.lockb* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install
COPY ui/ ./
RUN bun run build

FROM oven/bun:1.1.42
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN bun install --production
COPY --from=ui-builder /build/build ./ui/build
EXPOSE 8100
CMD ["bun", "run", "src/server.ts"]
