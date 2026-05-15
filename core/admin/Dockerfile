# ── Admin Service ──────────────────────────────────────────────────────────────
# SvelteKit app serving the Operator Console UI + Admin API + Control Plane.
# Built with npm + Vite, runs on Node.js (adapter-node).
#
# Runtime stage inherits Bun, OpenCode, and akm-cli from openpalm-base.
# See core/base/Dockerfile for the single source of truth on those versions.
# ──────────────────────────────────────────────────────────────────────────────

FROM node:22-trixie-slim AS build
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

COPY packages/admin/ packages/admin/
COPY .openpalm/stack/ .openpalm/stack/
COPY .openpalm/config/ .openpalm/config/

WORKDIR /workspace/packages/admin
ENV PATH="/workspace/node_modules/.bin:$PATH"
RUN npm run build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM openpalm-base AS runtime

# Admin-specific OS additions: gnupg/pass for credential helpers; docker-cli +
# compose plugin for control-plane stack ops.
RUN apt-get update \
  && apt-get install -y --no-install-recommends gnupg pass \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

# Point Bun's user-writable paths at the node user's home for runtime
# `bun install -g` and the install cache. Bun itself was already installed
# into /usr/local by openpalm-base.
ENV BUN_INSTALL=/home/node/.bun
ENV BUN_INSTALL_CACHE_DIR=/home/node/.cache/bun/install
ENV PATH="/home/node/.bun/bin:/usr/local/bin:$PATH"

WORKDIR /app
COPY --from=build /workspace/packages/admin/build ./build
COPY --from=build /workspace/packages/admin/package.json ./
RUN node -e "\
  const fs = require('fs');\
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));\
  delete pkg.dependencies['@openpalm/lib'];\
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\\n');" \
  && npm install --omit=dev

RUN mkdir -p /state /data && chown node:node /state /data

# Bake admin OpenCode config into the image — seeded at runtime if overridden
COPY core/admin/opencode/opencode.jsonc /app/opencode.jsonc
COPY core/admin/opencode /etc/opencode

COPY core/admin/entrypoint.sh /usr/local/bin/admin-entrypoint.sh
RUN chmod +x /usr/local/bin/admin-entrypoint.sh

USER node

# Fallback for direct `docker run`; Compose overrides HOME to DATA_HOME/admin.
ENV HOME=/tmp
ENV PORT=8100
EXPOSE 8100 3881

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:8100/health || exit 1

CMD ["/usr/local/bin/admin-entrypoint.sh"]
