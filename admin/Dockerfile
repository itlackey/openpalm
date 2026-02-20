FROM oven/bun:1.1.42 AS builder
WORKDIR /build

# Install dependencies (workspace needs lib package for @openpalm/lib)
COPY ui/package.json ./ui/package.json
COPY ui/bun.lockb* ./ui/
RUN cd ui && (bun install --frozen-lockfile 2>/dev/null || bun install)

# Copy shared lib (needed for @openpalm/lib imports in server routes)
COPY ../packages/lib /build/packages/lib

# Copy UI source and build (adapter-node outputs to build/)
COPY ui/ ./ui/
RUN cd ui && bun run build

FROM oven/bun:1.1.42
WORKDIR /app
COPY --from=builder /build/ui/build ./build
COPY --from=builder /build/ui/entry.js ./entry.js
COPY --from=builder /build/ui/package.json ./package.json
COPY --from=builder /build/ui/node_modules ./node_modules
EXPOSE 8100
ENV PORT=8100
CMD ["bun", "run", "entry.js"]
