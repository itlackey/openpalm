FROM oven/bun:1.3.9
WORKDIR /app
# Bun workspace symlinks are not available inside Docker builds, so we copy the
# raw TypeScript source of @openpalm/lib directly into node_modules.
# See packages/lib/README.md "Docker Build" for details.
COPY packages/lib /app/node_modules/@openpalm/lib
COPY channels/discord/package.json ./
COPY channels/discord/server.ts ./server.ts
# Strip workspace:* dep (pre-installed via COPY above) so bun install succeeds
RUN bun -e "import {readFileSync,writeFileSync} from 'node:fs';const p=JSON.parse(readFileSync('package.json','utf8'));delete p.dependencies['@openpalm/lib'];writeFileSync('package.json',JSON.stringify(p,null,2))"
RUN bun install --production

USER bun

ENV PORT=8184
EXPOSE 8184

CMD ["bun", "run", "server.ts"]
