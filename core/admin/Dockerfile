# ── Admin Service ──────────────────────────────────────────────────────────────
# SvelteKit app serving the Operator Console UI + Admin API + Control Plane.
# Built with npm + Vite, runs on Node.js (adapter-node).
# ──────────────────────────────────────────────────────────────────────────────

FROM node:lts-trixie-slim AS build
WORKDIR /workspace

# Install admin deps at workspace root so node_modules lands at /workspace/.
# Standard Node module resolution from packages/admin/ walks up to
# /workspace/node_modules/ — no symlinks, no workspace protocol.
# Strip workspace:* refs before install (lib is copied manually below).
COPY packages/admin/package.json .
RUN node -e "\
  const fs = require('fs');\
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));\
  delete pkg.dependencies['@openpalm/lib'];\
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\\n');" \
  && npm install

# Copy @openpalm/lib source into node_modules (private package, not on npm).
# Lib's deps (croner, yaml, dotenv) are already installed by admin above.
COPY packages/lib/ node_modules/@openpalm/lib/

# Copy source into monorepo layout
COPY packages/admin/ packages/admin/
COPY assets/ assets/
COPY registry/ registry/ registry/

# Build SvelteKit (adapter-node produces self-contained build/)
WORKDIR /workspace/packages/admin
ENV PATH="/workspace/node_modules/.bin:$PATH"
RUN npm run build

# ── Varlock Fetch ─────────────────────────────────────────────────────────────
# Isolated stage so the download layer is cached independently of the app build.
# Pinned version; bump ARG to upgrade. Uses --retry-all-errors to handle
# transient GitHub CDN failures (502/503).
FROM debian:trixie-slim AS varlock-fetch
ARG TARGETARCH
ARG VARLOCK_VERSION=0.4.0
ARG VARLOCK_SHA256_AMD64=820295b271cece2679b2b9701b5285ce39354fc2f35797365fa36c70125f51ab
ARG VARLOCK_SHA256_ARM64=e830baaa901b6389ecf281bdd2449bfaf7586e91fd3a7a038ec06f78e6fa92f8
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN set -e; \
  if [ "$TARGETARCH" = "arm64" ]; then \
    VARLOCK_ARCH=arm64; VARLOCK_SHA256="$VARLOCK_SHA256_ARM64"; \
  else \
    VARLOCK_ARCH=x64; VARLOCK_SHA256="$VARLOCK_SHA256_AMD64"; \
  fi \
  && curl -fsSL \
       --retry 5 --retry-delay 10 --retry-all-errors \
       "https://github.com/dmno-dev/varlock/releases/download/varlock%40${VARLOCK_VERSION}/varlock-linux-${VARLOCK_ARCH}.tar.gz" \
       -o /tmp/varlock.tar.gz \
  && echo "${VARLOCK_SHA256}  /tmp/varlock.tar.gz" | sha256sum -c - \
  && tar xzf /tmp/varlock.tar.gz --strip-components=1 -C /usr/local/bin/ \
  && chmod +x /usr/local/bin/varlock \
  && rm /tmp/varlock.tar.gz

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:lts-trixie-slim

# ── Pinned installer versions ────────────────────────────────────────────────
ARG OPENCODE_VERSION=1.2.24
ARG BUN_VERSION=bun-v1.3.10

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates gnupg git unzip bash pass \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

# Install OpenCode (admin runs its own instance with admin-tools plugin)
RUN HOME=/usr/local curl -fsSL https://opencode.ai/install | HOME=/usr/local bash -s -- --no-modify-path --version "$OPENCODE_VERSION"
ENV PATH="/usr/local/.opencode/bin:$PATH"

# Install Bun (required for OpenCode plugins)
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s -- "$BUN_VERSION"
ENV BUN_INSTALL=/tmp/.bun
ENV BUN_INSTALL_CACHE_DIR=/tmp/.cache/bun/install
ENV PATH="/tmp/.bun/bin:/usr/local/bin:$PATH"

WORKDIR /app
COPY --from=build /workspace/packages/admin/build ./build
COPY --from=build /workspace/packages/admin/package.json ./
# Strip workspace:* refs — lib is bundled into build output by Vite
RUN node -e "\
  const fs = require('fs');\
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));\
  delete pkg.dependencies['@openpalm/lib'];\
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\\n');" \
  && npm install --omit=dev

RUN mkdir -p /state /data && chown node:node /state /data

# Copy varlock binary from fetch stage — no Bun required (standalone ELF binary)
COPY --from=varlock-fetch /usr/local/bin/varlock /usr/local/bin/varlock
COPY assets/redact.env.schema /app/.env.schema

# Admin entrypoint — starts SvelteKit + OpenCode
COPY core/admin/entrypoint.sh /usr/local/bin/admin-entrypoint.sh
RUN chmod +x /usr/local/bin/admin-entrypoint.sh

USER node

# Fallback for direct `docker run`; Compose overrides HOME to DATA_HOME/admin
# so varlock writes into a user-writable bind mount at runtime.
ENV HOME=/tmp
ENV PORT=8100
EXPOSE 8100 4097

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:8100/health || exit 1

CMD ["/usr/local/bin/admin-entrypoint.sh"]
