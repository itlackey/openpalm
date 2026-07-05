FROM oven/bun:1.3-slim

# nodejs provides npm, required for opencode-ai's postinstall (binary download).
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl bash ca-certificates nodejs && rm -rf /var/lib/apt/lists/*

COPY containers/guardian/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Baked at build time so the thin host boots with NO operator configuration
# AND no network access: the trust boundary's own code (@openpalm/guardian
# and its co-released @openpalm/skeleton) is installed into the image layers
# right here, not fetched by entrypoint.sh on first boot. entrypoint.sh's
# install_artifact() already-at-version check then makes that boot-time step
# a no-op in the default case; it remains the explicit-override path for
# downstream distributions that set OP_GUARDIAN_NPM_VERSION / OP_GUARDIAN_PACKAGE
# to a different package/version (see containers/guardian/README.md).
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
# Make the app trees world-writable so a container entered with
# `--user ${OP_UID}:${OP_GID}` can populate them on first boot. The container
# runs as the host operator's ARBITRARY uid:gid (not 1000), and Docker seeds a
# fresh `guardian-cache` named volume from this image path WITH its ownership —
# so neither the owner nor a fixed group (the g=u "arbitrary uid" convention
# needs gid 0, which OpenPalm does not use) is guaranteed to match the runtime
# ids. World-writable is the only image-side mode that works for an arbitrary
# uid. This applies ONLY to these app/cache trees; the secret tree
# (knowledge/secrets, 0600) is a bind mount and is never touched here.
RUN test -n "$GUARDIAN_VERSION" \
    && mkdir -p /opt/openpalm/guardian/.local/share/opencode /opt/openpalm/guardian/.local/state/opencode /opt/openpalm/skeleton \
    && (cd /opt/openpalm/guardian && bun add "@openpalm/guardian@${GUARDIAN_VERSION}" --production) \
    && (cd /opt/openpalm/skeleton && bun add "@openpalm/skeleton@${GUARDIAN_VERSION}" --production) \
    && bun install --cwd /opt/openpalm/tools --production \
    && chmod -R a+rwX /opt/openpalm/guardian /opt/openpalm/skeleton /opt/openpalm/tools

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -sf http://localhost:8080/health/ready || exit 1

USER bun

CMD ["/entrypoint.sh"]
