# ── Admin Service ──────────────────────────────────────────────────────────────
# SvelteKit app serving the Operator Console UI + Admin API + Control Plane.
# Built with npm + Vite, runs on Node.js (adapter-node).
# ──────────────────────────────────────────────────────────────────────────────

FROM node:lts-trixie-slim AS build
WORKDIR /workspace

# Install admin deps at workspace root so node_modules lands at /workspace/.
# Standard Node module resolution from packages/admin/ walks up to
# /workspace/node_modules/ — no symlinks, no workspace protocol.
COPY packages/admin/package.json .
RUN npm install

# Copy source into monorepo layout
COPY packages/admin/ packages/admin/
COPY assets/ assets/
COPY registry/ registry/

# Build SvelteKit (adapter-node produces self-contained build/)
WORKDIR /workspace/packages/admin
ENV PATH="/workspace/node_modules/.bin:$PATH"
RUN npm run build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:lts-trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates gnupg git unzip \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*


WORKDIR /app
COPY --from=build /workspace/packages/admin/build ./build
COPY --from=build /workspace/packages/admin/package.json ./
RUN npm install --omit=dev

RUN mkdir -p /state /data && chown node:node /state /data

# ── Pinned installer versions ────────────────────────────────────────────────
# Bump this ARG when upgrading; keeps curl|bash install reproducible.
ARG BUN_VERSION=bun-v1.3.10

# Install Bun to /usr/local so it's on PATH for all users
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s -- "$BUN_VERSION"
ENV PATH="/usr/local/bin:$PATH"

USER node

ENV PORT=8100
EXPOSE 8100

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:8100/health || exit 1

CMD ["node", "build/index.js"]
