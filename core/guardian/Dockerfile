# ── Guardian Service ───────────────────────────────────────────────────────────
# Minimal Bun-based message guardian. Receives signed channel messages,
# validates HMAC + nonce + rate limits, forwards to the assistant.
# ──────────────────────────────────────────────────────────────────────────────

FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Bun workspace symlinks are not available inside Docker builds, so we copy the
# raw TypeScript source of @openpalm/lib directly into node_modules.
COPY packages/lib /app/node_modules/@openpalm/lib
COPY core/guardian/ .
# Strip workspace:* dep (pre-installed via COPY above) so bun install resolves remaining deps
RUN bun -e "import {readFileSync,writeFileSync} from 'node:fs';const p=JSON.parse(readFileSync('package.json','utf8'));delete p.dependencies['@openpalm/lib'];writeFileSync('package.json',JSON.stringify(p,null,2))"
RUN bun install --production

RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:8080/health || exit 1

CMD ["bun", "run", "src/server.ts"]
