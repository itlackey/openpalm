FROM oven/bun:1.3.5

RUN apt-get update && apt-get install -y tini curl && rm -rf /var/lib/apt/lists/*

# Create non-root user for runtime (UID/GID match compose OPENPALM_UID/GID defaults).
# The oven/bun base image ships a "bun" user at 1000:1000 — rename it to openpalm
# so the user name is consistent across all OpenPalm containers.
RUN groupmod -n openpalm bun && \
    usermod -l openpalm -d /home/openpalm -m bun

WORKDIR /app
# Bun workspace symlinks are not available inside Docker builds, so we copy the
# raw TypeScript source of @openpalm/lib directly into node_modules.
# See packages/lib/README.md "Docker Build" for details.
COPY packages/lib /app/node_modules/@openpalm/lib
COPY core/gateway/package.json ./
COPY core/gateway/src ./src

# Opencode agent config (AGENTS.md, opencode.jsonc, skills) baked into the image.
COPY core/gateway/opencode/ /home/openpalm/.config/opencode/

RUN bun install --production

RUN chown -R openpalm:openpalm /app /home/openpalm

EXPOSE 8080
USER openpalm
ENTRYPOINT ["/usr/bin/tini", "--", "bun", "run", "src/server.ts"]
