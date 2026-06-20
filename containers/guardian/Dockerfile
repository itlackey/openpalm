FROM oven/bun:1.3-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl bash ca-certificates && rm -rf /var/lib/apt/lists/*

VOLUME ["/opt/openpalm"]

COPY containers/guardian/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV HOME=/opt/openpalm/guardian \
    PORT=8080 \
    OPENCODE_CONFIG_DIR=/etc/opencode

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -sf http://localhost:8080/health/ready || exit 1

CMD ["/entrypoint.sh"]
