FROM oven/bun:1.3.14-slim

ENV HOME=/opt/openpalm/guardian \
    PORT=8080 \
    OPENCODE_CONFIG_DIR=/opt/openpalm/moderator-config \
    OPENCODE_DISABLE_PROJECT_CONFIG=true \
    OPENCODE_DISABLE_CLAUDE_CODE=true \
    OPENCODE_DISABLE_EXTERNAL_SKILLS=true \
    OPENCODE_DISABLE_EMBEDDED_WEB_UI=true \
    PATH="/opt/openpalm/tools/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY containers/guardian/tools/package.json /opt/openpalm/tools/package.json
RUN bun install --cwd /opt/openpalm/tools --production \
    && rm -rf /opt/openpalm/tools/node_modules/opencode-linux-x64-musl \
              /opt/openpalm/tools/node_modules/opencode-linux-x64-baseline \
              /opt/openpalm/tools/node_modules/opencode-linux-x64-baseline-musl \
              /opt/openpalm/tools/node_modules/opencode-linux-arm64-musl \
              /opt/openpalm/guardian/.bun

ARG GUARDIAN_VERSION
ENV GUARDIAN_VERSION=${GUARDIAN_VERSION}

WORKDIR /opt/openpalm/guardian-app
COPY packages/guardian/package.json ./package.json
RUN bun install --production --ignore-scripts \
    && rm -rf /opt/openpalm/guardian/.bun
COPY packages/guardian/src/assistant-client.ts \
     packages/guardian/src/conversation.ts \
     packages/guardian/src/credentials.ts \
     packages/guardian/src/crypto.ts \
     packages/guardian/src/gateway-service.ts \
     packages/guardian/src/http-util.ts \
     packages/guardian/src/lean-audit.ts \
     packages/guardian/src/lean-content-screen.ts \
     packages/guardian/src/lean-index.ts \
     packages/guardian/src/lean-moderation.ts \
     packages/guardian/src/lean-server.ts \
     packages/guardian/src/logger.ts \
     packages/guardian/src/mcp-agent.ts \
     packages/guardian/src/oauth.ts \
     packages/guardian/src/rate-limit.ts \
     packages/guardian/src/workspace-access.ts \
     packages/guardian/src/workspace-policy.ts \
     ./src/
COPY containers/guardian/entrypoint.lean.sh /usr/local/bin/openpalm-guardian

RUN test -n "$GUARDIAN_VERSION" \
    && chmod 0755 /usr/local/bin/openpalm-guardian \
    && mkdir -p /opt/openpalm/guardian/.config/opencode \
                /opt/openpalm/guardian/.local/share/opencode \
                /opt/openpalm/logs \
    && chmod -R a+rwX /opt/openpalm/guardian /opt/openpalm/logs

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -sf http://127.0.0.1:8080/health || exit 1

USER bun
ENTRYPOINT ["/usr/local/bin/openpalm-guardian"]
