FROM oven/bun:1.3.5
RUN apt-get update \
  && apt-get install -y cron curl ca-certificates gnupg \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
  && chmod a+r /etc/apt/keyrings/docker.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y docker-ce-cli \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY packages/lib /app/node_modules/@openpalm/lib
COPY admin/package.json ./
COPY admin/src ./src
COPY admin/ui ./ui
RUN bun install --production
EXPOSE 8100
COPY admin/entrypoint.sh /usr/local/bin/admin-entrypoint.sh
RUN chmod +x /usr/local/bin/admin-entrypoint.sh
CMD ["/usr/local/bin/admin-entrypoint.sh"]
