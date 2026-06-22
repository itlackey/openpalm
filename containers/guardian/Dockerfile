FROM oven/bun:1.3-slim

# nodejs provides npm, required for opencode-ai's postinstall (binary download).
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl bash ca-certificates gosu nodejs && rm -rf /var/lib/apt/lists/*

COPY containers/guardian/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Baked at build time so the thin host boots with no operator configuration.
# Operators may override at runtime with OP_GUARDIAN_NPM_VERSION.
ARG GUARDIAN_VERSION
ENV GUARDIAN_VERSION=${GUARDIAN_VERSION}

ENV HOME=/opt/openpalm/guardian \
    PORT=8080 \
    OPENCODE_CONFIG_DIR=/etc/opencode \
    PATH="/opt/openpalm/tools/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Bake default tool packages at /opt/openpalm/tools. In compose,
# OP_HOME/data/guardian/tools is bind-mounted over this path so operators
# can edit package.json directly.
COPY containers/guardian/tools/package.json /opt/openpalm/tools/package.json
RUN npm install --prefix /opt/openpalm/tools --omit=dev --no-fund --no-audit \
    && chmod -R a+rX /opt/openpalm/tools/node_modules

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -sf http://localhost:8080/health/ready || exit 1

# Container starts as root so the entrypoint can chown /opt/openpalm and then
# drop to OP_UID:OP_GID via gosu before starting the server.
USER root

CMD ["/entrypoint.sh"]
