# OpenPalm Memory API — Bun.js wrapper around @openpalm/memory
#
# Build context must be the repo root (context: .) so compose.dev.yaml paths work.

FROM oven/bun:1.3-debian

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

# Copy varlock binary from shared build image (see .docker/varlock.Dockerfile).
# Compose injects the image via additional_contexts: varlock=docker-image://...
COPY --from=varlock /usr/local/bin/varlock /usr/local/bin/varlock
COPY .openpalm/vault/redact.env.schema /app/.env.schema

RUN mkdir -p /home/bun \
    && chown -R bun:bun /app /home/bun

USER bun

ENV HOME=/home/bun
EXPOSE 8765
CMD ["varlock", "run", "--path", "/app/", "--", "bun", "run", "src/server.ts"]
