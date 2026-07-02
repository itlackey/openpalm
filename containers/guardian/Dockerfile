FROM oven/bun:1.3-slim

# nodejs provides npm, required for opencode-ai's postinstall (binary download).
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl bash ca-certificates nodejs && rm -rf /var/lib/apt/lists/*

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
RUN bun install --cwd /opt/openpalm/tools --production \
    && mkdir -p /opt/openpalm/guardian/.local/share/opencode /opt/openpalm/guardian/.local/state/opencode /opt/openpalm/skeleton \
    && chmod -R a+rwX /opt/openpalm/guardian /opt/openpalm/skeleton /opt/openpalm/tools

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -sf http://localhost:8080/health/ready || exit 1

USER bun

CMD ["/entrypoint.sh"]
