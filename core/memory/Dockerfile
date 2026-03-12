# OpenPalm Memory API — Bun.js wrapper around @openpalm/memory
#
# Build context must be the repo root (context: .) so compose.dev.yaml paths work.

# ── Varlock Fetch ─────────────────────────────────────────────────────────────
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

FROM oven/bun:1-debian

LABEL org.opencontainers.image.name="openpalm/memory"

WORKDIR /app

# Copy @openpalm/memory source directly into node_modules (same approach as guardian).
# Bun workspace symlinks are not available inside Docker builds.
COPY packages/memory /app/node_modules/@openpalm/memory

# Copy server package
COPY core/memory/package.json ./
COPY core/memory/src/ src/

# Install @openpalm/memory's own dependencies so transitive imports resolve at runtime.
RUN cd /app/node_modules/@openpalm/memory && bun install --production

# Strip workspace:* dep (pre-installed via COPY above) and remove the workspace
# lockfile so bun install resolves remaining deps without frozen-lockfile enforcement.
RUN bun -e "import {readFileSync,writeFileSync} from 'node:fs';const p=JSON.parse(readFileSync('package.json','utf8'));delete p.dependencies['@openpalm/memory'];writeFileSync('package.json',JSON.stringify(p,null,2))" \
    && rm -f bun.lock bun.lockb \
    && bun install --production

COPY --from=varlock-fetch /usr/local/bin/varlock /usr/local/bin/varlock
COPY assets/redact.env.schema /app/.env.schema

RUN chown -R bun:bun /app

USER bun

EXPOSE 8765
CMD ["varlock", "run", "--path", "/app/", "--", "bun", "run", "src/server.ts"]
