# OpenPalm Memory UI — built from upstream mem0/openmemory source
#
# Multi-stage Next.js build mirroring the upstream Dockerfile but with
# paths adjusted for the monorepo build context (context: .).

# syntax=docker.io/docker/dockerfile:1

FROM node:18-alpine AS base
RUN apk add --no-cache libc6-compat curl && \
    corepack enable && \
    corepack prepare pnpm@latest --activate
WORKDIR /app

# ── Install dependencies ────────────────────────────────────────────
FROM base AS deps
COPY vendor/mem0/openmemory/ui/package.json vendor/mem0/openmemory/ui/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ── Build Next.js app ───────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY vendor/mem0/openmemory/ui/ .
RUN cp next.config.dev.mjs next.config.mjs
RUN cp .env.example .env
RUN pnpm build

# ── Production runner ───────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

COPY --chown=nextjs:nodejs vendor/mem0/openmemory/ui/entrypoint.sh /home/nextjs/entrypoint.sh
RUN chmod +x /home/nextjs/entrypoint.sh

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["/home/nextjs/entrypoint.sh"]
CMD ["node", "server.js"]
