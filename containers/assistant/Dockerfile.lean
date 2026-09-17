FROM oven/bun:1.3.14 AS tools
WORKDIR /opt/openpalm/tools
COPY containers/assistant/tools/package.json ./package.json
RUN bun install --production \
    && rm -rf node_modules/opencode-linux-x64-musl \
              node_modules/opencode-linux-x64-baseline \
              node_modules/opencode-linux-x64-baseline-musl \
              node_modules/opencode-linux-arm64-musl

FROM oven/bun:1.3.14-slim

ARG TARGETARCH
ARG SUPERCRONIC_VERSION=v0.2.48

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git libnss-wrapper \
    && rm -rf /var/lib/apt/lists/* \
    && case "${TARGETARCH}" in \
      amd64) supercronic_sha=88c1b66b94c486f972fdd1a4d1f901e3e75ff04f749cddd60c5db573e3a33c6c ;; \
      arm64) supercronic_sha=50ae8755e04fa72812d0a1bc47a112a856811cc91cce7b6c875c378a850788bc ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL --retry 5 --retry-all-errors \
      -o /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH}" \
    && echo "${supercronic_sha}  /usr/local/bin/supercronic" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/supercronic

COPY --from=tools /opt/openpalm/tools /opt/openpalm/tools
COPY containers/assistant/entrypoint.lean.sh /usr/local/bin/openpalm-assistant

ARG PLATFORM_VERSION
ENV PLATFORM_VERSION=${PLATFORM_VERSION}

RUN test -n "$PLATFORM_VERSION" \
    && chmod 0755 /usr/local/bin/openpalm-assistant \
    && mkdir -p /home/opencode /etc/opencode /opt/akm/cache /opt/akm/data/state /stash /work \
    && chown -R bun:bun /home/opencode /etc/opencode /opt/akm /stash /work \
    && chmod -R a+rwX /home/opencode /etc/opencode /opt/akm /stash /work

ENV HOME=/home/opencode \
    OPENCODE_CONFIG_DIR=/etc/opencode \
    OPENCODE_DISABLE_PROJECT_CONFIG=true \
    OPENCODE_DISABLE_CLAUDE_CODE=true \
    OPENCODE_DISABLE_EXTERNAL_SKILLS=true \
    OPENCODE_DISABLE_EMBEDDED_WEB_UI=true \
    OPENCODE_PORT=4096 \
    AKM_BUNDLE_DIR=/stash \
    AKM_CONFIG_DIR=/etc/akm \
    AKM_CACHE_DIR=/opt/akm/cache \
    AKM_DATA_DIR=/opt/akm/data \
    AKM_STATE_DIR=/opt/akm/data/state \
    PATH="/opt/openpalm/tools/node_modules/.bin:/home/opencode/.local/bin:/usr/local/bun-node-fallback-bin:/usr/local/bin:/usr/bin:/bin"

WORKDIR /work
EXPOSE 4096
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD bash -c 'test -s "${OPENCODE_SERVER_PASSWORD_FILE:-/run/secrets/opencode_server_password}" && curl -sf -u "opencode:$(tr -d "\r\n" <"${OPENCODE_SERVER_PASSWORD_FILE:-/run/secrets/opencode_server_password}")" http://127.0.0.1:${OPENCODE_PORT:-4096}/config >/dev/null' || exit 1

ENTRYPOINT ["/usr/local/bin/openpalm-assistant"]
USER bun
