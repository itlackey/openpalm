FROM oven/bun:1.3.14 AS dependencies

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
RUN bun install --frozen-lockfile --production --linker hoisted \
        --filter @openpalm/guardian --filter @openpalm/guardian-tools \
    && rm -rf node_modules/opencode-linux-x64-musl \
              node_modules/opencode-linux-x64-baseline \
              node_modules/opencode-linux-x64-baseline-musl \
              node_modules/opencode-linux-arm64-musl

FROM oven/bun:1.3.14-slim

ENV HOME=/opt/openpalm/guardian \
    PORT=8080 \
    OPENCODE_CONFIG_DIR=/opt/openpalm/moderator-config \
    OPENCODE_DISABLE_PROJECT_CONFIG=true \
    OPENCODE_DISABLE_CLAUDE_CODE=true \
    OPENCODE_DISABLE_EXTERNAL_SKILLS=true \
    OPENCODE_DISABLE_EMBEDDED_WEB_UI=true \
    PATH="/opt/openpalm/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends bash ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=dependencies /repo/node_modules /opt/openpalm/node_modules

ARG GUARDIAN_VERSION
ENV GUARDIAN_VERSION=${GUARDIAN_VERSION}

WORKDIR /opt/openpalm/guardian-app
COPY packages/guardian/package.json ./package.json
COPY packages/guardian/src/assistant-client.ts \
     packages/guardian/src/conversation.ts \
     packages/guardian/src/credentials.ts \
     packages/guardian/src/crypto.ts \
     packages/guardian/src/gateway-service.ts \
     packages/guardian/src/http-util.ts \
     packages/guardian/src/audit.ts \
     packages/guardian/src/content-screen.ts \
     packages/guardian/src/moderation.ts \
     packages/guardian/src/server.ts \
     packages/guardian/src/logger.ts \
     packages/guardian/src/mcp-agent.ts \
     packages/guardian/src/oauth.ts \
     packages/guardian/src/rate-limit.ts \
     packages/guardian/src/workspace-access.ts \
     packages/guardian/src/workspace-policy.ts \
     ./src/
COPY containers/guardian/entrypoint.sh /usr/local/bin/openpalm-guardian

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
