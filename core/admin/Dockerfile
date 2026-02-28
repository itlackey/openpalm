# ── Admin Service ──────────────────────────────────────────────────────────────
# SvelteKit app serving the Operator Console UI + Admin API + Control Plane.
# Built with adapter-node, runs on Node.js.
# ──────────────────────────────────────────────────────────────────────────────

FROM node:22-slim AS build
WORKDIR /app
COPY core/admin/package.json core/admin/bun.lock* ./
RUN npm install
COPY core/admin/ .
COPY assets/ ../assets/
COPY registry/ ../registry/
# @openpalm/lib is resolved via vite alias: ../../packages/lib/src → /packages/lib/src
COPY packages/lib /packages/lib
RUN npm run build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:22-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./

RUN mkdir -p /state /data

ENV PORT=8100
EXPOSE 8100

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:8100/health || exit 1

CMD ["node", "build/index.js"]
