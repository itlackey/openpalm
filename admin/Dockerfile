FROM oven/bun:1.1.42
RUN apt-get update && apt-get install -y cron && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY ui ./ui
RUN bun install --production
EXPOSE 8100
COPY entrypoint.sh /usr/local/bin/admin-entrypoint.sh
RUN chmod +x /usr/local/bin/admin-entrypoint.sh
CMD ["/usr/local/bin/admin-entrypoint.sh"]
