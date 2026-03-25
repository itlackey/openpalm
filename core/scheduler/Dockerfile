# ── Scheduler Sidecar ──────────────────────────────────────────────────────────
# Lightweight Bun-based automation scheduler. Reads .yml automations from
# STATE_HOME/automations/ and runs them on cron schedules. No Docker socket.
# ──────────────────────────────────────────────────────────────────────────────

FROM debian:trixie-slim AS varlock-fetch
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN set -e; \
  if [ "$TARGETARCH" = "arm64" ]; then ARCH=arm64; SHA256=e830baaa901b6389ecf281bdd2449bfaf7586e91fd3a7a038ec06f78e6fa92f8; \
  else ARCH=x64; SHA256=820295b271cece2679b2b9701b5285ce39354fc2f35797365fa36c70125f51ab; fi \
  && curl -fsSL "https://github.com/dmno-dev/varlock/releases/download/varlock%400.4.0/varlock-linux-${ARCH}.tar.gz" -o /tmp/varlock.tar.gz \
  && echo "${SHA256}  /tmp/varlock.tar.gz" | sha256sum -c - \
  && tar xzf /tmp/varlock.tar.gz --strip-components=1 -C /usr/local/bin/ \
  && chmod +x /usr/local/bin/varlock && rm /tmp/varlock.tar.gz

FROM oven/bun:1.3-slim

LABEL org.opencontainers.image.name="openpalm/scheduler"

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy @openpalm/lib source directly into node_modules (same approach as guardian).
# Bun workspace symlinks are not available inside Docker builds.
COPY packages/lib /app/node_modules/@openpalm/lib

# Copy scheduler package
COPY packages/scheduler/package.json ./
COPY packages/scheduler/src/ src/

# Install @openpalm/lib's own dependencies so transitive imports resolve at runtime.
RUN cd /app/node_modules/@openpalm/lib && bun install --production

# Strip workspace:* dep (pre-installed via COPY above) and remove the workspace
# lockfile so bun install resolves remaining deps without frozen-lockfile enforcement.
RUN bun -e "import {readFileSync,writeFileSync} from 'node:fs';const p=JSON.parse(readFileSync('package.json','utf8'));delete p.dependencies['@openpalm/lib'];writeFileSync('package.json',JSON.stringify(p,null,2))" \
    && rm -f bun.lock bun.lockb \
    && bun install --production

COPY --from=varlock-fetch /usr/local/bin/varlock /usr/local/bin/varlock
COPY .openpalm/vault/redact.env.schema /app/.env.schema

RUN mkdir -p /app/automations /app/artifacts && chown -R bun:bun /app
USER bun

ENV PORT=8090
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:8090/health || exit 1

CMD ["varlock", "run", "--path", "/app/", "--", "bun", "run", "src/server.ts"]
