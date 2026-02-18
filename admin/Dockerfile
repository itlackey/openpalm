FROM oven/bun:1.1.42
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY ui ./ui
RUN bun install --production
EXPOSE 8100
CMD ["bun", "run", "src/server.ts"]
