FROM oven/bun:1.3-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl bash ca-certificates gosu && rm -rf /var/lib/apt/lists/*

COPY containers/guardian/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV HOME=/opt/openpalm/guardian \
    PORT=8080 \
    OPENCODE_CONFIG_DIR=/etc/opencode

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -sf http://localhost:8080/health/ready || exit 1

# Container starts as root so the entrypoint can chown /opt/openpalm and then
# drop to OP_UID:OP_GID via gosu before starting the server.
USER root

CMD ["/entrypoint.sh"]
