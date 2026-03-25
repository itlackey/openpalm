# ── Guardian Service ───────────────────────────────────────────────────────────
# Minimal Bun-based message guardian. Receives signed channel messages,
# validates HMAC + nonce + rate limits, forwards to the assistant.
# ──────────────────────────────────────────────────────────────────────────────

FROM debian:trixie-slim AS varlock-fetch
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN set -e; \
  if [ "$TARGETARCH" = "arm64" ]; then ARCH=arm64; SHA256=e830baaa901b6389ecf281bdd2449bfaf7586e91fd3a7a038ec06f78e6fa92f8; \
  else ARCH=x64; SHA256=820295b271cece2679b2b9701b5285ce39354fc2f35797365fa36c70125f51ab; fi \
  && curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors "https://github.com/dmno-dev/varlock/releases/download/varlock%400.4.0/varlock-linux-${ARCH}.tar.gz" -o /tmp/varlock.tar.gz \
  && echo "${SHA256}  /tmp/varlock.tar.gz" | sha256sum -c - \
  && tar xzf /tmp/varlock.tar.gz --strip-components=1 -C /usr/local/bin/ \
  && chmod +x /usr/local/bin/varlock && rm /tmp/varlock.tar.gz

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

COPY --from=varlock-fetch /usr/local/bin/varlock /usr/local/bin/varlock
COPY .openpalm/vault/redact.env.schema /app/.env.schema

RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun

ENV HOME=/app/data
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:8080/health || exit 1

CMD ["varlock", "run", "--path", "/app/", "--", "bun", "run", "src/server.ts"]
