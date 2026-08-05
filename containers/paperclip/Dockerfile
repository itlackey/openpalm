# syntax=docker/dockerfile:1.20
FROM node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46

ARG PAPERCLIP_VERSION=2026.722.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && npm install --global --omit=dev "paperclipai@${PAPERCLIP_VERSION}" \
    && node --input-type=module --eval \
      "import('/usr/local/lib/node_modules/paperclipai/node_modules/@paperclipai/db/dist/embedded-postgres-native.js').then(({ prepareEmbeddedPostgresNativeRuntime }) => prepareEmbeddedPostgresNativeRuntime())" \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /paperclip \
    && chown node:node /paperclip

ENV HOME=/paperclip \
    HOST=0.0.0.0 \
    PORT=3100 \
    SERVE_UI=true \
    PAPERCLIP_HOME=/paperclip \
    PAPERCLIP_INSTANCE_ID=default \
    PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
    PAPERCLIP_DEPLOYMENT_MODE=authenticated \
    PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
    PAPERCLIP_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1

EXPOSE 3100
USER node
CMD ["node", "/usr/local/lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist/index.js"]
