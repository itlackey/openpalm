FROM oven/bun:1.3.5

RUN apt-get update && apt-get install -y tini curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Bun workspace symlinks are not available inside Docker builds, so we copy the
# raw TypeScript source of @openpalm/lib directly into node_modules.
# See packages/lib/README.md "Docker Build" for details.
COPY packages/lib /app/node_modules/@openpalm/lib
COPY gateway/package.json ./
COPY gateway/src ./src

# Opencode agent config (AGENTS.md, opencode.jsonc, skills) baked into the image.
COPY gateway/opencode/ /root/.config/opencode/

RUN bun install --production

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "bun", "run", "src/server.ts"]
