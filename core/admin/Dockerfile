# ── Admin Service ──────────────────────────────────────────────────────────────
# SvelteKit app serving the Operator Console UI + Admin API + Control Plane.
# Built with npm + Vite, runs on Node.js (adapter-node).
# ──────────────────────────────────────────────────────────────────────────────

FROM node:22-slim AS build
WORKDIR /workspace

# Install admin deps at workspace root so node_modules lands at /workspace/.
# Standard Node module resolution from both core/admin/ and packages/lib/
# walks up to /workspace/node_modules/ — no symlinks, no workspace protocol.
COPY core/admin/package.json .
RUN npm install

# Copy source into monorepo layout matching Vite alias paths
COPY core/admin/ core/admin/
COPY packages/lib/ packages/lib/
COPY assets/ assets/
COPY registry/ registry/

# Build SvelteKit (adapter-node produces self-contained build/)
WORKDIR /workspace/core/admin
ENV PATH="/workspace/node_modules/.bin:$PATH"
RUN npm run build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:22-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates gnupg gosu \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /workspace/core/admin/build ./build
COPY --from=build /workspace/core/admin/package.json ./
COPY core/admin/docker-entrypoint.sh /usr/local/bin/

RUN mkdir -p /state /data

ENV PORT=8100
EXPOSE 8100

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:8100/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "build/index.js"]
