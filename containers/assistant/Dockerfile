FROM node:24.21.0-bookworm-slim AS node-runtime

FROM oven/bun:1.4.2 AS tools
ARG TARGETARCH
WORKDIR /repo
COPY package.json bun.lock ./
COPY packages/lib/package.json ./packages/lib/package.json
COPY packages/skeleton/package.json ./packages/skeleton/package.json
COPY packages/guardian/package.json ./packages/guardian/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/portal/package.json ./packages/portal/package.json
COPY packages/electron/package.json ./packages/electron/package.json
COPY packages/claude-desktop/package.json ./packages/claude-desktop/package.json
COPY containers/assistant/tools/package.json ./containers/assistant/tools/package.json
COPY containers/guardian/tools/package.json ./containers/guardian/tools/package.json
RUN bun install --frozen-lockfile --production --linker hoisted --filter @openpalm/assistant-tools \
    && rm -rf node_modules/opencode-linux-x64-musl \
              node_modules/opencode-linux-x64-baseline \
              node_modules/opencode-linux-x64-baseline-musl \
              node_modules/opencode-linux-arm64-musl \
              node_modules/onnxruntime-node/bin/napi-v6/darwin \
              node_modules/onnxruntime-node/bin/napi-v6/win32 \
    && case "${TARGETARCH}" in \
      amd64) rm -rf node_modules/onnxruntime-node/bin/napi-v6/linux/arm64 \
                    node_modules/@img/sharp-libvips-linux-arm64 \
                    node_modules/@img/sharp-libvips-linuxmusl-arm64 \
                    node_modules/@img/sharp-linux-arm64 \
                    node_modules/@img/sharp-linuxmusl-arm64 \
                    node_modules/@img/sharp-libvips-linuxmusl-x64 \
                    node_modules/@img/sharp-linuxmusl-x64 ;; \
      arm64) rm -rf node_modules/onnxruntime-node/bin/napi-v6/linux/x64 \
                    node_modules/@img/sharp-libvips-linux-x64 \
                    node_modules/@img/sharp-libvips-linuxmusl-x64 \
                    node_modules/@img/sharp-linux-x64 \
                    node_modules/@img/sharp-linuxmusl-x64 \
                    node_modules/@img/sharp-libvips-linuxmusl-arm64 \
                    node_modules/@img/sharp-linuxmusl-arm64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac

# Both native harnesses install the same immutable upstream marketplace.
ADD --checksum=sha256:de389f4b000993fbfceb1df2666553793576723fd003321038afbdf965bc8667 \
    https://codeload.github.com/itlackey/akm-plugins/tar.gz/5e4bbd8c8520f70c869ca1d15428b843c9dd93c7 /tmp/akm-claude.tar.gz
RUN mkdir -p /akm-marketplace/claude \
    && plugin_root=akm-plugins-5e4bbd8c8520f70c869ca1d15428b843c9dd93c7/claude \
    && tar -xzf /tmp/akm-claude.tar.gz -C /akm-marketplace/claude --strip-components=2 \
      "$plugin_root/.claude-plugin" "$plugin_root/.codex-plugin" "$plugin_root/commands" "$plugin_root/hooks" \
      "$plugin_root/shared" "$plugin_root/skills" "$plugin_root/package.json" "$plugin_root/README.md" \
    && tar -xzf /tmp/akm-claude.tar.gz -C /akm-marketplace --strip-components=1 \
      akm-plugins-5e4bbd8c8520f70c869ca1d15428b843c9dd93c7/.agents/plugins/marketplace.json \
      akm-plugins-5e4bbd8c8520f70c869ca1d15428b843c9dd93c7/.claude-plugin/marketplace.json \
      akm-plugins-5e4bbd8c8520f70c869ca1d15428b843c9dd93c7/LICENSE
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
ENV PATH="/repo/node_modules/.bin:${PATH}"
RUN mkdir -p /native-defaults/codex \
    && CLAUDE_CONFIG_DIR=/native-defaults/claude claude plugin marketplace add /akm-marketplace \
    && CLAUDE_CONFIG_DIR=/native-defaults/claude claude plugin install akm@akm-plugins \
    && CODEX_HOME=/native-defaults/codex codex plugin marketplace add /akm-marketplace \
    && CODEX_HOME=/native-defaults/codex codex plugin add akm@akm-plugins \
    && chmod a+r /native-defaults/codex/config.toml

FROM oven/bun:1.4.2-slim

ARG TARGETARCH
ARG SUPERCRONIC_VERSION=v0.2.49

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git libnss-wrapper tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && case "${TARGETARCH}" in \
      amd64) supercronic_sha=a53ae236602c7338aba3fbaff40bda6300eae3b9fedb8261eb06cfe3724430c1 ;; \
      arm64) supercronic_sha=02aa0cb229ba09050cba6638059dadb9eedc2276632ea43d6a57a2f8c1629dd5 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL --retry 5 --retry-all-errors \
      -o /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH}" \
    && echo "${supercronic_sha}  /usr/local/bin/supercronic" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/supercronic

COPY --from=tools /repo/node_modules /opt/openpalm/tools/node_modules
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY containers/assistant/tools/package.json /opt/openpalm/tools/package.json
COPY containers/assistant/entrypoint.sh /usr/local/bin/openpalm-assistant
COPY containers/assistant/healthcheck.sh /usr/local/bin/openpalm-healthcheck
COPY containers/assistant/opencode-run.sh /usr/local/bin/openpalm-opencode-run
COPY containers/assistant/openpalm-task.mjs /usr/local/bin/openpalm-task
COPY containers/assistant/openpalm-remote.mjs /usr/local/bin/openpalm-remote
COPY containers/assistant/openpalm-remote-setup.mjs /usr/local/bin/openpalm-remote-setup
COPY --from=tools /akm-marketplace /akm-marketplace
COPY --from=tools /native-defaults /native-defaults
COPY containers/assistant/codex.config.toml /etc/codex/config.toml

ARG PLATFORM_VERSION
ENV PLATFORM_VERSION=${PLATFORM_VERSION}

RUN test -n "$PLATFORM_VERSION" \
    && chmod 0755 /usr/local/bin/openpalm-assistant /usr/local/bin/openpalm-task /usr/local/bin/openpalm-remote /usr/local/bin/openpalm-remote-setup /usr/local/bin/openpalm-healthcheck /usr/local/bin/openpalm-opencode-run \
    && ln -s openpalm-remote /usr/local/bin/openpalm-remote.mjs \
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
    AKM_AUTO_MEMORY=0 \
    AKM_AUTO_LEARNING=0 \
    AKM_REDACT_HIGH_ENTROPY=1 \
    AKM_REDACT_PII=1 \
    OPENPALM_AUTOMATIC_MEMORY=1 \
    DISABLE_AUTOUPDATER=1 \
    BUN_OPTIONS=--no-env-file \
    TZ=UTC \
    PATH="/opt/openpalm/tools/node_modules/.bin:/home/opencode/.local/bin:/usr/local/bin:/usr/bin:/bin"

WORKDIR /work
EXPOSE 4096
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD openpalm-healthcheck

ENTRYPOINT ["/usr/local/bin/openpalm-assistant"]
USER bun
