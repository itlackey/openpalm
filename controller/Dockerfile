FROM oven/bun:1.1.42
WORKDIR /app
COPY package.json tsconfig.json ./
COPY server.ts ./server.ts
COPY entrypoint.sh ./entrypoint.sh
COPY maintenance.sh ./maintenance.sh
RUN bun install --production
RUN apt-get update && apt-get install -y cron curl jq gzip && rm -rf /var/lib/apt/lists/* \
  && chmod +x /app/entrypoint.sh /app/maintenance.sh
CMD ["/app/entrypoint.sh"]
