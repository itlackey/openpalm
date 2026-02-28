# ── Channel Chat Service ───────────────────────────────────────────────────────
# OpenAI/Anthropic-compatible API that translates chat requests into signed
# channel messages and forwards them to the guardian.
# ──────────────────────────────────────────────────────────────────────────────

FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Bun workspace symlinks are not available inside Docker builds, so we copy the
# raw TypeScript source of @openpalm/lib directly into node_modules.
COPY packages/lib /app/node_modules/@openpalm/lib
COPY channels/chat/package.json ./
COPY channels/chat/server.ts ./server.ts
# Strip workspace:* dep (pre-installed via COPY above) so bun install succeeds
RUN bun -e "import {readFileSync,writeFileSync} from 'node:fs';const p=JSON.parse(readFileSync('package.json','utf8'));delete p.dependencies['@openpalm/lib'];writeFileSync('package.json',JSON.stringify(p,null,2))"
RUN bun install --production

USER bun

ENV PORT=8181
EXPOSE 8181

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:8181/health || exit 1

CMD ["bun", "run", "server.ts"]
