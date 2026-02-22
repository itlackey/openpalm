FROM oven/bun:1.3.5
RUN apt-get update \
  && apt-get install -y cron curl ca-certificates gnupg gosu \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
  && chmod a+r /etc/apt/keyrings/docker.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y docker-ce-cli \
  && rm -rf /var/lib/apt/lists/*

# Create non-root user for runtime (UID/GID match compose OPENPALM_UID/GID defaults).
# The oven/bun base image ships a "bun" user at 1000:1000 — rename it to openpalm
# so the user name is consistent across all OpenPalm containers.
RUN groupmod -n openpalm bun && \
    usermod -l openpalm -d /home/openpalm -m bun

WORKDIR /app
COPY packages/lib /app/node_modules/@openpalm/lib
COPY packages/ui ./packages/ui
RUN cd /app/packages/ui && bun install --production && bun run build
RUN chown -R openpalm:openpalm /app
EXPOSE 8100
COPY admin/entrypoint.sh /usr/local/bin/admin-entrypoint.sh
RUN chmod +x /usr/local/bin/admin-entrypoint.sh
CMD ["/usr/local/bin/admin-entrypoint.sh"]
