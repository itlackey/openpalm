# ── Guardian Service ───────────────────────────────────────────────────────────
# Minimal Bun-based message guardian. Receives signed channel messages,
# validates HMAC + nonce + rate limits, forwards to the assistant.
# ──────────────────────────────────────────────────────────────────────────────

FROM oven/bun:1.3-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

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

# Copy varlock binary from shared build image (see .docker/varlock.Dockerfile).
# Compose injects the image via additional_contexts: varlock=docker-image://...
COPY --from=varlock /usr/local/bin/varlock /usr/local/bin/varlock
COPY .openpalm/vault/redact.env.schema /app/.env.schema

RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun

ENV HOME=/app/data
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:8080/health || exit 1

CMD ["varlock", "run", "--path", "/app/", "--", "bun", "run", "src/server.ts"]
