# ── Guardian Service ───────────────────────────────────────────────────────────
# Bun-based message guardian. Receives signed channel messages, validates
# HMAC + nonce + rate limits, forwards to the assistant. Ships the OpenCode
# binary so guardian-side OpenCode instances share provider config with the
# assistant (auth.json) and read their global config from /etc/opencode.
# ──────────────────────────────────────────────────────────────────────────────

FROM oven/bun:1.3-slim

# curl + unzip + bash + ca-certificates are required by the OpenCode installer.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip bash ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# OpenCode binary. Mirrors the assistant image: install with HOME=/usr/local so
# the binary lands at /usr/local/.opencode/bin and is reachable from any user.
# Keep OPENCODE_VERSION in lockstep with core/assistant/Dockerfile.
ARG OPENCODE_VERSION=1.3.3
ENV OPENCODE_VERSION=${OPENCODE_VERSION}
RUN HOME=/usr/local curl -fsSL https://opencode.ai/install \
        | HOME=/usr/local bash -s -- --no-modify-path --version "$OPENCODE_VERSION"
ENV PATH="/usr/local/.opencode/bin:$PATH"

# OpenCode reads its operator-managed global config from /etc/opencode, which
# is bind-mounted from OP_HOME/config/guardian (see channels.compose.yml).
ENV OPENCODE_CONFIG_DIR=/etc/opencode

# Install akm-cli for shared stash, vault, and skill management.
# Pinned via build arg so the install step is reproducible. Install globally
# into /usr/local so the unprivileged bun user (set with USER below) can
# execute it without writing to its own $HOME.
ARG AKM_CLI_VERSION=0.8.0-rc2
RUN BUN_INSTALL=/usr/local bun add -g "akm-cli@${AKM_CLI_VERSION}" \
    && chmod -R a+rX /usr/local/install/global \
    && chmod 755 /usr/local/bin/akm \
    && akm --version

WORKDIR /app
# Bun workspace symlinks are not available inside Docker builds, so we copy the
# raw TypeScript source of @openpalm/channels-sdk directly into node_modules.
COPY packages/channels-sdk /app/node_modules/@openpalm/channels-sdk
COPY core/guardian/ .
# Install channels-sdk's own declared dependencies so transitive imports
# from sdk source resolve correctly at runtime.
RUN cd /app/node_modules/@openpalm/channels-sdk && bun install --production
# Strip workspace:* dep (pre-installed via COPY above) and remove the workspace
# lockfile so bun install resolves remaining deps without CI frozen-lockfile enforcement.
RUN bun -e "import {readFileSync,writeFileSync} from 'node:fs';const p=JSON.parse(readFileSync('package.json','utf8'));delete p.dependencies['@openpalm/channels-sdk'];writeFileSync('package.json',JSON.stringify(p,null,2))" \
    && rm -f bun.lock bun.lockb \
    && bun install --production

RUN mkdir -p /opt/openpalm/guardian /app/audit /app/secrets

ENV HOME=/opt/openpalm/guardian
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:8080/health || exit 1

CMD ["bun", "run", "src/server.ts"]
